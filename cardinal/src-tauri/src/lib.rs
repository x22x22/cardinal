mod background;
mod commands;
mod lifecycle;
mod logging;
mod multi_cache;
use multi_cache::{GlobalIndex, MultiCache};
mod quicklook;
mod search_activity;
mod sort;
mod window_controls;

use anyhow::{Context, Result};
use background::{
    BackgroundLoopChannels, IconPayload, build_search_cache, emit_status_bar_update,
    run_background_event_loop,
};
use cardinal_sdk::EventWatcher;
use commands::{
    normalize_watch_roots,
    NodeInfoRequest, SearchJob, SearchState, WatchConfigUpdate, activate_main_window,
    close_quicklook, copy_files_to_clipboard, get_app_status, get_nodes_info, get_sorted_view,
    hide_main_window, normalize_watch_config, open_in_finder, open_path, search,
    set_tray_activation_policy, set_watch_config, start_logic, toggle_main_window,
    toggle_quicklook, trigger_rescan, update_icon_viewport, update_quicklook,
};
use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, bounded, unbounded};
use lifecycle::{
    APP_QUIT, AppLifecycleState, EXIT_REQUESTED, emit_app_state, load_app_state, update_app_state,
};
use once_cell::sync::OnceCell;
use search_cache::SearchCache;
use search_cancel::CancellationToken;
use std::{
    path::{Path, PathBuf},
    sync::{Once, atomic::Ordering},
    time::Duration,
};
use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use tracing::{error, info, warn};
use window_controls::{activate_window, hide_window};

static DB_PATH: OnceCell<PathBuf> = OnceCell::new();
pub(crate) static LOGIC_START: OnceCell<Sender<LogicStartConfig>> = OnceCell::new();
pub(crate) const DEFAULT_SYSTEM_IGNORE_PATH: &str = "/System/Volumes/Data";
const FSE_LATENCY_SECS: f64 = 0.1;

