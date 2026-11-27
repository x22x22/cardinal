use crate::{
    DEFAULT_SYSTEM_IGNORE_PATH, LOGIC_START, LogicStartConfig,
    lifecycle::load_app_state,
    quicklook::{
        QuickLookItemInput, close_preview_panel, toggle_preview_panel, update_preview_panel,
    },
    search_activity,
    sort::{SortEntry, SortStatePayload, sort_entries},
    window_controls::{activate_main_window_impl, hide_main_window_impl, toggle_main_window_impl},
};
use anyhow::{Result, anyhow};
use base64::{Engine as _, engine::general_purpose};
use camino::{Utf8Path as Path, Utf8PathBuf as PathBuf};
use crossbeam_channel::{Sender, bounded};
use fswalk::validate_ignore_pattern;
use objc2::{
    rc::{Retained, autoreleasepool},
    runtime::ProtocolObject,
};
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardTypeString, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSString, NSURL};
use parking_lot::Mutex;
use crate::multi_cache::{GlobalIndex, MultiOutcome};
use search_cache::{SearchOptions, SearchResultNode, SlabNodeMetadata};
use search_cancel::CancellationToken;
use serde::{Deserialize, Serialize};
use std::{
    cell::LazyCell,
    process::Command,
    time::{Duration, Instant},
};
use tauri::{ActivationPolicy, AppHandle, State};
use tracing::{debug, error, info, warn};

#[derive(Debug, Clone)]
pub struct WatchConfigUpdate {
    /// 多根列表（有序即优先级）。为空时回退到 `watch_root` 单根。
    pub watch_roots: Vec<String>,
    pub watch_root: String,
    pub ignore_paths: Vec<String>,
    pub scan_cancellation_token: CancellationToken,
}

#[derive(Debug, Clone, Copy, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptionsPayload {
    #[serde(default)]
    pub case_insensitive: bool,
    /// 本页最多返回多少条；`None` 用 `DEFAULT_SEARCH_LIMIT`。
    /// 本机单独 `/` 根就有 549 万节点，不限制的话每一页都是几十 MB 的
    /// IPC payload，前端必挂。
    #[serde(default)]
    pub limit: Option<usize>,
    /// 跳过的条数，用于「滚动到底加载下一页」。
    #[serde(default)]
    pub offset: Option<usize>,
}

impl From<SearchOptionsPayload> for SearchOptions {
    fn from(payload: SearchOptionsPayload) -> Self {
        // limit/offset 只用于命令层切片，不进搜索引擎。
        SearchOptions {
            case_insensitive: payload.case_insensitive,
        }
    }
}

#[derive(Debug, Clone)]
pub struct SearchJob {
    pub query: String,
    pub options: SearchOptionsPayload,
    pub cancellation_token: CancellationToken,
    /// 每个请求独占的回复通道。
    ///
    /// 早期实现用单一共享 receiver + 互斥锁串行化，结果是逐字符输入时搜索会
    /// 互相排队（实测单次排队超过 10 秒），并且先到先得会把结果错配给别的
    /// 请求（同一 query 在 commands 层报 hits=0、在后台层报 hits=3）。
    /// 让请求自带回复通道后，取消与结果都天然隔离。
    pub reply: Sender<Result<crate::multi_cache::MultiOutcome>>,
}

#[derive(Debug, Clone)]
pub struct NodeInfoRequest {
    pub slab_indices: Vec<GlobalIndex>,
    pub response_tx: Sender<Vec<SearchResultNode>>,
}

#[derive(Default)]
struct SortedViewCache {
    slab_indices: Vec<GlobalIndex>,
    nodes: Vec<SearchResultNode>,
}

/// 搜索通道的可克隆句柄。
///
/// 结果通过 [`SearchJob::reply`] 按请求回传，无需共享 receiver，也无需串行化。
#[derive(Clone)]
struct SearchIo {
    search_tx: Sender<SearchJob>,
}

pub struct SearchState {
    search_io: SearchIo,

    node_info_tx: Sender<NodeInfoRequest>,

    icon_viewport_tx: Sender<(u64, Vec<GlobalIndex>)>,
    rescan_tx: Sender<CancellationToken>,
    watch_config_tx: Sender<WatchConfigUpdate>,
    sorted_view_cache: Mutex<Option<SortedViewCache>>,
    pub(crate) update_window_state_tx: Sender<()>,
}

