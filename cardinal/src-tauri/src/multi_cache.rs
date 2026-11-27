//! 多根监控：每个监控根持有独立的索引文件，查询时合并。
//!
//! 为什么不是「一个索引装多根」：`SearchCache` 的 `SlabIndex` 是单库内索引，
//! 多根塞进同一库需要改持久化格式（触发全量重建）并给每个节点加归属字段。
//! 改为「一根一库」后，索引格式完全不用动，父子去重、按根删除、按根统计
//! 都变成文件级操作，风险低得多。
//!
//! 代价是搜索要跨库合并，并且需要一层全局索引 [`GlobalIndex`] 来区分
//! 「第几个根的哪个 slab」。合并顺序即监控列表顺序，高优先级根的结果在前。

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
};

use anyhow::Result;
use cardinal_sdk::FsEvent;
use search_cache::{
    HandleFSEError, SearchCache, SearchOptions, SearchOutcome, SearchResultNode, SlabIndex,
};
use search_cancel::CancellationToken;
use tracing::{info, warn};

/// 跨索引定位：`cache_id` 指向 [`MultiCache::slots`] 的下标。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct GlobalIndex {
    pub cache_id: u16,
    pub slab: SlabIndex,
}

/// 线上编码：`高 32 位 = cache_id，低 32 位 = slab`。
///
/// 选 u64 而不是结构体，是为了让前端继续用 `number` 当索引（JS 安全整数上限
/// 2^53，远大于这里的取值范围），这样虚拟列表、图标缓存等处的 key 逻辑一行
/// 都不用改。用 u32 拼则会被单库 1600 万级 slab 索引顶到上限。
impl GlobalIndex {
    pub fn to_wire(self) -> u64 {
        ((self.cache_id as u64) << 32) | u64::from(self.slab.get() as u32)
    }

    pub fn from_wire(raw: u64) -> Self {
        Self {
            cache_id: (raw >> 32) as u16,
            slab: SlabIndex::new((raw & 0xFFFF_FFFF) as usize),
        }
    }
}

impl serde::Serialize for GlobalIndex {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_u64(self.to_wire())
    }
}

impl<'de> serde::Deserialize<'de> for GlobalIndex {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = u64::deserialize(deserializer)?;
        Ok(Self::from_wire(raw))
    }
}

/// 单个监控根的索引。
pub struct CacheSlot {
    pub root: PathBuf,
    pub cache: SearchCache,
}

impl std::fmt::Debug for CacheSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CacheSlot")
            .field("root", &self.root)
            .field("nodes", &self.cache.get_total_files())
            .finish()
    }
}

/// 跨根搜索的结果。
///
/// `nodes: None` 表示被取消（与 [`SearchOutcome`] 语义一致），
/// `Some(vec![])` 表示搜索完成但零命中。
#[derive(Debug)]
pub struct MultiOutcome {
    pub nodes: Option<Vec<GlobalIndex>>,
    pub highlights: Vec<String>,
}

impl MultiOutcome {
    pub fn cancelled() -> Self {
        Self {
            nodes: None,
            highlights: Vec::new(),
        }
    }

}

/// 多根索引容器。
pub struct MultiCache {
    slots: Vec<CacheSlot>,
}

impl MultiCache {
    pub fn new(slots: Vec<CacheSlot>) -> Self {
        Self { slots }
    }

    /// 所有根的节点总数。
    pub fn get_total_files(&self) -> usize {
        self.slots
            .iter()
            .map(|slot| slot.cache.get_total_files())
            .sum()
    }

    /// 忽略规则在各根之间是共享的，取第一个根即可。
    pub fn ignore_paths(&self) -> Box<[PathBuf]> {
        self.slots
            .first()
            .map(|slot| slot.cache.ignore_paths())
            .unwrap_or_default()
    }

    /// 所有根都是 noop 时才算 noop。
    pub fn is_noop(&self) -> bool {
        self.slots.iter().all(|slot| slot.cache.is_noop())
    }

    /// FSEvents 断点续传用的水位，取所有根的最大值。
    pub fn last_event_id(&mut self) -> u64 {
        self.slots
            .iter_mut()
            .map(|slot| slot.cache.last_event_id())
            .max()
            .unwrap_or(0)
    }

    pub fn rescan_count(&self) -> u64 {
        self.slots
            .iter()
            .map(|slot| slot.cache.rescan_count())
            .sum()
    }

    /// 按监控列表顺序依次搜索，合并结果。
    ///
    /// 注意：这里**不做**跨根的全局重排序。单个根内部的排序已经是相关性顺序，
    /// 跨根拼接能保证「高优先级根的结果优先展示」，这正是优先级想要的语义。
    pub fn search_with_options(
        &mut self,
        line: &str,
        options: SearchOptions,
        cancellation_token: CancellationToken,
    ) -> Result<MultiOutcome> {
        let mut merged: Vec<GlobalIndex> = Vec::new();
        let mut highlights = Vec::new();

        for (id, slot) in self.slots.iter_mut().enumerate() {
            let cache_id = id as u16;
            match slot
                .cache
                .search_with_options(line, options, cancellation_token)
            {
                Ok(SearchOutcome {
                    nodes: Some(nodes),
                    highlights: slot_highlights,
                }) => {
                    merged.extend(
                        nodes
                            .into_iter()
                            .map(|slab| GlobalIndex { cache_id, slab }),
                    );
                    highlights.extend(slot_highlights);
                }
                // 任意一个根取消，整体即取消。
                Ok(SearchOutcome { nodes: None, .. }) => return Ok(MultiOutcome::cancelled()),
                Err(error) => return Err(error),
            }
        }

        Ok(MultiOutcome {
            nodes: Some(merged),
            highlights,
        })
    }