#[derive(Debug, Clone)]
pub(crate) struct LogicStartConfig {
    /// 多根列表（有序即优先级）。为空时回退到 `watch_root` 单根。
    pub watch_roots: Vec<String>,
    pub watch_root: String,
    pub ignore_paths: Vec<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() -> Result<()> {
    // 日志必须落盘：macOS 上双击 .app 启动时 stdout/stderr 会被丢弃，
    // 没有文件日志就无法排查 CPU 飙高、搜索卡死这类线上问题。
    let log_path = logging::init();
    if let Some(path) = &log_path {
        info!(log_file = %path.display(), "日志文件就绪");
    }

    let (finish_tx, finish_rx) = bounded::<Sender<Option<MultiCache>>>(1);
    let (search_tx, search_rx) = unbounded::<SearchJob>();
    let (node_info_tx, node_info_rx) = unbounded::<NodeInfoRequest>();
    let (icon_viewport_tx, icon_viewport_rx) = unbounded::<(u64, Vec<GlobalIndex>)>();
    let (rescan_tx, rescan_rx) = unbounded::<CancellationToken>();
    let (watch_config_tx, watch_config_rx) = unbounded::<WatchConfigUpdate>();
    let (icon_update_tx, icon_update_rx) = unbounded::<IconPayload>();
    let (update_window_state_tx, update_window_state_rx) = bounded::<()>(1);
    let (logic_start_tx, logic_start_rx) = bounded(1);
    LOGIC_START
        .set(logic_start_tx)
        .expect("LOGIC_START channel already initialized");

    let mut builder = tauri::Builder::default();
    #[cfg(not(feature = "dev"))]
    {
        builder = builder.plugin(tauri_plugin_prevent_default::init());
    }
    let update_window_state_tx_for_window = update_window_state_tx.clone();
    builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .on_window_event(move |window, event| {
            if window.label() != "main" {
                return;
            }

            match event {
                WindowEvent::Focused(_) => {
                    let _ = update_window_state_tx_for_window.try_send(());
                }
                WindowEvent::CloseRequested { api, .. } => {
                    if EXIT_REQUESTED.load(Ordering::Relaxed) {
                        return;
                    }

                    api.prevent_close();

                    let Some(window) = window.get_webview_window("main") else {
                        warn!("Close requested but main window is unavailable");
                        return;
                    };

                    if hide_window(&window) {
                        let _ = update_window_state_tx_for_window.try_send(());
                        info!("Main window hidden; Cardinal keeps running in the background");
                    }
                }
                _ => {}
            }
        });

    let app = builder
        .manage(SearchState::new(
            search_tx,
            node_info_tx,
            icon_viewport_tx.clone(),
            rescan_tx.clone(),
            watch_config_tx.clone(),
            update_window_state_tx.clone(),
        ))
        .invoke_handler(tauri::generate_handler![
            search,
            get_nodes_info,
            get_sorted_view,
            update_icon_viewport,
            get_app_status,
            trigger_rescan,
            set_watch_config,
            open_in_finder,
            open_path,
            toggle_quicklook,
            close_quicklook,
            update_quicklook,
            start_logic,
            log_frontend_error,
            hide_main_window,
            activate_main_window,
            toggle_main_window,
            set_tray_activation_policy,
            copy_files_to_clipboard,
        ])
        .on_page_load(|_webview, payload| {
            info!(
                url = %payload.url(),
                event = ?payload.event(),
                "webview 页面加载事件"
            );
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    let db_path = DB_PATH
        .get_or_try_init(|| app.path().app_config_dir().map(|p| p.join("cardinal.db")))
        .expect("Failed to initialize database path");

    let app_handle = &app.handle().to_owned();
    let channels = BackgroundLoopChannels {
        finish_rx,
        search_rx,
        node_info_rx,
        icon_viewport_rx,
        rescan_rx,
        watch_config_rx,
        icon_update_tx,
        update_window_state_rx,
    };
    emit_app_state(app_handle);
    let icon_update_rx = &icon_update_rx;
    std::thread::scope(move |s| {
        s.spawn(|| {
            while let Ok(icon) = icon_update_rx.recv() {
                let mut icons = vec![icon];
                std::thread::sleep(Duration::from_millis(100));
                icons.extend(icon_update_rx.try_iter());
                info!("emitting {} icons", icons.len());
                app_handle.emit("icon_update", icons).unwrap();
            }
            info!("icon update thread exited");
        });

        let logic_start_rx = logic_start_rx;
        s.spawn(move || {
            let Some(config) = wait_for_logic_start(logic_start_rx) else {
                info!("Background thread quitting without Full Disk Access");
                return;
            };

            run_logic_thread(app_handle, db_path, channels, config);
        });

        app.run(move |app_handle, event| match event {
            RunEvent::Exit => {
                APP_QUIT.store(true, Ordering::Relaxed);
                flush_cache_to_file_once(&finish_tx, db_path);
            }
            RunEvent::ExitRequested { api, code, .. } => {
                let already_requested = EXIT_REQUESTED.swap(true, Ordering::Relaxed);
                APP_QUIT.store(true, Ordering::Relaxed);
                if !already_requested {
                    info!(
                        "Exit requested (code: {:?}); flushing cache before shutdown",
                        code
                    );
                }

                flush_cache_to_file_once(&finish_tx, db_path);

                if code.is_none() {
                    api.prevent_exit();
                    app_handle.exit(0);
                }
            }
            RunEvent::Reopen { .. } => {
                // On macOS, clicking the Dock icon should bring the main window back even if the
                // app still "has windows" but they are hidden.
                if let Some(window) = app_handle.get_webview_window("main") {
                    activate_window(&window);
                } else {
                    warn!("Reopen requested but main window is unavailable");
                }
            }
            _ => {}
        });
    });

    Ok(())
}

fn run_logic_thread(
    app_handle: &tauri::AppHandle,
    db_path: &Path,
    channels: BackgroundLoopChannels,
    config: LogicStartConfig,
) {
    let watch_roots = normalize_watch_roots(&config.watch_roots, Some(&config.watch_root));
    let Some((watch_root, ignore_paths)) =
        normalize_watch_config(&watch_roots.join("\n"), config.ignore_paths, Some("/"))
    else {
        warn!("Invalid watch root in start config; skipping background startup");
        return;
    };
    let _ = watch_root;
    let watch_roots_paths: Vec<PathBuf> = watch_roots.iter().map(PathBuf::from).collect();
    let watch_root = common_ancestor(&watch_roots_paths);
    let path = PathBuf::from(&watch_root);
    let ignore_paths: Vec<_> = ignore_paths.into_iter().map(PathBuf::from).collect();

    let load_started = std::time::Instant::now();
    // 读取 300MB+ 索引库要十几秒（本机 1400 万节点实测 17.6s）。
    // 期间同样要接着响应搜索，否则冷启动第一波搜索会全部排队到加载结束。
    let loaded = load_search_cache_while_serving_searches(
        &watch_roots_paths,
        db_path,
        &ignore_paths,
        &channels.search_rx,
    );
    let mut cache = match loaded {
        Ok(cached) => {
            info!(
                elapsed_ms = load_started.elapsed().as_millis() as u64,
                nodes = cached.get_total_files(),
                "已加载持久化索引"
            );
            emit_status_bar_update(app_handle, cached.get_total_files(), 0, 0);
            cached
        }
        Err(e) => {
            info!(error = %e, "索引加载失败，开始全盘构建");
            // 全盘 walk 可能持续数分钟（本机实测 1400 万节点）。期间必须继续
            // 消费 search 通道并立刻回「索引建立中」，否则前端会永久停在
            // 「正在搜索…」而没有任何可恢复的提示。
            let walked = build_search_cache_while_serving_searches(
                app_handle,
                &watch_roots_paths,
                &ignore_paths,
                &channels.search_rx,
            );
            if let Some(cache) = walked {
                emit_status_bar_update(app_handle, cache.get_total_files(), 0, 0);
                cache
            } else if APP_QUIT.load(Ordering::Relaxed) {
                info!("Walk filesystem cancelled, app quitting");
                channels
                    .finish_rx
                    .recv()
                    .expect("Failed to receive finish signal")
                    .send(None)
                    .expect("Failed to send None cache");
                return;
            } else {
                info!("Initial scan cancelled by newer request, use noop cache");
                MultiCache::new(vec![multi_cache::CacheSlot {
                    root: path.clone(),
                    cache: SearchCache::noop(path.clone(), ignore_paths.clone(), &APP_QUIT),
                }])
            }
        }
    };

    let event_watcher = if cache.is_noop() {
        info!("Using noop event watcher due to cancelled initial scan");
        EventWatcher::noop()
    } else {
        update_app_state(app_handle, AppLifecycleState::Updating);
        EventWatcher::spawn(
            watch_root.to_string(),
            cache.last_event_id(),
            FSE_LATENCY_SECS,
            cache.ignore_paths(),
        )
        .1
    };

    info!("Started background processing thread");
    // TODO(ldm0): remove this watch_root, use cache's path instead
    run_background_event_loop(
        app_handle,
        cache,
        event_watcher,
        channels,
        watch_root.to_string(),
        FSE_LATENCY_SECS,
        db_path.to_path_buf(),
    );

    info!("Background thread exited");
}

fn flush_cache_to_file_once(finish_tx: &Sender<Sender<Option<MultiCache>>>, db_path: &PathBuf) {
    static FLUSH_ONCE: Once = Once::new();
    if load_app_state() != AppLifecycleState::Ready {
        info!("App not fully initialized, skipping cache flush");
        return;
    }
    FLUSH_ONCE.call_once(move || {
        let (cache_tx, cache_rx) = bounded::<Option<MultiCache>>(1);
        finish_tx
            .send(cache_tx)
            .context("cache_tx is closed")
            .unwrap();
        if let Some(mut cache) = cache_rx.recv().context("cache_tx is closed").unwrap() {
            cache
                .flush_snapshot_to_file(db_path)
                .context("Failed to write cache to file")
                .unwrap();

            info!("Cache flushed successfully to {:?}", db_path);
        } else {
            info!("Cancelled before data constructed, no cache to flush");
        }
    });
}

fn wait_for_logic_start(rx: Receiver<LogicStartConfig>) -> Option<LogicStartConfig> {
    info!("Waiting for Full Disk Access signal from the frontend");
    loop {
        if APP_QUIT.load(Ordering::Relaxed) {
            return None;
        }

        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(config) => {
                info!(
                    "Received Full Disk Access grant, starting background processing (watch_roots={:?}, watch_root={}, ignore_paths={})",
                    config.watch_roots,
                    config.watch_root,
                    config.ignore_paths.len()
                );
                return Some(config);
            }
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                warn!("Full Disk Access channel disconnected before grant");
                return None;
            }
        }
    }
}

/// 在后台线程构建索引，同时保持对搜索请求的响应。
///
/// 构建期间任何搜索请求都会立即收到 `index_building` 错误而不是挂起等待，
/// 前端据此展示「索引建立中」提示，用户可以稍后重试。
/// 依次加载每个根的持久化索引。
///
/// 单根沿用 `cardinal.db`；多根按根路径哈希成独立文件。任一根本地索引缺失或
/// 损坏就整体报错，由调用方退回全量构建——半新半旧的索引比重建更危险。
fn load_multi_cache(
    watch_roots: &[PathBuf],
    db_path: &Path,
    ignore_paths: &[PathBuf],
) -> Result<MultiCache, String> {
    let dir = db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| db_path.to_path_buf());
    let mut slots = Vec::with_capacity(watch_roots.len());