impl SearchState {
    pub fn new(
        search_tx: Sender<SearchJob>,
        node_info_tx: Sender<NodeInfoRequest>,
        icon_viewport_tx: Sender<(u64, Vec<GlobalIndex>)>,
        rescan_tx: Sender<CancellationToken>,
        watch_config_tx: Sender<WatchConfigUpdate>,
        update_window_state_tx: Sender<()>,
    ) -> Self {
        Self {
            search_io: SearchIo { search_tx },
            node_info_tx,
            icon_viewport_tx,
            rescan_tx,
            watch_config_tx,
            sorted_view_cache: Mutex::new(None),
            update_window_state_tx,
        }
    }

    fn request_nodes(&self, slab_indices: Vec<GlobalIndex>) -> Vec<SearchResultNode> {
        if slab_indices.is_empty() {
            return Vec::new();
        }

        let (response_tx, response_rx) = bounded::<Vec<SearchResultNode>>(1);
        if let Err(e) = self.node_info_tx.send(NodeInfoRequest {
            slab_indices,
            response_tx,
        }) {
            error!("Failed to send node info request: {e:?}");
            return Vec::new();
        }

        response_rx.recv().unwrap_or_else(|e| {
            error!("Failed to receive node info results: {e:?}");
            Vec::new()
        })
    }

    fn fetch_sorted_nodes(&self, slab_indices: &[GlobalIndex]) -> Vec<SearchResultNode> {
        if slab_indices.is_empty() {
            return Vec::new();
        }

        let mut cache_guard = self.sorted_view_cache.lock();
        if let Some(cached) = cache_guard
            .as_ref()
            .filter(|cache| cache.slab_indices == slab_indices)
            .map(|cache| cache.nodes.clone())
        {
            return cached;
        }

        let nodes = self.request_nodes(slab_indices.to_vec());
        *cache_guard = Some(SortedViewCache {
            slab_indices: slab_indices.to_vec(),
            nodes: nodes.clone(),
        });
        nodes
    }
}

/// Normalizes user-provided path input into an absolute path string.
///
/// Expands a leading `~` component using the current `HOME` directory and rejects
/// non-absolute paths (including relative paths and unsupported `~user` forms).
/// Returns `Some` absolute path string when valid, otherwise `None`.
fn normalize_path_input(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let path = Path::new(trimmed);
    let mut expanded = PathBuf::new();
    let home = LazyCell::new(|| {
        std::env::var_os("HOME").and_then(|h| h.to_string_lossy().into_owned().into())
    });

    for (index, component) in path.into_iter().enumerate() {
        if index == 0 && component == "~" {
            expanded.push(home.as_deref()?);
        } else {
            expanded.push(component);
        }
    }

    let resolved = expanded.into_string();
    if resolved.starts_with('/') {
        Some(resolved)
    } else {
        None
    }
}

fn normalize_ignore_pattern_input(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with('/') {
        return Some(trimmed.to_string());
    }

    if trimmed == "~" || trimmed.starts_with("~/") {
        return normalize_path_input(trimmed);
    }

    if trimmed.starts_with("./") || trimmed.starts_with("../") || trimmed.starts_with('~') {
        return None;
    }

    Some(trimmed.to_string())
}

/// 归一化并去重多根列表。
///
/// 去重规则：父路径一旦被保留，其所有子路径都会被丢弃（父已覆盖子），并在日志里
/// 记下被覆盖的路径，方便用户在设置界面看到「这条被 `/Users/x` 覆盖了」。
pub(crate) fn normalize_watch_roots(
    watch_roots: &[String],
    fallback_single: Option<&str>,
) -> Vec<String> {
    let mut roots: Vec<String> = watch_roots
        .iter()
        .filter_map(|root| normalize_path_input(root))
        .collect();

    if roots.is_empty()
        && let Some(single) = fallback_single.and_then(normalize_path_input)
    {
        roots.push(single);
    }

    for root in roots.iter_mut() {
        while root.len() > 1 && root.ends_with('/') {
            root.pop();
        }
    }

    // 父路径优先：段数少的先保留，后面的子路径就被它覆盖掉。
    roots.sort_by_key(|root| root.matches('/').count());
    roots.dedup();

    let mut kept: Vec<String> = Vec::with_capacity(roots.len());
    for root in roots {
        let covered_by = kept
            .iter()
            .find(|parent| root == **parent || root.starts_with(&format!("{parent}/")));
        match covered_by {
            Some(parent) => info!("监控路径 {root} 已被 {parent} 覆盖，跳过"),
            None => kept.push(root),
        }
    }
    kept
}

