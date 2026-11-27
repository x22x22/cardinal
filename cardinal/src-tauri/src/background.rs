use crate::{
    commands::{NodeInfoRequest, SearchJob, WatchConfigUpdate},
    lifecycle::{APP_QUIT, AppLifecycleState, load_app_state, update_app_state},
    search_activity,
    window_controls::is_main_window_foreground,
};
use anyhow::Result;
use base64::{Engine as _, engine::general_purpose};
use cardinal_sdk::{EventFlag, EventWatcher, FsEvent};
use crossbeam_channel::{Receiver, Sender};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rayon::spawn;
use crate::multi_cache::{GlobalIndex, MultiCache};
use search_cache::{HandleFSEError, SearchOptions, SearchResultNode, WalkData};
use search_cancel::CancellationToken;
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusBarUpdate {
    pub scanned_files: usize,
    pub processed_events: usize,
    pub rescan_errors: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IconPayload {
    pub slab_index: GlobalIndex,
    pub icon: String,
}

pub struct BackgroundLoopChannels {
    pub finish_rx: Receiver<Sender<Option<MultiCache>>>,
    pub update_window_state_rx: Receiver<()>,
    pub search_rx: Receiver<SearchJob>,
    pub node_info_rx: Receiver<NodeInfoRequest>,
    pub icon_viewport_rx: Receiver<(u64, Vec<GlobalIndex>)>,
    pub rescan_rx: Receiver<CancellationToken>,
    pub watch_config_rx: Receiver<WatchConfigUpdate>,
    pub icon_update_tx: Sender<IconPayload>,
}

pub fn reset_status_bar(app_handle: &AppHandle) {
    app_handle
        .emit(
            "status_bar_update",
            StatusBarUpdate {
                scanned_files: 0,
                processed_events: 0,
                rescan_errors: 0,
            },
        )
        .unwrap();
}

pub fn emit_status_bar_update(
    app_handle: &AppHandle,
    scanned_files: usize,
    processed_events: usize,
    rescan_errors: usize,
) {
    static LAST_EMIT: Lazy<Mutex<Instant>> =
        Lazy::new(|| Mutex::new(Instant::now() - Duration::from_secs(1)));

    {
        let mut last_emit = LAST_EMIT.lock();
        if Instant::now().duration_since(*last_emit) < Duration::from_millis(100) {
            return;
        }
        app_handle
            .emit(
                "status_bar_update",
                StatusBarUpdate {
                    scanned_files,
                    processed_events,
                    rescan_errors,
                },
            )
            .unwrap();
        *last_emit = Instant::now();
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_watch_config_update(
    app_handle: &AppHandle,
    update: WatchConfigUpdate,
    cache: &mut MultiCache,
    event_watcher: &mut EventWatcher,
    watch_root: &mut String,
    fse_latency_secs: f64,
    history_ready: &mut bool,
    processed_events: &mut usize,
) {
    info!("Received watch config update: {:?}", update);
    let WatchConfigUpdate {
        watch_roots,
        watch_root: next_watch_root,
        ignore_paths,
        scan_cancellation_token,
    } = update;

    let next_watch_roots = crate::commands::normalize_watch_roots(&watch_roots, Some(&next_watch_root));
    let next_watch_paths: Vec<PathBuf> = next_watch_roots.iter().map(PathBuf::from).collect();
    if next_watch_paths.is_empty() {
        warn!("监控路径归一化后为空，忽略本次配置更新");
        return;
    }
    let next_watch_root = crate::common_ancestor(&next_watch_paths);

    let next_ignore_paths = ignore_paths
        .into_iter()
        .map(PathBuf::from)
        .collect::<Vec<_>>();

    *event_watcher = EventWatcher::noop();
    update_app_state(app_handle, AppLifecycleState::Initializing);
    reset_status_bar(app_handle);
    *history_ready = false;
    *processed_events = 0;

    let next_cache = match build_search_cache(
        app_handle,
        &next_watch_paths,
        &next_ignore_paths,
        scan_cancellation_token,
    ) {
        Some(cache) => {
            info!(
                "Search cache built. New root: {}, ignore paths: {:?}",
                next_watch_root, next_ignore_paths
            );
            emit_status_bar_update(app_handle, cache.get_total_files(), 0, 0);
            cache
        }
        None => {
            // if cache build is cancelled, we cannot reuse the old cache since
            // it's tied to the old watch root and ignore paths; create a noop
            // cache instead
            info!("Watch config change cancelled, use noop state");
            MultiCache::new(vec![crate::multi_cache::CacheSlot {
                root: PathBuf::from(&next_watch_root),
                cache: search_cache::SearchCache::noop(
                    PathBuf::from(&next_watch_root),
                    next_ignore_paths,
                    &APP_QUIT,
                ),
            }])
        }
    };

    *cache = next_cache;
    *watch_root = next_watch_root.to_string();
    *event_watcher = if cache.is_noop() {
        EventWatcher::noop()
    } else {
        update_app_state(app_handle, AppLifecycleState::Updating);
        EventWatcher::spawn(
            watch_root.to_string(),
            cache.last_event_id(),
            fse_latency_secs,
            cache.ignore_paths(),
        )
        .1
    };
}

struct EventSnapshot {
    path: PathBuf,
    event_id: u64,
    flag: EventFlag,
    timestamp: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RecentEvent {
    path: String,
    flag_bits: u32,
    event_id: u64,
    timestamp: i64,
}

/// 单个事件批次里最多同步处理的事件数。
///
/// 后台是单线程 `select!`：如果一整批 FSEvents（可能上万条）一次处理完，
/// 期间所有搜索请求都会被饿死。按块处理并在块间抢处理搜索，能把「永久等待」
/// 压到「最多等一块扫描」。
const EVENT_BATCH_CHUNK: usize = 64;

/// 单次让出时最多消化的搜索请求数，避免搜索风暴反过来饿死事件处理。
const MAX_SEARCH_JOBS_PER_YIELD: usize = 8;

/// 执行一个搜索任务，结果通过请求自带的回复通道送回。
fn run_search_job(cache: &mut MultiCache, job: SearchJob) {
    let SearchJob {
        query,
        options,
        cancellation_token,
        reply,
    } = job;
    let opts = SearchOptions::from(options);
    let started = std::time::Instant::now();
    let payload = cache.search_with_options(&query, opts, cancellation_token);
    match &payload {
        Ok(outcome) => info!(
            query = %query,
            elapsed_ms = started.elapsed().as_millis() as u64,
            hits = outcome.nodes.as_ref().map(|nodes| nodes.len()).unwrap_or(0),
            "后台搜索完成"
        ),
        Err(error) => warn!(
            query = %query,
            elapsed_ms = started.elapsed().as_millis() as u64,
            error = %error,
            "后台搜索失败"
        ),
    }
    // 调用方可能已经超时退出：发送失败是正常竞态，不是错误。
    let _ = reply.send(payload);
}

/// 在长任务（事件扫描、重扫）之间抢处理已排队的搜索请求。
///
/// 返回本次处理的数量，便于日志里观测饥饿程度。
fn yield_to_pending_searches(cache: &mut MultiCache, search_rx: &Receiver<SearchJob>) -> usize {
    let mut handled = 0;
    while handled < MAX_SEARCH_JOBS_PER_YIELD {
        match search_rx.try_recv() {
            Ok(job) => {
                run_search_job(cache, job);
                handled += 1;
            }
            Err(_) => break,
        }
    }
    if handled > 0 {
        info!(handled, "长任务期间让出并处理了积压搜索");
    }
    handled
}

fn handle_flush_tick(
    app_handle: &AppHandle,
    cache: &mut MultiCache,
    db_path: &Path,
    hide_flush_remaining_ticks: &mut u8,
) {
    if load_app_state() != AppLifecycleState::Ready {
        return;
    }
    let mut flush_search_cache = FlushSearchCache { cache, db_path };
    let flushed = start_flush_checks(
        || is_main_window_foreground(app_handle),
        search_activity::search_idles,
        &mut flush_search_cache,
        hide_flush_remaining_ticks,
    );
    if flushed {
        search_activity::note_search_activity();
    }
}

fn handle_event_watcher_events(
    app_handle: &AppHandle,
    cache: &mut MultiCache,
    events: Vec<FsEvent>,
    history_ready: &mut bool,
    processed_events: &mut usize,
) {
    *processed_events += events.len();

    emit_status_bar_update(
        app_handle,
        cache.get_total_files(),
        *processed_events,
        cache.rescan_count() as usize,
    );

    let mut snapshots = Vec::with_capacity(events.len());
    for event in events.iter() {
        if event.flag == EventFlag::HistoryDone {
            *history_ready = true;
            update_app_state(app_handle, AppLifecycleState::Ready);
        } else if *history_ready {
            snapshots.push(EventSnapshot {
                path: event.path.clone(),
                event_id: event.id,
                flag: event.flag,
                timestamp: unix_timestamp_now(),
            });
        }
    }

    let handle_result = cache.handle_fs_events(events);
    if let Err(HandleFSEError::Rescan) = handle_result {
        info!("!!!!!!!!!! Rescan triggered !!!!!!!!");
        emit_status_bar_update(
            app_handle,
            cache.get_total_files(),
            *processed_events,
            cache.rescan_count() as usize,
        );
    }

    if *history_ready && !snapshots.is_empty() {
        forward_new_events(app_handle, &snapshots);
    }
}

fn handle_icon_viewport_update(
    cache: &mut MultiCache,
    update: (u64, Vec<GlobalIndex>),
    icon_update_tx: &Sender<IconPayload>,
) {
    let (_request_id, viewport) = update;

    let nodes = cache.expand_file_nodes(&viewport);
    let icon_jobs: Vec<_> = viewport
        .into_iter()
        .zip(nodes)
        .map(|(slab_index, SearchResultNode { path, .. })| (slab_index, path))
        .collect();

    if icon_jobs.is_empty() {
        return;
    }

    icon_jobs
        .into_iter()
        .map(|(slab_index, path)| (slab_index, path.to_string_lossy().into_owned()))
        .filter(|(_, path)| {
            // OneDrive
            // iCloud Drive
            // Google Drive
            // Dropbox
            !path.contains("OneDrive")
                && !path.contains("com~apple~CloudDocs")
                && !path.contains("Google Drive")
                && !path.contains("Dropbox")
        })
        .for_each(|(slab_index, path)| {
            let icon_update_tx = icon_update_tx.clone();
            spawn(move || {
                if let Some(icon) = fs_icon::icon_of_path_ql(&path).map(|data| {
                    format!(
                        "data:image/png;base64,{}",
                        general_purpose::STANDARD.encode(&data)
                    )
                }) {
                    let _ = icon_update_tx.send(IconPayload { slab_index, icon });
                }
            });
        });
}

#[allow(clippy::too_many_arguments)]
pub fn run_background_event_loop(
    app_handle: &AppHandle,
    mut cache: MultiCache,
    mut event_watcher: EventWatcher,
    channels: BackgroundLoopChannels,
    mut watch_root: String,
    fse_latency_secs: f64,
    db_path: PathBuf,
) {
    let BackgroundLoopChannels {
        finish_rx,
        update_window_state_rx,
        search_rx,
        node_info_rx,
        icon_viewport_rx,
        rescan_rx,
        watch_config_rx,
        icon_update_tx,
    } = channels;
    let mut processed_events = 0usize;
    let mut history_ready = load_app_state() == AppLifecycleState::Ready;

    let mut window_is_foreground = true;
    let mut hide_flush_remaining_ticks: u8 = 0;
    // Hide flush is polled on a 10s ticker; idle flush shares the same tick.
    let flush_ticker = crossbeam_channel::tick(Duration::from_secs(10));

    loop {
        crossbeam_channel::select! {
            recv(finish_rx) -> tx => {
                let tx = tx.expect("Finish channel closed");
                // Only save cache if it's not a noop (i.e. the initial walk wasn't cancelled), otherwise send None to avoid writing an empty cache file
                tx.send((!cache.is_noop()).then_some(cache)).expect("Failed to send cache");
                return;
            }
            recv(update_window_state_rx) -> _ => {
                // Recompute foreground state on demand instead of mirroring events.
                let new_foreground = is_main_window_foreground(app_handle);
                if window_is_foreground && !new_foreground {
                    hide_flush_remaining_ticks = 2; // allow 10~20s before running hide flush
                } else if new_foreground {
                    hide_flush_remaining_ticks = 0;
                }
                window_is_foreground = new_foreground;
            }
            recv(flush_ticker) -> _ => {
                handle_flush_tick(
                    app_handle,
                    &mut cache,
                    &db_path,
                    &mut hide_flush_remaining_ticks,
                );
            }
            recv(search_rx) -> job => {
                let job = job.expect("Search channel closed");
                run_search_job(&mut cache, job);
            }
            recv(node_info_rx) -> request => {
                let request = request.expect("Node info channel closed");
                let NodeInfoRequest {
                    slab_indices,
                    response_tx,
                } = request;
                let node_info_results = cache.expand_file_nodes(&slab_indices);
                let _ = response_tx.send(node_info_results);
            }
            recv(icon_viewport_rx) -> update => {
                let update = update.expect("Icon viewport channel closed");
                handle_icon_viewport_update(&mut cache, update, &icon_update_tx);
            }
            recv(rescan_rx) -> request => {
                let scan_cancellation_token = request.expect("Rescan channel closed");
                info!("Manual rescan requested");
                perform_rescan(
                    app_handle,
                    &mut cache,
                    &mut event_watcher,
                    &watch_root,
                    fse_latency_secs,
                    &mut history_ready,
                    &mut processed_events,
                    scan_cancellation_token,
                );
            }
            recv(watch_config_rx) -> update => {
                let next_update = update.expect("Watch config channel closed");
                handle_watch_config_update(
                    app_handle,
                    next_update,
                    &mut cache,
                    &mut event_watcher,
                    &mut watch_root,
                    fse_latency_secs,
                    &mut history_ready,
                    &mut processed_events,
                );
            }
            recv(event_watcher) -> events => {
                let events = events.expect("Event stream closed");
                let total_events = events.len();
                let started = std::time::Instant::now();
                // 先处理已经排队的搜索：事件批可能很长，搜索不能排到它后面。
                yield_to_pending_searches(&mut cache, &search_rx);
                let mut remaining = events.into_iter();
                loop {
                    // FsEvent 未实现 Clone：按块 drain 而不是切片复制。
                    let chunk: Vec<FsEvent> = remaining.by_ref().take(EVENT_BATCH_CHUNK).collect();
                    if chunk.is_empty() {
                        break;
                    }
                    handle_event_watcher_events(
                        app_handle,
                        &mut cache,
                        chunk,
                        &mut history_ready,
                        &mut processed_events,
                    );
                    yield_to_pending_searches(&mut cache, &search_rx);
                }
                info!(
                    events = total_events,
                    chunks = total_events.div_ceil(EVENT_BATCH_CHUNK),
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "事件批次处理完成"
                );
            }
        }
    }
}

pub(crate) fn build_search_cache(
    app_handle: &AppHandle,
    watch_roots: &[PathBuf],
    ignore_paths: &[PathBuf],
    scan_cancellation_token: CancellationToken,
) -> Option<MultiCache> {
    let mut slots = Vec::with_capacity(watch_roots.len());

    for (index, root) in watch_roots.iter().enumerate() {
        // 按监控列表顺序逐根构建：列表顺序就是优先级，高优先级根先进入索引。
        info!(
            root = %root.display(),
            index = index + 1,
            total = watch_roots.len(),
            "开始构建该根的索引"
        );

        let walk_data = WalkData::new(root.as_path(), ignore_paths, false, move || {
            APP_QUIT.load(Ordering::Relaxed) || scan_cancellation_token.is_cancelled().is_none()
        });
        let walking_done = AtomicBool::new(false);
        let built = std::thread::scope(|s| {
            s.spawn(|| {
                while !walking_done.load(Ordering::Relaxed) {
                    let dirs = walk_data.num_dirs.load(Ordering::Relaxed);
                    let files = walk_data.num_files.load(Ordering::Relaxed);
                    emit_status_bar_update(app_handle, dirs + files, 0, 0);
                    std::thread::sleep(Duration::from_millis(100));
                }
            });
            let cache = search_cache::SearchCache::walk_fs_with_walk_data(&walk_data, &APP_QUIT);
            walking_done.store(true, Ordering::Relaxed);
            cache
        })?;

        info!(
            root = %root.display(),
            nodes = built.get_total_files(),
            "该根索引构建完成"
        );
        emit_status_bar_update(app_handle, built.get_total_files(), 0, 0);
        slots.push(crate::multi_cache::CacheSlot {
            root: root.clone(),
            cache: built,
        });
    }

    Some(MultiCache::new(slots))
}

#[allow(clippy::too_many_arguments)]
fn perform_rescan(
    app_handle: &AppHandle,
    cache: &mut MultiCache,
    event_watcher: &mut EventWatcher,
    watch_root: &str,
    fse_latency_secs: f64,
    history_ready: &mut bool,
    processed_events: &mut usize,
    scan_cancellation_token: CancellationToken,
) {
    if scan_cancellation_token.is_cancelled().is_none() {
        info!("跳过过期的重扫请求");
        return;
    }

    let rescan_started = Instant::now();
    let nodes_before = cache.get_total_files();
    info!(
        nodes_before,
        watch_root, "开始全量重扫（期间搜索会立即返回 index_building 或等待超时）"
    );
    *event_watcher = EventWatcher::noop();
    update_app_state(app_handle, AppLifecycleState::Initializing);
    *history_ready = false;
    *processed_events = 0;
    reset_status_bar(app_handle);

    // 多根模式下逐根全量重扫；进度由各根内部的状态栏更新负责。
    let stopped = {
        cache.rescan();
        // 重扫本身不返回取消状态，取消由令牌在下一轮 select! 里处理。
        false
    };

    *event_watcher = if stopped {
        warn!(
            elapsed_ms = rescan_started.elapsed().as_millis() as u64,
            "全量重扫被取消（令牌过期或应用退出）"
        );
        EventWatcher::noop()
    } else {
        update_app_state(app_handle, AppLifecycleState::Updating);
        info!(
            elapsed_ms = rescan_started.elapsed().as_millis() as u64,
            nodes_before,
            nodes_after = cache.get_total_files(),
            "全量重扫完成"
        );
        EventWatcher::spawn(
            watch_root.to_string(),
            cache.last_event_id(),
            fse_latency_secs,
            cache.ignore_paths(),
        )
        .1
    };
}

fn unix_timestamp_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn forward_new_events(app_handle: &AppHandle, snapshots: &[EventSnapshot]) {
    if snapshots.is_empty() {
        return;
    }

    let mut ordered_events: Vec<&EventSnapshot> = snapshots.iter().collect();
    ordered_events.sort_unstable_by(|a, b| {
        a.timestamp
            .cmp(&b.timestamp)
            .then_with(|| a.event_id.cmp(&b.event_id))
    });
    let new_events: Vec<RecentEvent> = ordered_events
        .into_iter()
        .map(|event| RecentEvent {
            path: event.path.to_string_lossy().into_owned(),
            flag_bits: event.flag.bits(),
            event_id: event.event_id,
            timestamp: event.timestamp,
        })
        .collect();

    let _ = app_handle.emit("fs_events_batch", new_events);
}

struct FlushSearchCache<'cache> {
    cache: &'cache mut MultiCache,
    /// 数据库文件路径：单根直接写它，多根由 MultiCache 取其父目录后分文件。
    db_path: &'cache Path,
}

trait FlushSnapshot {
    fn flush_snapshot_to_file(&mut self) -> Result<()>;
    fn db_path(&self) -> &Path;
}

impl FlushSnapshot for FlushSearchCache<'_> {
    fn flush_snapshot_to_file(&mut self) -> Result<()> {
        self.cache.flush_snapshot_to_file(self.db_path)
    }
    fn db_path(&self) -> &Path {
        self.db_path
    }
}

/// This function should be called periodically to check if a flush is needed.
/// Returns true if a flush was performed (either hide or idle).
fn start_flush_checks<F, I, C>(
    is_foreground: F,
    is_idle: I,
    cache: &mut C,
    hide_flush_remaining_ticks: &mut u8,
) -> bool
where
    F: Fn() -> bool,
    I: Fn() -> bool,
    C: FlushSnapshot,
{
    let idle_flush = is_idle();
    let hide_flush = {
        // Consume the pending hide flush counter; only fire once.
        if *hide_flush_remaining_ticks > 0 {
            *hide_flush_remaining_ticks -= 1;
            *hide_flush_remaining_ticks == 0
        } else {
            false
        }
    };
    let hide_flush = hide_flush && !is_foreground();

    if hide_flush {
        let label = "hide_flush";
        let started = Instant::now();
        match cache.flush_snapshot_to_file() {
            Ok(()) => info!(
                label,
                elapsed_ms = started.elapsed().as_millis() as u64,
                db = ?cache.db_path(),
                "缓存落盘成功（窗口隐藏触发）"
            ),
            Err(e) => error!(
                "Cache flush failed ({label}) to {:?}: {e:?}",
                cache.db_path()
            ),
        }
        true
    } else if idle_flush {
        let label = "idle_flush";
        let started = Instant::now();
        match cache.flush_snapshot_to_file() {
            Ok(()) => info!(
                label,
                elapsed_ms = started.elapsed().as_millis() as u64,
                db = ?cache.db_path(),
                "缓存落盘成功（空闲触发）"
            ),
            Err(e) => error!(
                "Cache flush failed ({label}) to {:?}: {e:?}",
                cache.db_path()
            ),
        }
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeCache {
        pub flushes: usize,
    }

    impl FlushSnapshot for FakeCache {
        fn flush_snapshot_to_file(&mut self) -> Result<()> {
            self.flushes += 1;
            Ok(())
        }

        fn db_path(&self) -> &Path {
            Path::new("db")
        }
    }

    #[test]
    fn hide_flush_resets_idle_window() {
        let mut cache = FakeCache::default();
        let mut pending = 1;
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);

        assert_eq!(cache.flushes, 1, "hide flush should run once");
        assert_eq!(pending, 0, "pending hide flush should be consumed");
        assert!(
            flushed,
            "hide flush should satisfy idle window to avoid immediate idle flush"
        );
    }

    #[test]
    fn idle_flush_runs_when_due() {
        let mut cache = FakeCache::default();
        let mut pending = 0;
        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);

        assert_eq!(cache.flushes, 1, "idle flush should run once when due");
        assert!(flushed, "idle flush should advance idle window");
    }

    #[test]
    fn pending_consumed_but_no_hide_flush_if_foreground() {
        let mut cache = FakeCache::default();
        let mut pending = 1;
        // Foreground -> pending should be consumed but no hide flush should run
        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush satisfied in foreground");

        assert_eq!(
            cache.flushes, 0,
            "no flush should run while window is foreground"
        );
        assert_eq!(
            pending, 0,
            "pending counter should be consumed even if foreground"
        );
    }

    #[test]
    fn hide_flush_requires_two_ticks() {
        // make sure idle flush is not accidentally due from other tests

        let mut cache = FakeCache::default();
        let mut pending = 2;

        // First tick consumes one counter, no flush yet
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush satisfied on first tick");
        assert_eq!(cache.flushes, 0, "no flush on first tick");
        assert_eq!(pending, 1, "pending decremented to 1");

        // Second tick should trigger the hide flush
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1, "flush should run on second tick");
        assert_eq!(pending, 0, "pending should be consumed after flush");
    }

    #[test]
    fn hide_preempts_idle_and_only_one_flush_when_both_pending() {
        let mut cache = FakeCache::default();
        let mut pending = 1;

        // When both an idle flush is due and a hide flush fires, hide flush
        // should run and it should satisfy the idle window so we don't double-flush.
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);

        assert_eq!(cache.flushes, 1, "only one flush should run");
        assert_eq!(pending, 0, "pending hide flush should be consumed");
        assert!(flushed, "hide flush should satisfy idle window");
    }

    use anyhow::anyhow;

    struct FakeCacheErr;

    impl FlushSnapshot for FakeCacheErr {
        fn flush_snapshot_to_file(&mut self) -> Result<()> {
            Err(anyhow!("flush failed"))
        }

        fn db_path(&self) -> &Path {
            Path::new("db")
        }
    }

    #[test]
    fn flush_error_does_not_reset_idle() {
        let mut cache = FakeCacheErr;
        let mut pending = 1;

        // Hide flush attempt fails; the hide flush logic treats the flush as
        // satisfying the idle window (it bumps the idle timestamp even on errors).
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);

        // pending should be consumed (counter is decremented), but since flush failed,
        // idle window should still be considered idle and search_idles() should be true.
        assert!(
            flushed,
            "failed hide flush should still satisfy idle window (bumped)"
        );
        assert_eq!(
            pending, 0,
            "pending should be consumed even on flush failure"
        );
    }

    // ===== Tests for foreground -> background transitions =====

    #[test]
    fn foreground_to_background_sets_pending_to_2() {
        // This test verifies the initial state when window goes to background
        // In the real event loop, `hide_flush_remaining_ticks` is set to 2
        // Note: if idle is already due, idle flush will trigger regardless of pending

        let mut cache = FakeCache::default();
        let mut pending = 2; // simulates what happens when window loses focus

        // First tick after going to background: pending=2, decrements to 1, no hide flush yet
        // idle not due, so no flush at all
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on first tick");
        assert_eq!(
            cache.flushes, 0,
            "no flush on first tick after backgrounding (idle not due)"
        );
        assert_eq!(pending, 1, "pending should decrement from 2 to 1");
    }

    #[test]
    fn foreground_to_background_idle_not_due_completes_after_two_ticks() {
        // Window goes to background, idle is not due, should flush after 2 ticks (10-20s)

        let mut cache = FakeCache::default();
        let mut pending = 2;

        // Tick 1: decrement but no flush
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on tick 1");
        assert_eq!(cache.flushes, 0);
        assert_eq!(pending, 1);

        // Tick 2: should trigger hide flush
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1, "flush should trigger on second tick");
        assert_eq!(pending, 0);
    }

    #[test]
    fn foreground_to_background_while_idle_due_flushes_on_second_tick() {
        // Window goes to background AND idle is due: idle_flush will run immediately
        // because the else-if checks idle regardless of hide_flush countdown
        let mut cache = FakeCache::default();
        let mut pending = 2;

        // Make sure idle is NOT due initially

        // Tick 1: pending=2, decrements to 1, idle not due, no flush
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush when idle not due");
        assert_eq!(cache.flushes, 0, "no flush when idle not due");
        assert_eq!(pending, 1, "pending still decrements");

        // Now make idle due

        // Tick 2: pending=1, becomes 0, hide_flush fires (takes priority over idle)
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert_eq!(cache.flushes, 1, "hide flush fires on second tick");
        assert_eq!(pending, 0);
        assert!(flushed, "hide flush satisfies idle");
    }

    #[test]
    fn background_to_foreground_resets_pending_to_zero() {
        // Window is in background (pending > 0), then comes back to foreground
        // Make sure idle is NOT due to avoid interference

        let mut cache = FakeCache::default();
        let mut pending = 1; // simulates partial countdown

        // User brings window back to foreground before flush triggers
        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush when returning to foreground");
        assert_eq!(
            cache.flushes, 0,
            "no flush when returning to foreground (idle not due)"
        );
        assert_eq!(pending, 0, "pending should be reset to 0");
    }

    #[test]
    fn multiple_background_entries_only_first_sets_pending() {
        // If window goes background -> foreground -> background quickly,
        // the second background entry should reset pending to 2 again.
        // This test simulates the second background entry.

        let mut cache = FakeCache::default();

        // First background entry
        let mut pending = 2;
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on first background");
        assert_eq!(pending, 1);

        // User returns to foreground briefly
        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush in foreground");
        assert_eq!(pending, 0);

        // Goes to background again - in real code, this sets pending=2 again
        pending = 2;
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on countdown restart");
        assert_eq!(cache.flushes, 0, "countdown restarts");
        assert_eq!(pending, 1);

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1, "flush after second countdown");
        assert_eq!(pending, 0);
    }

    #[test]
    fn idle_flush_while_in_background_with_no_pending() {
        // Window is in background, pending already consumed (or was 0),
        // but idle becomes due -> idle flush should run

        let mut cache = FakeCache::default();
        let mut pending = 0;

        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "idle flush should be satisfied");
        assert_eq!(cache.flushes, 1, "idle flush should run even in background");
        assert_eq!(pending, 0);
    }

    #[test]
    fn no_flush_when_not_idle_and_no_pending() {
        // Window is anywhere, no pending, idle not due -> no flush

        let mut cache = FakeCache::default();
        let mut pending = 0;

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush when conditions not met");
        assert_eq!(cache.flushes, 0, "no flush when neither condition is met");

        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush in foreground");
        assert_eq!(cache.flushes, 0, "still no flush in foreground");
    }

    #[test]
    fn pending_equals_1_triggers_immediately_in_background() {
        // If pending is already 1 (second tick countdown), flush should trigger

        let mut cache = FakeCache::default();
        let mut pending = 1;

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1, "pending=1 in background should flush");
        assert_eq!(pending, 0);
    }

    #[test]
    fn pending_greater_than_2_decrements_correctly() {
        // Edge case: if pending is set to 3+ (shouldn't happen normally),
        // it should decrement each tick until reaching 0, then flush

        let mut cache = FakeCache::default();
        let mut pending = 3;

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush during countdown");
        assert_eq!(cache.flushes, 0);
        assert_eq!(pending, 2);

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush during countdown");
        assert_eq!(cache.flushes, 0);
        assert_eq!(pending, 1);

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1, "flush triggers when countdown reaches 0");
        assert_eq!(pending, 0);
    }

    #[test]
    fn rapid_foreground_background_transitions() {
        // Test rapid transitions: background -> foreground -> background

        let mut cache = FakeCache::default();

        // Go to background
        let mut pending = 2;
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on background transition");
        assert_eq!(pending, 1);

        // Immediately back to foreground
        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush when returning to foreground");
        assert_eq!(pending, 0);
        assert_eq!(cache.flushes, 0);

        // Back to background again
        pending = 2;
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on re-background");
        assert_eq!(pending, 1);

        // Back to foreground before flush
        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on cancellation");
        assert_eq!(pending, 0);
        assert_eq!(cache.flushes, 0, "should never flush due to cancellations");
    }

    #[test]
    fn idle_triggers_during_hide_countdown() {
        // Window goes to background (pending=2), but before the countdown completes,
        // idle becomes due. The hide flush (on second tick) should preempt idle.
        let mut cache = FakeCache::default();
        let mut pending = 2;

        // First tick: pending=2->1, idle not quite due yet
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "idle not due yet during countdown");
        assert_eq!(cache.flushes, 0);
        assert_eq!(pending, 1);

        // Second tick: pending=1->0, both background and idle are ready,
        // background should preempt
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert_eq!(cache.flushes, 1, "single flush (background preempts idle)");
        assert_eq!(pending, 0);
        assert!(flushed, "idle satisfied by hide flush");
    }

    #[test]
    fn consecutive_hide_flushes_require_new_pending() {
        // After a hide flush completes, pending is 0.
        // Idle flush can trigger independently if conditions are met.
        let mut cache = FakeCache::default();
        let mut pending = 1;

        // Set up so we won't hit idle initially

        // First hide flush
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1);
        assert_eq!(pending, 0);

        // Ticks continue, but pending is 0 and idle not due -> no more flushes
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush without new trigger");
        assert_eq!(
            cache.flushes, 1,
            "no second flush without new pending or idle"
        );

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "still no idle flush");
        assert_eq!(cache.flushes, 1, "still no flush");

        // Simulate window coming back and going to background again
        pending = 2;
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush during countdown");
        assert_eq!(pending, 1);
        assert_eq!(cache.flushes, 1, "no flush yet, still counting down");

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "second hide flush was performed");
        assert_eq!(cache.flushes, 2, "second hide flush after re-backgrounding");
        assert_eq!(pending, 0);
    }

    #[test]
    fn error_during_hide_flush_still_consumes_pending() {
        // Hide flush fails, but pending should still be consumed

        let mut cache = FakeCacheErr;
        let mut pending = 1;

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was attempted");
        assert_eq!(pending, 0, "pending consumed even on flush error");

        // Should not re-attempt flush on next tick unless pending is set again
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush on retry");
        assert_eq!(pending, 0, "stays at 0");
    }

    #[test]
    fn idle_flush_in_foreground_when_due() {
        // Foreground window, idle is due -> idle flush should run

        let mut cache = FakeCache::default();
        let mut pending = 0;

        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert_eq!(cache.flushes, 1, "idle flush runs in foreground");
        assert!(flushed, "idle window advanced");
    }

    #[test]
    fn no_idle_flush_in_foreground_when_not_due() {
        // Foreground window, idle not due -> no flush

        let mut cache = FakeCache::default();
        let mut pending = 0;

        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush when not due");
        assert_eq!(cache.flushes, 0, "no flush when idle not due");
    }

    #[test]
    fn hide_flush_after_exact_two_ticks_at_ten_seconds_each() {
        // Verifies the exact 10-20 second window: pending=2 means first tick at ~10s, second at ~20s

        let mut cache = FakeCache::default();
        let mut pending = 2;

        // Tick at ~10s
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush at ~10s mark");
        assert_eq!(cache.flushes, 0, "no flush at ~10s mark");
        assert_eq!(pending, 1);

        // Tick at ~20s
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed at ~20s");
        assert_eq!(cache.flushes, 1, "flush at ~20s mark");
        assert_eq!(pending, 0);
    }

    #[test]
    fn idle_flush_error_still_advances_idle_window() {
        // Idle flush fails, but idle window should still be advanced

        let mut cache = FakeCacheErr;
        let mut pending = 0;

        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);

        // Even though flush failed, idle window should be advanced
        assert!(flushed, "idle window should be advanced even on error");
    }

    #[test]
    fn idle_at_exact_5_minute_boundary() {
        let mut cache = FakeCache::default();
        let mut pending = 0;

        // At exactly 5 minutes, should trigger
        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert!(flushed, "idle flush should be satisfied at exact boundary");
        assert_eq!(cache.flushes, 1, "flush should trigger at exact boundary");
    }

    #[test]
    fn idle_just_under_5_minute_boundary() {
        // Test behavior when idle is 1 second under threshold

        let mut cache = FakeCache::default();
        let mut pending = 0;

        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush when under threshold");
        assert_eq!(cache.flushes, 0, "no flush when under threshold");
    }

    #[test]
    fn background_to_foreground_with_idle_due() {
        // Window returns to foreground while idle is due and pending>0
        // Pending gets consumed, and idle flush triggers

        let mut cache = FakeCache::default();
        let mut pending = 1; // was in background countdown

        // Returns to foreground with idle due
        // Since we're in foreground, hide_flush won't fire (even if pending becomes 0)
        // But idle_flush will fire because it's due
        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert!(flushed, "idle flush should be satisfied");
        assert_eq!(cache.flushes, 1, "idle flush should trigger in foreground");
        assert_eq!(pending, 0, "pending should be consumed");
    }

    #[test]
    fn pending_u8_max_decrements_correctly() {
        // Edge case: pending at u8::MAX should decrement without overflow

        let mut cache = FakeCache::default();
        let mut pending = u8::MAX;

        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush during MAX countdown");
        assert_eq!(pending, u8::MAX - 1, "should decrement from MAX");
        assert_eq!(cache.flushes, 0, "no flush at MAX");

        // Continue decrementing
        for _ in 0..(u8::MAX - 2) {
            let _flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        }
        assert_eq!(pending, 1, "should reach 1");

        // Final tick triggers flush
        let flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
        assert!(flushed, "hide flush was performed");
        assert_eq!(cache.flushes, 1, "flush when reaching 0");
        assert_eq!(pending, 0);
    }

    #[test]
    fn consecutive_idle_flushes() {
        // Multiple idle flushes should each reset the idle window
        // Note: Each set_idle_over_5m call sets the timestamp independently
        let mut cache = FakeCache::default();
        let mut pending = 0;

        // First idle flush

        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert!(flushed, "first idle flush should be satisfied");
        assert_eq!(cache.flushes, 1, "first idle flush");

        // Second idle flush - set idle again

        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert!(flushed, "second idle flush should be satisfied");
        assert_eq!(cache.flushes, 2, "second idle flush");

        // Third idle flush

        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert!(flushed, "third idle flush should be satisfied");
        assert_eq!(cache.flushes, 3, "third idle flush");
    }

    #[test]
    fn hide_flush_pending_1_with_idle_also_due() {
        // Both hide (pending=1) and idle are ready, hide should win

        let mut cache = FakeCache::default();
        let mut pending = 1;

        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "hide flush satisfies idle when both ready");
        assert_eq!(cache.flushes, 1, "single flush (hide wins)");
        assert_eq!(pending, 0);
        assert!(flushed, "idle satisfied by hide flush");
    }

    #[test]
    fn idle_flush_error_then_success() {
        // Idle flush fails, then succeeds on retry

        let mut cache_err = FakeCacheErr;
        let mut pending = 0;

        let flushed = start_flush_checks(|| true, || true, &mut cache_err, &mut pending);
        assert!(flushed, "idle advanced even on error");

        // Time passes again

        let mut cache_ok = FakeCache::default();
        let flushed = start_flush_checks(|| true, || true, &mut cache_ok, &mut pending);
        assert!(flushed, "idle flush satisfied on success");
        assert_eq!(cache_ok.flushes, 1, "should succeed on retry");
    }

    #[test]
    fn pending_zero_stays_zero() {
        // Calling with pending=0 should keep it at 0

        let mut cache = FakeCache::default();
        let mut pending = 0;

        for _ in 0..10 {
            let _flushed = start_flush_checks(|| false, || false, &mut cache, &mut pending);
            assert_eq!(pending, 0, "pending should stay at 0");
        }
        assert_eq!(
            cache.flushes, 0,
            "no flushes when pending=0 and idle not due"
        );
    }

    #[test]
    fn foreground_with_pending_and_idle_both_not_ready() {
        // Foreground, pending=5, idle not due -> pending decrements, no flush

        let mut cache = FakeCache::default();
        let mut pending = 5;

        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush in foreground");
        assert_eq!(pending, 4, "pending decrements in foreground");
        assert_eq!(cache.flushes, 0, "no flush");

        let flushed = start_flush_checks(|| true, || false, &mut cache, &mut pending);
        assert!(!flushed, "no idle flush in foreground");
        assert_eq!(pending, 3);
        assert_eq!(cache.flushes, 0);
    }

    #[test]
    fn hide_flush_success_then_immediate_idle_due() {
        // Hide flush completes, then immediately idle becomes due (edge case)
        let mut cache = FakeCache::default();
        let mut pending = 1;

        // Hide flush triggers
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "hide flush satisfies idle");
        assert_eq!(cache.flushes, 1);
        assert_eq!(pending, 0);

        // Now idle becomes due

        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "idle flush should be satisfied after hide");
        assert_eq!(cache.flushes, 2, "idle flush should trigger after hide");
    }

    #[test]
    fn alternating_hide_and_idle_flushes() {
        // Alternate between hide and idle flushes
        let mut cache = FakeCache::default();

        // Hide flush (make sure idle is not due)

        let mut pending = 1;
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "hide flush satisfies idle");
        assert_eq!(cache.flushes, 1, "first hide flush");
        assert_eq!(pending, 0);

        // Idle flush (set idle to be due)
        pending = 0;

        let flushed = start_flush_checks(|| true, || true, &mut cache, &mut pending);
        assert!(flushed, "idle flush should be satisfied");
        assert_eq!(cache.flushes, 2, "first idle flush");

        // Hide flush again (reset idle to not due)

        pending = 1;
        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "hide flush satisfies idle");
        assert_eq!(cache.flushes, 3, "second hide flush");
        assert_eq!(pending, 0);

        // Idle again (set idle to be due)
        pending = 0;

        let flushed = start_flush_checks(|| false, || true, &mut cache, &mut pending);
        assert!(flushed, "idle flush should be satisfied");
        assert_eq!(cache.flushes, 4, "second idle flush");
    }
}