    for root in watch_roots {
        let db = if watch_roots.len() == 1 {
            db_path.to_path_buf()
        } else {
            MultiCache::db_path_for(&dir, root)
        };
        let cache = SearchCache::try_read_persistent_cache(root, &db, &ignore_paths.to_vec(), &APP_QUIT)
            .map_err(|error| format!("{error:?}"))?;
        info!(
            root = %root.display(),
            nodes = cache.get_total_files(),
            db = %db.display(),
            "已加载该根的索引"
        );
        slots.push(multi_cache::CacheSlot {
            root: root.clone(),
            cache,
        });
    }

    if slots.is_empty() {
        return Err("no_watch_roots".to_string());
    }
    Ok(MultiCache::new(slots))
}

/// 多根共用的监听祖先：FSEvents 只挂一个 watcher，事件再按根分发。
pub(crate) fn common_ancestor(roots: &[PathBuf]) -> String {
    let Some(first) = roots.first() else {
        return "/".to_string();
    };
    let mut common = first.clone();
    for root in &roots[1..] {
        while !root.starts_with(&common) {
            if !common.pop() {
                break;
            }
        }
    }
    let text = common.to_string_lossy().into_owned();
    if text.is_empty() {
        "/".to_string()
    } else {
        text
    }
}

fn build_search_cache_while_serving_searches(
    app_handle: &tauri::AppHandle,
    watch_roots: &[PathBuf],
    ignore_paths: &[PathBuf],
    search_rx: &Receiver<SearchJob>,
) -> Option<MultiCache> {
    let (done_tx, done_rx) = bounded::<Option<MultiCache>>(1);
    let handle = app_handle.clone();
    let roots = watch_roots.to_vec();
    let ignores = ignore_paths.to_vec();
    let spawned = std::thread::Builder::new()
        .name("cardinal-cache-walk".to_string())
        .spawn(move || {
            let cache = build_search_cache(&handle, &roots, &ignores, CancellationToken::new_scan());
            let _ = done_tx.send(cache);
        });
    if let Err(error) = spawned {
        error!(?error, "无法启动索引构建线程，退回同步构建");
        return build_search_cache(
            app_handle,
            watch_roots,
            ignore_paths,
            CancellationToken::new_scan(),
        );
    }

    let mut building_errors = 0u64;
    loop {
        crossbeam_channel::select! {
            recv(done_rx) -> result => {
                return result.ok().flatten();
            }
            recv(search_rx) -> job => {
                let Ok(job) = job else {
                    continue;
                };
                building_errors += 1;
                if building_errors == 1 || building_errors.is_multiple_of(16) {
                    info!(
                        count = building_errors,
                        "索引构建中，搜索请求立即回复 index_building（避免前端无限等待）"
                    );
                }
                let _ = job.reply.send(Err(anyhow::anyhow!("index_building")));
            }
        }
    }
}