pub(crate) fn normalize_watch_config(
    watch_root: &str,
    ignore_paths: Vec<String>,
    fallback_watch_root: Option<&str>,
) -> Option<(String, Vec<String>)> {
    let watch_root = normalize_path_input(watch_root)
        .or_else(|| fallback_watch_root.and_then(normalize_path_input))?;
    let mut ignore_paths = ignore_paths
        .into_iter()
        .filter_map(|path| {
            let normalized = normalize_ignore_pattern_input(&path);
            if let Some(normalized) = normalized {
                if let Err(err) = validate_ignore_pattern(std::path::Path::new(&normalized)) {
                    warn!("Ignoring invalid ignore path: {path:?}, error: {err}");
                    return None;
                }
                Some(normalized)
            } else {
                warn!("Ignoring invalid ignore path: {path:?}");
                None
            }
        })
        .collect::<Vec<_>>();
    if !ignore_paths
        .iter()
        .any(|path| path == DEFAULT_SYSTEM_IGNORE_PATH)
    {
        ignore_paths.push(DEFAULT_SYSTEM_IGNORE_PATH.to_string());
    }
    Some((watch_root, ignore_paths))
}

#[derive(Serialize)]
pub struct NodeInfo {
    pub path: String,
    pub metadata: Option<NodeInfoMetadata>,
    pub icon: Option<String>,
}

#[derive(Serialize, Default)]
pub struct SearchResponse {
    pub results: Vec<GlobalIndex>,
    pub highlights: Vec<String>,
    /// 该查询在本次切片前的命中总数，前端用它判断还有没有下一页。
    pub total: usize,
}

#[derive(Serialize)]
pub struct NodeInfoMetadata {
    pub r#type: u8,
    pub size: i64,
    pub ctime: u32,
    pub mtime: u32,
}

impl NodeInfoMetadata {
    pub fn from_metadata(metadata: SlabNodeMetadata<'_>) -> Self {
        Self {
            r#type: metadata.r#type() as u8,
            size: metadata.size(),
            ctime: metadata.ctime().map(|x| x.get()).unwrap_or_default(),
            mtime: metadata.mtime().map(|x| x.get()).unwrap_or_default(),
        }
    }
}

#[tauri::command]
pub async fn close_quicklook(app_handle: AppHandle) {
    let app_handle_cloned = app_handle.clone();
    if let Err(e) = app_handle.run_on_main_thread(move || {
        close_preview_panel(app_handle_cloned);
    }) {
        error!("Failed to dispatch quicklook action: {e:?}");
    }
}

#[tauri::command]
pub async fn update_quicklook(app_handle: AppHandle, items: Vec<QuickLookItemInput>) {
    let app_handle_cloned = app_handle.clone();
    if let Err(e) = app_handle.run_on_main_thread(move || {
        update_preview_panel(app_handle_cloned, items);
    }) {
        error!("Failed to dispatch quicklook action: {e:?}");
    }
}

#[tauri::command]
pub async fn toggle_quicklook(app_handle: AppHandle, items: Vec<QuickLookItemInput>) {
    let app_handle_cloned = app_handle.clone();
    if let Err(e) = app_handle.run_on_main_thread(move || {
        toggle_preview_panel(app_handle_cloned, items);
    }) {
        error!("Failed to dispatch quicklook action: {e:?}");
    }
}

/// 等待后端搜索结果的上限。
///
/// 后台事件循环是单线程 `select!`，一旦被 FSEvents 递归扫描占满，搜索请求就会被
/// 无限期推迟。这里必须有超时，否则前端会永久停在「正在搜索…」且毫无提示。
const SEARCH_TIMEOUT: Duration = Duration::from_secs(20);

/// 单页结果上限。虚拟列表一次渲染几百行就够，2000 条留足滚动余量。
const DEFAULT_SEARCH_LIMIT: usize = 2000;

