#![feature(str_from_raw_parts)]
use core::str;
use parking_lot::Mutex;
use rayon::prelude::*;
use regex::Regex;
use search_cancel::CancellationToken;
use std::collections::BTreeSet;

pub struct NamePool {
    inner: Mutex<BTreeSet<Box<str>>>,
}

impl std::fmt::Debug for NamePool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamePool")
            .field("len", &self.len())
            .finish()
    }
}

impl Default for NamePool {
    fn default() -> Self {
        Self::new()
    }
}

impl NamePool {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(BTreeSet::new()),
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }

    /// This function add a name into last cache line, if the last cache line is
    /// full, a new cache line will be added.
    ///
    /// # Panic
    ///
    /// This function will panic if a new CacheLine cannot hold the given name.
    ///
    /// Returns (line_num, str_offset)
    ///
    /// One important feature of NamePool is that the returned offset is stable
    /// and won't be overwritten.
    pub fn push<'c>(&'c self, name: &str) -> &'c str {
        let mut inner = self.inner.lock();
        if !inner.contains(name) {
            inner.insert(name.into());
        }
        let existing = inner.get(name).unwrap();
        unsafe { str::from_raw_parts(existing.as_ptr(), existing.len()) }
    }

    /// 并行扫描名称池时的分块大小。
    ///
    /// 必须能整除 [`search_cancel::CANCEL_CHECK_INTERVAL`]（0x10000），
    /// 这样每块起点 `chunk_index * NAME_SCAN_CHUNK` 都是元素在池中的真实索引，
    /// 取消检查的密度与单线程遍历时完全一致。
    const NAME_SCAN_CHUNK: usize = 4096;

    /// 一次性取出名称地址快照，然后并行扫描。
    ///
    /// 旧实现是 `for x in self.inner.lock().iter()` 的单线程线性扫描：锁在整个扫描期间
    /// 被持有，且 `BTreeSet` 的指针追逐成为瓶颈。这里改为：
    ///
    /// 1. 持锁一次，把每个 `Box<str>` 的堆缓冲地址与长度拷成 `Vec`（顺序写、开销很小），
    ///    随后立即释放锁，避免长时间阻塞 `push()`；
    /// 2. 用 rayon 按块并行扫描，每个元素仍然用**它在池中的真实位置**调用
    ///    `is_cancelled_sparse`，取消语义与顺序实现逐元素一致；
    /// 3. 结果合并回 `BTreeSet<&str>`，与顺序实现返回完全相同的匹配集合（顺序也一致）。
    ///
    /// 安全性：`NamePool` 只插入不删除、名称内容永不修改（这正是 `push()` 返回稳定
    /// `&str` 的既有前提），所以已快照的堆地址在扫描期间始终有效。
    fn search_parallel<'pool>(
        &'pool self,
        min_len: usize,
        cancellation_token: CancellationToken,
        predicate: impl Fn(&str) -> bool + Sync,
    ) -> Option<BTreeSet<&'pool str>> {
        let snapshot: Vec<(usize, usize)> = {
            let inner = self.inner.lock();
            inner
                .iter()
                .map(|name| (name.as_ptr() as usize, name.len()))
                .collect()
        };

        if snapshot.is_empty() {
            // 空池：与旧实现一致，返回空集合（即使 token 已取消）。
            return Some(BTreeSet::new());
        }

        // 旧实现会在索引 0 处先检查一次取消，这里保持同样的快速返回。
        cancellation_token.is_cancelled_sparse(0)?;

        snapshot
            .par_chunks(Self::NAME_SCAN_CHUNK)
            .enumerate()
            .try_fold(BTreeSet::new, |mut matched, (chunk_index, chunk)| {
                let chunk_start = chunk_index * Self::NAME_SCAN_CHUNK;
                for (offset, &(address, len)) in chunk.iter().enumerate() {
                    // 索引必须是元素在池中的真实位置（chunk_start + offset）。
                    cancellation_token.is_cancelled_sparse(chunk_start + offset)?;
                    if len < min_len {
                        continue;
                    }
                    // SAFETY: 地址来自 `NamePool` 内部的 `Box<str>` 堆缓冲；池只增不删，
                    // 字符串内容不会被修改或释放，因此这里重建的 `&'pool str` 有效。
                    let name: &'pool str =
                        unsafe { str::from_raw_parts(address as *const u8, len) };
                    if predicate(name) {
                        matched.insert(name);
                    }
                }
                Some(matched)
            })
            .try_reduce(BTreeSet::new, |mut left, right| {
                left.extend(right);
                Some(left)
            })
    }

    pub fn search_substr<'search, 'pool: 'search>(
        &'pool self,
        substr: &'search str,
        cancellation_token: CancellationToken,
    ) -> Option<BTreeSet<&'pool str>> {
        self.search_parallel(substr.len(), cancellation_token, |name| {
            name.contains(substr)
        })
    }

    pub fn search_suffix<'search, 'pool: 'search>(
        &'pool self,
        suffix: &'search str,
        cancellation_token: CancellationToken,
    ) -> Option<BTreeSet<&'pool str>> {
        self.search_parallel(suffix.len(), cancellation_token, |name| {
            name.ends_with(suffix)
        })
    }

    pub fn search_prefix<'search, 'pool: 'search>(
        &'pool self,
        prefix: &'search str,
        cancellation_token: CancellationToken,
    ) -> Option<BTreeSet<&'pool str>> {
        self.search_parallel(prefix.len(), cancellation_token, |name| {
            name.starts_with(prefix)
        })
    }

    pub fn search_regex<'search, 'pool: 'search>(
        &'pool self,
        pattern: &Regex,
        cancellation_token: CancellationToken,
    ) -> Option<BTreeSet<&'pool str>> {
        self.search_parallel(0, cancellation_token, |name| pattern.is_match(name))
    }

    // `exact` should starts with a '\0', and ends with a '\0',
    // e.g. b"\0hello\0"
    pub fn search_exact<'search, 'pool: 'search>(
        &'pool self,
        exact: &'search str,
        cancellation_token: CancellationToken,
    ) -> Option<BTreeSet<&'pool str>> {
        self.search_parallel(exact.len(), cancellation_token, |name| name == exact)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn guard<T>(value: Option<T>) -> T {
        value.expect("noop cancellation should not trigger")
    }

    fn substr<'pool>(pool: &'pool NamePool, needle: &str) -> BTreeSet<&'pool str> {
        guard(pool.search_substr(needle, CancellationToken::noop()))
    }

    fn suffix_search<'pool>(pool: &'pool NamePool, needle: &str) -> BTreeSet<&'pool str> {
        guard(pool.search_suffix(needle, CancellationToken::noop()))
    }

    fn prefix_search<'pool>(pool: &'pool NamePool, needle: &str) -> BTreeSet<&'pool str> {
        guard(pool.search_prefix(needle, CancellationToken::noop()))
    }

    fn exact_search<'pool>(pool: &'pool NamePool, needle: &str) -> BTreeSet<&'pool str> {
        guard(pool.search_exact(needle, CancellationToken::noop()))
    }

    fn regex_search<'pool>(pool: &'pool NamePool, pattern: &Regex) -> BTreeSet<&'pool str> {
        guard(pool.search_regex(pattern, CancellationToken::noop()))
    }

    #[test]
    fn test_search_substr_cancelled_returns_none() {
        let pool = NamePool::new();
        pool.push("alpha");
        pool.push("beta");

        let token = CancellationToken::new(1);
        // Move global active version forward so the token becomes cancelled.
        let _ = CancellationToken::new(2);

        assert!(pool.search_substr("a", token).is_none());
    }

    #[test]
    fn test_search_regex_partial_results_cancelled() {
        let pool = NamePool::new();
        for idx in 0..5 {
            pool.push(&format!("item{idx}"));
        }
        let token = CancellationToken::new(10);
        let _ = CancellationToken::new(11);
        let regex = Regex::new("item\\d").unwrap();

        assert!(pool.search_regex(&regex, token).is_none());
    }

    #[test]
    fn test_new() {
        let pool = NamePool::new();
        assert_eq!(pool.len(), 0);
    }

    #[test]
    fn test_push_basic() {
        let pool = NamePool::new();
        let s = pool.push("hello");
        assert_eq!(s, "hello");
    }

    #[test]
    fn test_push_multiple() {
        let pool = NamePool::new();
        let s1 = pool.push("foo");
        let s2 = pool.push("bar");
        let s3 = pool.push("baz");
        assert_eq!(s1, "foo");
        assert_eq!(s2, "bar");
        assert_eq!(s3, "baz");
    }

    #[test]
    fn test_push_empty_string() {
        let pool = NamePool::new();
        let s = pool.push("");
        assert_eq!(s, "");
    }

    #[test]
    fn test_push_unicode() {
        let pool = NamePool::new();
        let s = pool.push("こんにちは");
        assert_eq!(s, "こんにちは");
    }

    #[test]
    fn test_push_deduplication() {
        let pool = NamePool::new();
        let s1 = pool.push("hello");
        let s2 = pool.push("hello");
        assert_eq!(s1, s2);
        assert_eq!(s1, "hello");
    }

    #[test]
    fn test_search_substr() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("hello world");
        pool.push("hello world hello");

        let result = substr(&pool, "hello");
        assert_eq!(result.len(), 3);
        assert!(result.contains("hello"));
        assert!(result.contains("hello world"));
        assert!(result.contains("hello world hello"));
    }

    #[test]
    fn test_search_substr_2() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("hello world");

        let result = substr(&pool, "world");
        assert_eq!(result.len(), 2);
        assert!(result.contains("world"));
        assert!(result.contains("hello world"));
    }

    #[test]
    fn test_search_suffix() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("hello world");

        let suffix = "world";
        let result = suffix_search(&pool, suffix);
        assert_eq!(result.len(), 2);
        assert!(result.contains("world"));
        assert!(result.contains("hello world"));
    }

    #[test]
    fn test_search_prefix() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("hello world");

        let prefix = "hello";
        let result = prefix_search(&pool, prefix);
        assert_eq!(result.len(), 2);
        assert!(result.contains("hello"));
        assert!(result.contains("hello world"));
    }

    #[test]
    fn test_search_exact() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("hello world");

        let exact = "hello";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("hello"));

        let exact = "world";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("world"));
    }

    #[test]
    fn test_search_regex_basic() {
        use regex::Regex;

        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("helloworld");

        let regex = Regex::new("hell.*").unwrap();
        let result = regex_search(&pool, &regex);
        assert_eq!(result.len(), 2);
        assert!(result.contains("hello"));
        assert!(result.contains("helloworld"));
    }

    #[test]
    fn test_search_regex_case_insensitive() {
        use regex::RegexBuilder;

        let pool = NamePool::new();
        pool.push("Alpha");
        pool.push("beta");

        let regex = RegexBuilder::new("alpha")
            .case_insensitive(true)
            .build()
            .unwrap();
        let result = regex_search(&pool, &regex);
        assert_eq!(result.len(), 1);
        assert!(result.contains("Alpha"));
    }

    #[test]
    fn test_search_nonexistent() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");

        let result = substr(&pool, "nonexistent");
        assert!(result.is_empty());

        let result = substr(&pool, "nonexistent");
        assert!(result.is_empty());
    }

    #[test]
    fn test_search_partial_match() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");
        pool.push("hell");

        let result = substr(&pool, "hell");
        assert_eq!(result.len(), 2);
        assert!(result.contains("hello"));
        assert!(result.contains("hell"));
    }

    #[test]
    fn test_search_exact_unicode() {
        let pool = NamePool::new();
        pool.push("こんにちは");
        pool.push("世界");
        pool.push("こんにちは世界");

        let exact = "こんにちは";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("こんにちは"));

        let exact = "世界";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("世界"));

        let exact = "こんにちは世界";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("こんにちは世界"));
    }

    #[test]
    fn test_search_exact_no_overlap() {
        let pool = NamePool::new();
        pool.push("test");
        pool.push("testtest");
        pool.push("testtesttest");

        let exact = "test";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("test"));

        let exact = "testtest";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("testtest"));

        let exact = "testtesttest";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("testtesttest"));
    }

    #[test]
    fn test_search_exact_with_embedded_nulls() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");

        let exact = "\0\0hello\0";
        let result = exact_search(&pool, exact);
        assert!(result.is_empty());

        let exact = "\0hello\0\0";
        let result = exact_search(&pool, exact);
        assert!(result.is_empty());
    }

    #[test]
    fn test_search_exact_boundary_cases() {
        let pool = NamePool::new();
        pool.push("");
        pool.push("a");
        pool.push("ab");

        let exact = "";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains(""));

        let exact = "a";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("a"));

        let exact = "ab";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("ab"));
    }

    #[test]
    fn test_search_exact_similar_strings() {
        let pool = NamePool::new();
        pool.push("test");
        pool.push("testing");
        pool.push("tester");
        pool.push("test123");

        let exact = "test";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("test"));

        let exact = "testing";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("testing"));

        let exact = "tester";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("tester"));

        let exact = "test123";
        let result = exact_search(&pool, exact);
        assert_eq!(result.len(), 1);
        assert!(result.contains("test123"));
    }

    #[test]
    fn test_search_unicode() {
        let pool = NamePool::new();
        pool.push("こんにちは");
        pool.push("世界");
        pool.push("こんにちは世界");

        let result = substr(&pool, "世界");
        assert_eq!(result.len(), 2);
        assert!(result.contains("世界"));
        assert!(result.contains("こんにちは世界"));
    }

    #[test]
    fn test_search_prefix_nonexistent() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");

        let prefix = "nonexistent";
        let result = prefix_search(&pool, prefix);
        assert!(result.is_empty());
    }

    #[test]
    fn test_search_exact_nonexistent() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("world");

        let exact = "nonexistent";
        let result = exact_search(&pool, exact);
        assert!(result.is_empty());
    }

    #[test]
    fn test_dedup_behavior_comparison() {
        let pool = NamePool::new();
        pool.push("hello");
        pool.push("hello world");
        pool.push("hello world hello");

        let substr_result: Vec<_> = substr(&pool, "hello").into_iter().collect();
        assert_eq!(substr_result.len(), 3);

        let exact_result: Vec<_> = exact_search(&pool, "hello").into_iter().collect();
        assert_eq!(exact_result.len(), 1);
        assert_eq!(exact_result[0], "hello");

        let mut unique_results = substr_result.clone();
        unique_results.sort();
        unique_results.dedup();
        assert_eq!(substr_result.len(), unique_results.len());
    }

    #[test]
    fn test_search_exact_performance_assumption() {
        let pool = NamePool::new();
        pool.push("abc");
        pool.push("abcabc");

        let exact = "abc";
        let result: Vec<_> = exact_search(&pool, exact).into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "abc");

        let exact = "abcabc";
        let result: Vec<_> = exact_search(&pool, exact).into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "abcabc");

        let exact = "ab";
        let result: Vec<_> = exact_search(&pool, exact).into_iter().collect();
        assert_eq!(result.len(), 0);
    }

    #[test]
    fn test_boundary_single_char() {
        let pool = NamePool::new();
        pool.push("a");
        let result: Vec<_> = substr(&pool, "a").into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "a");

        let result: Vec<_> = substr(&pool, "a").into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "a");

        pool.push("abc");
        let result: Vec<_> = substr(&pool, "a").into_iter().collect();
        assert_eq!(result.len(), 2);

        let result: Vec<_> = substr(&pool, "b").into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "abc");

        let result: Vec<_> = substr(&pool, "c").into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "abc");
    }

    #[test]
    fn test_boundary_very_long_strings() {
        let pool = NamePool::new();
        let long_string = "a".repeat(500);
        let medium_string = "b".repeat(250);

        pool.push(&long_string);
        pool.push(&medium_string);

        let result: Vec<_> = substr(&pool, "a").into_iter().collect();
        assert_eq!(result.len(), 1);

        let result: Vec<_> = substr(&pool, "b").into_iter().collect();
        assert_eq!(result.len(), 1);

        let middle_substr = "a".repeat(100);
        let result: Vec<_> = substr(&pool, &middle_substr).into_iter().collect();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_boundary_special_characters() {
        let pool = NamePool::new();
        pool.push("hello\nworld");
        pool.push("tab\there");
        pool.push("quote\"here");
        pool.push("backslash\\here");
        pool.push("unicode🚀test");

        let result: Vec<_> = substr(&pool, "hello\nworld").into_iter().collect();
        assert_eq!(result.len(), 1);

        let result: Vec<_> = substr(&pool, "tab\there").into_iter().collect();
        assert_eq!(result.len(), 1);

        let result: Vec<_> = substr(&pool, "quote\"here").into_iter().collect();
        assert_eq!(result.len(), 1);

        let result: Vec<_> = substr(&pool, "backslash\\here").into_iter().collect();
        assert_eq!(result.len(), 1);

        let result: Vec<_> = substr(&pool, "unicode🚀test").into_iter().collect();
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_boundary_overlapping_patterns() {
        let pool = NamePool::new();
        pool.push("aaa");
        pool.push("aaaa");
        pool.push("aaaaa");

        let result: Vec<_> = substr(&pool, "aa").into_iter().collect();
        assert_eq!(result.len(), 3);

        let mut unique_results = result.clone();
        unique_results.sort();
        unique_results.dedup();
        assert_eq!(result.len(), unique_results.len());
    }

    #[test]
    fn test_corner_many_duplicates() {
        let pool = NamePool::new();
        // Push the same string many times
        for _ in 0..100 {
            pool.push("duplicate");
        }
        assert_eq!(pool.len(), 1); // Should only store one unique string

        let result = exact_search(&pool, "duplicate");
        assert_eq!(result.len(), 1);
        assert!(result.contains("duplicate"));
    }

    #[test]
    fn test_corner_capacity_overflow() {
        let pool = NamePool::new();
        // Fill with small strings first
        for i in 0..50 {
            pool.push(&format!("str{i}"));
        }

        // Try to add a very long string that might not fit
        let long_str = "x".repeat(800);
        pool.push(&long_str); // This should succeed as it goes to a new cache line

        let result: Vec<_> = substr(&pool, &long_str).into_iter().collect();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], long_str);
    }

    #[test]
    fn test_corner_exact_boundary_strings() {
        let pool = NamePool::new();
        // Test strings that are exactly at various boundaries
        pool.push(""); // Empty
        pool.push("x"); // Single char
        pool.push("xy"); // Two chars
        pool.push("xyz"); // Three chars

        let result = exact_search(&pool, "");
        assert_eq!(result.len(), 1);
        assert!(result.contains(""));

        let result = exact_search(&pool, "x");
        assert_eq!(result.len(), 1);
        assert!(result.contains("x"));

        let result = exact_search(&pool, "xy");
        assert_eq!(result.len(), 1);
        assert!(result.contains("xy"));

        let result = exact_search(&pool, "xyz");
        assert_eq!(result.len(), 1);
        assert!(result.contains("xyz"));
    }

    #[test]
    fn test_corner_search_longer_than_strings() {
        let pool = NamePool::new();
        pool.push("hi");
        pool.push("hello");

        // Search for pattern longer than any string
        let result = substr(&pool, "helloworld");
        assert!(result.is_empty());

        let result = substr(&pool, "helloworld");
        assert!(result.is_empty());
    }

    #[test]
    fn test_corner_multiple_cache_lines() {
        let pool = NamePool::new();
        // Fill first cache line
        for i in 0..100 {
            pool.push(&format!("line1_{i}"));
        }

        // Add to second cache line
        for i in 0..100 {
            pool.push(&format!("line2_{i}"));
        }

        // Search should work across all cache lines
        let result = substr(&pool, "line1_");
        assert_eq!(result.len(), 100);

        let result = substr(&pool, "line2_");
        assert_eq!(result.len(), 100);

        // Total unique strings
        assert_eq!(pool.len(), 200);
    }

    #[test]
    fn test_corner_prefix_suffix_relationships() {
        let pool = NamePool::new();
        pool.push("a");
        pool.push("ab");
        pool.push("abc");
        pool.push("abcd");

        // Test prefix searches
        let result = prefix_search(&pool, "a");
        assert_eq!(result.len(), 4); // All strings start with "a"

        let result = prefix_search(&pool, "ab");
        assert_eq!(result.len(), 3); // "ab", "abc", "abcd"

        let result = prefix_search(&pool, "abc");
        assert_eq!(result.len(), 2); // "abc", "abcd"

        let result = prefix_search(&pool, "abcd");
        assert_eq!(result.len(), 1); // "abcd"

        // Test suffix searches
        let result = suffix_search(&pool, "d");
        assert_eq!(result.len(), 1); // "abcd"

        let result = suffix_search(&pool, "cd");
        assert_eq!(result.len(), 1); // "abcd"

        let result = suffix_search(&pool, "bcd");
        assert_eq!(result.len(), 1); // "abcd"
    }

    #[test]
    fn test_corner_control_characters() {
        let pool = NamePool::new();
        pool.push("line1\nline2");
        pool.push("tab\there");
        pool.push("null\0byte");
        pool.push("bell\x07sound");

        let result = substr(&pool, "line1\nline2");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "tab\there");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "null\0byte");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "bell\x07sound");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_corner_unicode_edge_cases() {
        let pool = NamePool::new();
        pool.push("café");
        pool.push("naïve");
        pool.push("Москва"); // Cyrillic
        pool.push("東京"); // Japanese
        pool.push("🚀🌟"); // Emojis
        pool.push("e\u{0301}"); // Combining character

        let result = substr(&pool, "café");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "naïve");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "Москва");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "東京");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "🚀🌟");
        assert_eq!(result.len(), 1);

        let result = substr(&pool, "e\u{0301}");
        assert_eq!(result.len(), 1);
    }

    #[test]
    fn test_corner_search_result_deduplication() {
        let pool = NamePool::new();
        pool.push("abab");
        pool.push("ababa");

        // "ab" appears in both strings, but should only be returned once per string
        let result: Vec<_> = substr(&pool, "ab").into_iter().collect();
        assert_eq!(result.len(), 2); // Two strings contain "ab"
        assert!(result.contains(&"abab"));
        assert!(result.contains(&"ababa"));
    }

    #[test]
    fn test_corner_exact_vs_substring() {
        let pool = NamePool::new();
        pool.push("test");
        pool.push("testing");
        pool.push("atestb");

        // Exact search for "test"
        let exact_result = exact_search(&pool, "test");
        assert_eq!(exact_result.len(), 1);
        assert!(exact_result.contains("test"));

        // Substring search for "test"
        let substr_result = substr(&pool, "test");
        assert_eq!(substr_result.len(), 3); // "test", "testing", "atestb"
        assert!(substr_result.contains("test"));
        assert!(substr_result.contains("testing"));
        assert!(substr_result.contains("atestb"));
    }

    #[test]
    fn test_corner_zero_width_strings() {
        let pool = NamePool::new();
        pool.push("");
        pool.push("a");
        pool.push("");

        // Should only have one empty string due to deduplication
        assert_eq!(pool.len(), 2);

        let result = exact_search(&pool, "");
        assert_eq!(result.len(), 1);
        assert!(result.contains(""));
    }

    #[test]
    fn test_corner_large_number_of_small_strings() {
        let pool = NamePool::new();
        // Add many small strings
        for i in 0..1000 {
            pool.push(&i.to_string());
        }

        assert_eq!(pool.len(), 1000);

        // Search for a specific number
        let result = exact_search(&pool, "42");
        assert_eq!(result.len(), 1);
        assert!(result.contains("42"));

        // Search for a pattern that appears in many strings
        let result = substr(&pool, "1");
        assert_eq!(result.len(), 271);
    }
}