/// 在后台线程读取持久化索引，同时保持对搜索请求的响应。
///
/// 大索引（本机 321MB / 1400 万节点）加载需要十几秒；这段时间若把搜索请求
/// 晾在通道里，前端就会表现为「一直在搜索」。
fn load_search_cache_while_serving_searches(
    watch_roots: &[PathBuf],
    db_path: &Path,
    ignore_paths: &[PathBuf],
    search_rx: &Receiver<SearchJob>,
) -> Result<MultiCache, String> {
    let (done_tx, done_rx) = bounded::<Result<MultiCache, String>>(1);
    let owned_roots = watch_roots.to_vec();
    let owned_db = db_path.to_path_buf();
    let owned_ignores = ignore_paths.to_vec();
    let spawned = std::thread::Builder::new()
        .name("cardinal-cache-load".to_string())
        .spawn(move || {
            let _ = done_tx.send(load_multi_cache(&owned_roots, &owned_db, &owned_ignores));
        });
    if let Err(error) = spawned {
        warn!(?error, "无法启动索引加载线程，退回同步加载");
        return load_multi_cache(watch_roots, db_path, ignore_paths);
    }

    let mut building_errors = 0u64;
    loop {
        crossbeam_channel::select! {
            recv(done_rx) -> result => {
                return match result {
                    Ok(loaded) => loaded,
                    Err(_) => Err("cache_loader_gone".to_string()),
                };
            }
            recv(search_rx) -> job => {
                let Ok(job) = job else {
                    continue;
                };
                building_errors += 1;
                if building_errors == 1 || building_errors.is_multiple_of(16) {
                    info!(
                        count = building_errors,
                        "索引加载中，搜索请求立即回复 index_building"
                    );
                }
                let _ = job.reply.send(Err(anyhow::anyhow!("index_building")));
            }
        }
    }
}

/// 前端把启动期/运行期异常写进后端日志。
///
/// 未启用 devtools 的 release 包里，前端异常只能看到白屏；
/// 有了这个命令，白屏原因会落到 cardinal.log，便于直接定位。
#[tauri::command]
fn log_frontend_error(message: String) {
    error!(target: "cardinal::frontend", "{message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_ancestor_of_multiple_roots() {
        let roots = vec![
            PathBuf::from("/Users/kdump/llm/project/sunline/ais"),
            PathBuf::from("/Users/kdump/project"),
            PathBuf::from("/Users/kdump/llm/project"),
            PathBuf::from("/Users/kdump/Documents"),
        ];
        assert_eq!(common_ancestor(&roots), "/Users/kdump");
    }

    #[test]
    fn common_ancestor_of_single_root_is_itself() {
        let roots = vec![PathBuf::from("/Users/kdump/project")];
        assert_eq!(common_ancestor(&roots), "/Users/kdump/project");
    }

    #[test]
    fn common_ancestor_falls_back_to_root() {
        let roots = vec![PathBuf::from("/Users"), PathBuf::from("/Volumes/data")];
        assert_eq!(common_ancestor(&roots), "/");
    }
}