#[tauri::command]
pub async fn search(
    query: String,
    options: Option<SearchOptionsPayload>,
    version: u64,
    state: State<'_, SearchState>,
) -> Result<SearchResponse, String> {
    search_activity::note_search_activity();

    let options = options.unwrap_or_default();
    let query_for_log = query.clone();
    let io = state.search_io.clone();
    let started = Instant::now();

    // 关键：阻塞式 `recv` 必须离开 tokio worker。
    // 否则并发搜索会把 runtime 线程全部 park 住（实测 11 个 worker 全挂在 recv 上），
    // 连后续命令都没机会被调度，形成事实上的自锁。
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let queued_at = Instant::now();
        let cancellation_token = CancellationToken::new(version);
        let (reply_tx, reply_rx) = bounded::<Result<MultiOutcome>>(1);
        if let Err(e) = io.search_tx.send(SearchJob {
            query: query.clone(),
            options,
            cancellation_token,
            reply: reply_tx,
        }) {
            error!(version, error = ?e, "搜索请求投递失败");
            return Err(format!("search_dispatch_failed: {e}"));
        }

        match reply_rx.recv_timeout(SEARCH_TIMEOUT) {
            Ok(result) => {
                debug!(
                    version,
                    queue_wait_ms = queued_at.elapsed().as_millis() as u64,
                    "搜索结果已返回"
                );
                Ok(result)
            }
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                warn!(
                    version,
                    timeout_ms = SEARCH_TIMEOUT.as_millis() as u64,
                    "搜索等待超时：后台事件循环可能正被扫描占满"
                );
                Err("search_timeout".to_string())
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                error!(version, "搜索工作线程已退出（result 通道断开）");
                Err("search_worker_gone".to_string())
            }
        }
    })
    .await;

    // 展开两层 Result：外层是任务调度结果，内层是搜索本身的成败。
    let outcome: Result<MultiOutcome, anyhow::Error> = match joined {
        Ok(Ok(result)) => result,
        Ok(Err(message)) => return Err(message),
        Err(error) => {
            error!(version, error = ?error, "搜索任务加入失败");
            return Err(format!("search_join_failed: {error}"));
        }
    };

    let elapsed_ms = started.elapsed().as_millis() as u64;
    let limit = options.limit.unwrap_or(DEFAULT_SEARCH_LIMIT).max(1);
    let offset = options.offset.unwrap_or(0);
    let response = outcome
        .map(|MultiOutcome { nodes, highlights }| {
            let all = match nodes {
                Some(list) => list,
                None => {
                    info!(version, elapsed_ms, query = %query_for_log, "搜索被取消");
                    Vec::new()
                }
            };
            let total = all.len();
            let results: Vec<GlobalIndex> = all.into_iter().skip(offset).take(limit).collect();
            info!(
                version,
                elapsed_ms,
                hits = results.len(),
                query = %query_for_log,
                "搜索完成"
            );
            SearchResponse {
                results,
                total,
                highlights,
            }
        })
        .map_err(|e| {
            let raw = format!("{e:?}");
            // `index_building` / `search_timeout` 是前端要分支处理的控制码，
            // 套上 `search_failed:` 前缀会让精确匹配失效，最终被当成普通失败。
            let is_control_code = raw == "index_building" || raw == "search_timeout";
            if !is_control_code {
                warn!(
                    version,
                    elapsed_ms,
                    query = %query_for_log,
                    error = %raw,
                    "搜索执行出错"
                );
                return format!("search_failed: {raw}");
            }
            info!(
                version,
                elapsed_ms,
                query = %query_for_log,
                code = %raw,
                "搜索返回控制码"
            );
            raw
        })?;
    Ok(response)
}

#[tauri::command(async)]
pub fn get_nodes_info(
    results: Vec<GlobalIndex>,
    include_icons: Option<bool>,
    state: State<'_, SearchState>,
) -> Vec<NodeInfo> {
    if results.is_empty() {
        return Vec::new();
    }

    let include_icons = include_icons.unwrap_or(true);
    let nodes = state.request_nodes(results);

    nodes
        .into_iter()
        .map(|SearchResultNode { path, metadata }| {
            let path = path.to_string_lossy().into_owned();
            let icon = if include_icons {
                fs_icon::icon_of_path_ns(&path).map(|data| {
                    format!(
                        "data:image/png;base64,{}",
                        general_purpose::STANDARD.encode(data)
                    )
                })
            } else {
                None
            };
            NodeInfo {
                path,
                icon,
                metadata: metadata.as_ref().map(NodeInfoMetadata::from_metadata),
            }
        })
        .collect()
}