    /// 把全局索引展开成可渲染的节点。
    pub fn expand_file_nodes(&mut self, indexes: &[GlobalIndex]) -> Vec<SearchResultNode> {
        let mut expanded = Vec::with_capacity(indexes.len());
        for index in indexes {
            let Some(slot) = self.slots.get_mut(index.cache_id as usize) else {
                warn!(
                    cache_id = index.cache_id,
                    "全局索引指向不存在的根，已跳过"
                );
                continue;
            };
            expanded.extend(
                slot.cache
                    .expand_file_nodes(std::slice::from_ref(&index.slab)),
            );
        }
        expanded
    }

    /// 按路径归属把事件分发给对应根。
    ///
    /// 未命中任何根的事件直接丢弃——这既省 CPU，也避免把「监控范围外」的
    /// 路径写进索引。
    pub fn handle_fs_events(&mut self, events: Vec<FsEvent>) -> Result<(), HandleFSEError> {
        let mut buckets: Vec<Vec<FsEvent>> =
            (0..self.slots.len()).map(|_| Vec::new()).collect();
        let mut dropped = 0usize;

        for event in events {
            match self.slot_for_path(&event.path) {
                Some(id) => buckets[id].push(event),
                None => dropped += 1,
            }
        }

        if dropped > 0 {
            // FSEvents 会持续送来监控范围外的路径（例如整个 `/` 的元数据事件），
            // 每条都打 INFO 会把日志刷爆，因此只记 debug 级明细。
            tracing::debug!(
                dropped,
                total = self.slots.len(),
                "丢弃了不在任何监控根内的事件"
            );
        }

        for (id, batch) in buckets.into_iter().enumerate() {
            if !batch.is_empty() {
                self.slots[id].cache.handle_fs_events(batch)?;
            }
        }

        Ok(())
    }

    /// 路径归属：最长前缀匹配的根。
    fn slot_for_path(&self, path: &Path) -> Option<usize> {
        self.slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| path.starts_with(&slot.root))
            .max_by_key(|(_, slot)| slot.root.as_os_str().len())
            .map(|(id, _)| id)
    }

    /// 全量重扫：每个根各扫一次。
    pub fn rescan(&mut self) {
        for slot in self.slots.iter_mut() {
            info!(root = %slot.root.display(), "开始重扫该根");
            slot.cache.rescan();
        }
    }

    /// 每个根一个索引文件。
    ///
    /// 只有一个根时沿用 `cardinal.db`，保持对既有索引的兼容；多根时按根路径
    /// 哈希出稳定文件名，避免互相覆盖。
    pub fn db_path_for(dir: &Path, root: &Path) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        root.hash(&mut hasher);
        dir.join(format!("cardinal-{:016x}.db", hasher.finish()))
    }

    /// 把所有根落盘。
    ///
    /// 入参沿用调用方持有的数据库**文件**路径：单根时直接写它（保持兼容），
    /// 多根时取其父目录，按根哈希各写一个文件。早期版本把入参当目录用，
    /// 多根下会拼出 `<...>/cardinal.db/cardinal.db` 这种非法路径，导致落盘
    /// 全部失败（日志里的 `Write cache to file failed`）。
    pub fn flush_snapshot_to_file(&mut self, db_path: &Path) -> Result<()> {
        if self.slots.len() == 1 {
            let slot = &mut self.slots[0];
            return slot.cache.flush_snapshot_to_file(db_path);
        }

        let dir = db_path.parent().unwrap_or(db_path);

        // 多根：先把快照写进临时文件，全部成功后再逐个替换，避免中途失败
        // 留下「部分根是新索引、部分是旧索引」的混合状态。
        let mut staged: Vec<(PathBuf, PathBuf)> = Vec::with_capacity(self.slots.len());
        for slot in self.slots.iter_mut() {
            let final_path = Self::db_path_for(dir, &slot.root);
            let temp_path = final_path.with_extension("db.tmp");
            if let Err(error) = slot.cache.flush_snapshot_to_file(&temp_path) {
                for (_, temp) in &staged {
                    let _ = std::fs::remove_file(temp);
                }
                return Err(error);
            }
            staged.push((final_path, temp_path));
        }

        for (final_path, temp_path) in staged {
            std::fs::rename(&temp_path, &final_path)?;
            info!(path = %final_path.display(), "多根索引已落盘");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_path_is_stable_and_distinct_per_root() {
        let dir = Path::new("/tmp/cardinal");
        let a = MultiCache::db_path_for(dir, Path::new("/Users/kdump/project"));
        let b = MultiCache::db_path_for(dir, Path::new("/Users/kdump/project"));
        let c = MultiCache::db_path_for(dir, Path::new("/Volumes/data2"));

        assert_eq!(a, b, "同一路径必须得到同一文件名");
        assert_ne!(a, c, "不同路径不能撞名");
        assert_eq!(a.parent(), Some(dir));
    }
}
