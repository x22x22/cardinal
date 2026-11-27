//! 诊断工具：绕过 Tauri IPC，直接对持久化索引库执行查询并计时。
//!
//! 用途：区分「搜索引擎本身慢」与「IPC / 单线程调度导致的饥饿」。
//!
//! ```text
//! cargo run -p search-cache --example query_bench -- <db> [query...]
//! ```
//!
//! 默认读取本机 Cardinal 的索引库与忽略路径（全盘 `watchRoot = "/"` 配置），
//! 传参可覆盖。

use search_cache::{SearchCache, SearchOptions};
use search_cancel::CancellationToken;
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Instant,
};

static NEVER_STOPPED: AtomicBool = AtomicBool::new(false);

/// 与 `cardinal/src-tauri/src/commands.rs::normalize_watch_config` 落库时一致的忽略路径，
/// 顺序必须一致，否则 `try_read_persistent_cache` 会因忽略路径不匹配而回退到全盘重扫。
fn default_ignore_paths() -> Vec<PathBuf> {
    const RAW: &[&str] = &[
        "/Users/kdump/Library/CloudStorage",
        "/Users/kdump/Library/Biome",
        "/Users/kdump/Library/Caches",
        "/Users/kdump/Library/Logs",
        "/Users/kdump/Library/Metadata",
        "/Library/Caches",
        "/System/Library/Caches",
        "/private/var",
        "/private/tmp",
        "**/node_modules",
        ".git/**",
        "/Users/*/.Trash",
        "/Volumes/data2/data/WeChat/",
        "/Volumes/data2/data/WXWork/",
        "/Volumes/data2/Users/kdump/Library/Containers/com.tencent.WeWorkMac/",
        "/Volumes/data2/Users/kdump/Documents/WXWork/",
        "/System/Volumes/Data",
    ];
    RAW.iter().map(PathBuf::from).collect()
}

fn default_db_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/kdump".to_string());
    Path::new(&home).join("Library/Application Support/com.cardinal.one/cardinal.db")
}

fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let db_path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(default_db_path);
    let queries: Vec<String> = {
        let rest: Vec<String> = args.collect();
        if rest.is_empty() {
            vec!["cardinal".to_string(), "文件夹: cardinal".to_string()]
        } else {
            rest
        }
    };

    let ignore_paths = default_ignore_paths();
    let root = Path::new("/");

    let load_start = Instant::now();
    let mut cache =
        SearchCache::try_read_persistent_cache(root, &db_path, &ignore_paths, &NEVER_STOPPED)?;
    let load_elapsed = load_start.elapsed();
    println!(
        "索引加载: {:?} / 节点数: {} / 库: {}",
        load_elapsed,
        cache.get_total_files(),
        db_path.display()
    );

    for query in &queries {
        let start = Instant::now();
        let outcome = cache.search_with_options(
            query,
            SearchOptions {
                case_insensitive: true,
            },
            CancellationToken::noop(),
        )?;
        let elapsed = start.elapsed();
        let count = outcome.nodes.as_ref().map(|nodes| nodes.len()).unwrap_or(0);
        println!("查询 {:?}: {:?} / 命中 {}", query, elapsed, count);
    }

    Ok(())
}