#[tauri::command(async)]
pub fn get_sorted_view(
    results: Vec<GlobalIndex>,
    sort: Option<SortStatePayload>,
    state: State<'_, SearchState>,
) -> Vec<GlobalIndex> {
    if results.is_empty() || sort.is_none() {
        return results;
    }

    let sort_state = sort.expect("checked above");
    let nodes = state.fetch_sorted_nodes(&results);
    let mut entries: Vec<SortEntry> = results
        .into_iter()
        .zip(nodes)
        .map(|(slab_index, node)| SortEntry::new(slab_index, node))
        .collect();

    sort_entries(&mut entries, &sort_state);

    entries.into_iter().map(|entry| entry.slab_index).collect()
}

#[tauri::command(async)]
pub fn update_icon_viewport(id: u64, viewport: Vec<GlobalIndex>, state: State<'_, SearchState>) {
    if let Err(e) = state.icon_viewport_tx.send((id, viewport)) {
        error!("Failed to send icon viewport update: {e:?}");
    }
}

#[tauri::command]
pub async fn get_app_status() -> String {
    let state = load_app_state().as_str().to_string();
    // 前端在索引就绪后要补一次搜索，靠轮询这个命令判断时机；没有日志就
    // 无法区分「轮询没跑」和「状态没变」。
    info!(state = %state, "app 状态查询");
    state
}

#[tauri::command(async)]
pub fn trigger_rescan(state: State<'_, SearchState>) {
    if let Err(e) = state.rescan_tx.send(CancellationToken::new_scan()) {
        error!("Failed to request rescan: {e:?}");
    }
}

#[tauri::command(async)]
pub fn set_watch_config(
    watch_root: String,
    watch_roots: Option<Vec<String>>,
    ignore_paths: Vec<String>,
    state: State<'_, SearchState>,
) {
    let Some((watch_root, ignore_paths)) = normalize_watch_config(&watch_root, ignore_paths, None)
    else {
        warn!("Ignoring invalid watch_root: {watch_root:?}");
        return;
    };

    if let Err(e) = state.watch_config_tx.send(WatchConfigUpdate {
        watch_roots: watch_roots.unwrap_or_default(),
        watch_root,
        ignore_paths,
        scan_cancellation_token: CancellationToken::new_scan(),
    }) {
        error!("Failed to request watch config change: {e:?}");
    }
}

#[tauri::command]
pub async fn open_in_finder(path: String) {
    if let Err(e) = Command::new("open").arg("-R").arg(&path).spawn() {
        error!("Failed to reveal path in Finder: {e}");
    }
}

#[tauri::command]
pub async fn open_path(path: String) {
    if let Err(e) = Command::new("open").arg(&path).spawn() {
        error!("Failed to open path: {e}");
    }
}

#[tauri::command]
pub async fn start_logic(
    watch_root: String,
    watch_roots: Option<Vec<String>>,
    ignore_paths: Vec<String>,
) {
    info!(
        watch_root = %watch_root,
        ignore_count = ignore_paths.len(),
        "收到前端启动配置"
    );
    let Some(sender) = LOGIC_START.get() else {
        error!("LOGIC_START 尚未初始化，启动配置被丢弃");
        return;
    };
    match sender.try_send(LogicStartConfig {
        watch_roots: watch_roots.unwrap_or_default(),
        watch_root,
        ignore_paths,
    }) {
        Ok(()) => info!("启动配置已投递到后台线程"),
        Err(error) => error!(?error, "启动配置投递失败"),
    }
}

#[tauri::command]
pub async fn hide_main_window(app: AppHandle) {
    hide_main_window_impl(&app);
}

#[tauri::command]
pub async fn activate_main_window(app: AppHandle) {
    activate_main_window_impl(&app);
}

#[tauri::command]
pub async fn toggle_main_window(app: AppHandle) {
    toggle_main_window_impl(&app);
}

#[tauri::command]
pub async fn set_tray_activation_policy(app: AppHandle, enabled: bool, silent: Option<bool>) {
    let app_handle = app.clone();
    let should_activate = !silent.unwrap_or(false);
    if let Err(e) = app.run_on_main_thread(move || {
        // 始终使用 Regular：Accessory（无 Dock 图标）的 app 不参与
        // app switching，`NSApp.activate` 也不会把它变成前台 app，导致
        // `Cmd+W` 这类系统菜单命令仍然发给上一个前台 app（关掉的是身后
        // 窗口）。托盘图标本身仍由 `enabled` 控制，与激活策略解耦。
        let _ = enabled;
        let policy = ActivationPolicy::Regular;
        if let Err(e) = app_handle.set_activation_policy(policy) {
            error!("Failed to set activation policy: {e:?}");
        }
        if should_activate {
            activate_main_window_impl(&app_handle);
        }
    }) {
        error!("Failed to dispatch activation policy update: {e:?}");
    }
}

#[tauri::command]
pub async fn copy_files_to_clipboard(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }

    if let Err(err) = copy_files_to_clipboard_impl(paths) {
        error!("Failed to copy files to clipboard: {err:?}");
    }
}

fn copy_files_to_clipboard_impl(paths: Vec<String>) -> Result<()> {
    autoreleasepool(|_| unsafe {
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();

        let urls: Vec<Retained<NSURL>> = paths
            .iter()
            .map(|path| NSURL::fileURLWithPath(&NSString::from_str(path)))
            .collect();

        let path_strings = NSPasteboardItem::new();
        {
            let ns_path = NSString::from_str(&paths.join(" "));
            path_strings.setString_forType(&ns_path, NSPasteboardTypeString);
        }

        let objects: Vec<&ProtocolObject<dyn NSPasteboardWriting>> = urls
            .iter()
            .map(|url| ProtocolObject::from_ref(&**url))
            .chain(Some(ProtocolObject::from_ref(&*path_strings)))
            .collect();
        let array = NSArray::from_slice(&objects);
        if pasteboard.writeObjects(&array) {
            Ok(())
        } else {
            Err(anyhow!("NSPasteboard.writeObjects failed"))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_rejects_empty_input() {
        assert_eq!(normalize_path_input(""), None);
        assert_eq!(normalize_path_input("   "), None);
    }

    #[test]
    fn normalize_accepts_absolute_paths() {
        assert_eq!(normalize_path_input("/"), Some("/".to_string()));
        assert_eq!(
            normalize_path_input(" /var/log "),
            Some("/var/log".to_string())
        );
    }

    #[test]
    fn normalize_expands_tilde_when_home_available() {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        assert_eq!(normalize_path_input("~"), Some(home.clone()));
        assert_eq!(
            normalize_path_input("~/Documents"),
            Some(format!("{home}/Documents"))
        );
    }

    #[test]
    fn normalize_rejects_relative_paths_and_tilde_users() {
        assert_eq!(normalize_path_input("relative/path"), None);
        assert_eq!(normalize_path_input("./relative"), None);
        assert_eq!(normalize_path_input("~someone"), None);
        assert_eq!(normalize_path_input("~someone/Documents"), None);
    }

    #[test]
    fn normalize_ignore_pattern_accepts_absolute_home_and_glob_patterns() {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };

        assert_eq!(
            normalize_ignore_pattern_input("**/node_modules"),
            Some("**/node_modules".to_string())
        );
        assert_eq!(
            normalize_ignore_pattern_input("Library/**/Cache"),
            Some("Library/**/Cache".to_string())
        );
        assert_eq!(
            normalize_ignore_pattern_input("~/Library/**"),
            Some(format!("{home}/Library/**"))
        );
        assert_eq!(
            normalize_ignore_pattern_input("/Users/*/.git"),
            Some("/Users/*/.git".to_string())
        );
    }

    #[test]
    fn normalize_ignore_pattern_rejects_relative_dot_and_tilde_user_forms() {
        assert_eq!(normalize_ignore_pattern_input("./tmp"), None);
        assert_eq!(normalize_ignore_pattern_input("../tmp"), None);
        assert_eq!(normalize_ignore_pattern_input("~someone/tmp"), None);
    }
}
