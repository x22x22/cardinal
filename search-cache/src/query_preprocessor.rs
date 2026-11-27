use cardinal_syntax::{
    ArgumentKind, ComparisonValue, Expr, Filter, FilterArgument, FilterKind, Query, RangeValue,
    Term,
};
use std::{env, path::Path};

/// 中文过滤器关键字别名表：`中文关键字 -> 英文标准关键字`。
///
/// `cardinal_syntax` 的解析器只把 `[A-Za-z0-9_-]` 组成的关键字识别成过滤器
/// （见 `cardinal_syntax::is_valid_filter_name`），因此 `文件夹:foo` 这类中文输入
/// 会整体退化成普通词项，永远匹配不到文件名。这里在词法解析之后、查询优化之前，
/// 把中文关键字重写成语义等价的英文过滤器，使中文输入与英文输入行为完全一致。
///
/// 右侧必须是 `cardinal_syntax::FilterKind::from_name` 认识的关键字，
/// 否则会退化成 `FilterKind::Custom` 并在求值时报错。
const CHINESE_FILTER_ALIASES: &[(&str, &str)] = &[
    // 文件夹（folder 类型过滤，参数可选）
    ("文件夹", "folder"),
    ("文件夹名", "folder"),
    ("文件夹类型", "folder"),
    // 目录 == dir（Everything 里 dir 与 parent 同级：仅直接子项）
    ("目录", "dir"),
    // 文件
    ("文件", "file"),
    ("文件名", "file"),
    // 类型 / 扩展名
    ("类型", "type"),
    ("后缀", "ext"),
    ("扩展名", "ext"),
    // 路径（英文 path 的现有语义即 infolder：递归包含）
    ("路径", "path"),
    ("在", "path"),
    // 正则（整体切换为正则模式，不走过滤器）
    ("正则", "regex"),
    // 大小 / 日期（英文没有单独的 date 关键字，日期默认对齐修改日期 dm）
    ("大小", "size"),
    ("日期", "dm"),
    ("修改日期", "dm"),
    ("创建日期", "dc"),
];

/// 查中文关键字对应的英文标准关键字。
fn chinese_filter_alias(name: &str) -> Option<&'static str> {
    CHINESE_FILTER_ALIASES
        .iter()
        .find_map(|(chinese, english)| (*chinese == name).then_some(*english))
}

/// 把形如 `文件夹:cardinal`、`文件夹:` 的中文词项重新解释成标准词项。
///
/// 通过 `cardinal_syntax::parse_query` 重新解析重写后的文本，从而复用官方解析器对
/// `ArgumentKind`（`Bare` / `Phrase` / `List` / `Range` / `Comparison`）的分类，
/// 保证 `扩展名:jpg;png`、`大小:>1GB`、`正则:^foo` 等与英文写法逐字段等价。
fn aliased_term(word: &str) -> Option<Term> {
    let (name, rest) = word.split_once(':')?;
    let english = chinese_filter_alias(name)?;
    let mut rebuilt = String::with_capacity(english.len() + 1 + rest.len());
    rebuilt.push_str(english);
    rebuilt.push(':');
    rebuilt.push_str(rest);
    match cardinal_syntax::parse_query(&rebuilt) {
        Ok(Query {
            expr: Expr::Term(term),
        }) => Some(term),
        _ => None,
    }
}

fn normalize_filter_aliases_expr(expr: Expr) -> Expr {
    match expr {
        Expr::Empty => Expr::Empty,
        Expr::Term(Term::Word(word)) => match aliased_term(&word) {
            Some(term) => Expr::Term(term),
            None => Expr::Term(Term::Word(word)),
        },
        Expr::Term(term) => Expr::Term(term),
        Expr::Not(inner) => Expr::Not(Box::new(normalize_filter_aliases_expr(*inner))),
        Expr::And(parts) => Expr::And(
            parts
                .into_iter()
                .map(normalize_filter_aliases_expr)
                .collect(),
        ),
        Expr::Or(parts) => Expr::Or(
            parts
                .into_iter()
                .map(normalize_filter_aliases_expr)
                .collect(),
        ),
    }
}

/// 把表达式树里的中文过滤器关键字重写为英文标准关键字（幂等）。
fn normalize_filter_aliases(mut query: Query) -> Query {
    query.expr = normalize_filter_aliases_expr(query.expr);
    query
}

#[cfg(test)]
pub(crate) fn expand_query_home_dirs(query: Query) -> Query {
    let Some(home) = home_dir() else { return query };
    expand_query_home_dirs_with_home_and_root(query, &home, None)
}

#[cfg(test)]
fn expand_query_home_dirs_with_home(query: Query, home: &str) -> Query {
    expand_query_home_dirs_with_home_and_root(query, home, None)
}

pub(crate) fn resolve_query_paths(query: Query, root: &Path) -> Query {
    // 即使没有 home 目录可用，也必须在路径解析前完成中文别名重写。
    let mut query = normalize_filter_aliases(query);
    if let Some(home) = home_dir() {
        query = expand_query_home_dirs_with_home_and_root(query, &home, None);
    }
    query.expr = resolve_expr_paths(query.expr, root);
    query
}

fn expand_query_home_dirs_with_home_and_root(
    mut query: Query,
    home: &str,
    root: Option<&Path>,
) -> Query {
    // 中文过滤器关键字必须先重写，之后的 `~` 展开与相对路径解析才会作用在
    // 正确的过滤器参数上（例如 `路径:~/src` -> `infolder:~/src` -> `/Users/.../src`）。
    query = normalize_filter_aliases(query);
    if !home.is_empty() {
        query.expr = expand_expr(query.expr, home);
    }
    if let Some(root) = root {
        query.expr = resolve_expr_paths(query.expr, root);
    }
    query
}

fn expand_expr(expr: Expr, home: &str) -> Expr {
    match expr {
        Expr::Empty => Expr::Empty,
        Expr::Term(term) => Expr::Term(expand_term(term, home)),
        Expr::Not(inner) => Expr::Not(Box::new(expand_expr(*inner, home))),
        Expr::And(parts) => Expr::And(
            parts
                .into_iter()
                .map(|part| expand_expr(part, home))
                .collect(),
        ),
        Expr::Or(parts) => Expr::Or(
            parts
                .into_iter()
                .map(|part| expand_expr(part, home))
                .collect(),
        ),
    }
}

fn expand_term(term: Term, home: &str) -> Term {
    match term {
        Term::Word(word) => Term::Word(expand_text_unquoted(word, home)),
        Term::Filter(filter) => Term::Filter(expand_filter(filter, home)),
        // Don't expand when ~ is quoted or in regex
        Term::Regex(pattern) => Term::Regex(pattern),
    }
}

fn expand_text_unquoted(value: String, home: &str) -> String {
    let mut result = String::with_capacity(value.len());
    let mut in_quotes = false;
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch == '"' {
            in_quotes = !in_quotes;
            result.push(ch);
        } else if ch == '~' && !in_quotes {
            // Check if followed by / or \ (or at end of string)
            match chars.peek() {
                Some(&'/') | Some(&'\\') => {
                    result.push_str(home);
                }
                None => {
                    result.push_str(home);
                }
                _ => {
                    result.push(ch);
                }
            }
        } else {
            result.push(ch);
        }
    }

    result
}

pub(crate) fn strip_query_quotes(mut query: Query) -> Query {
    query.expr = strip_expr_quotes(query.expr);
    query
}

fn strip_expr_quotes(expr: Expr) -> Expr {
    match expr {
        Expr::Empty => Expr::Empty,
        Expr::Term(term) => Expr::Term(strip_term_quotes(term)),
        Expr::Not(inner) => Expr::Not(Box::new(strip_expr_quotes(*inner))),
        Expr::And(parts) => Expr::And(parts.into_iter().map(strip_expr_quotes).collect()),
        Expr::Or(parts) => Expr::Or(parts.into_iter().map(strip_expr_quotes).collect()),
    }
}

fn strip_term_quotes(term: Term) -> Term {
    match term {
        Term::Word(word) => Term::Word(strip_query_quotes_text(&word)),
        Term::Filter(mut filter) => {
            if let Some(arg) = &mut filter.argument {
                arg.raw = strip_query_quotes_text(&arg.raw);
                // Also strip quotes from list values
                if let ArgumentKind::List(values) = &mut arg.kind {
                    *values = values.iter().map(|v| strip_query_quotes_text(v)).collect();
                }
            }
            Term::Filter(filter)
        }
        Term::Regex(pattern) => Term::Regex(pattern),
    }
}

pub(crate) fn strip_query_quotes_text(value: &str) -> String {
    if !value.contains('"') && !value.contains('\\') {
        return value.to_string();
    }

    let mut result = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek().copied() {
                Some('\\') | Some('"') => {
                    result.push(chars.next().expect("peeked value exists"));
                }
                _ => result.push(ch),
            }
        } else if ch != '"' {
            result.push(ch);
        }
    }
    result
}

fn resolve_expr_paths(expr: Expr, root: &Path) -> Expr {
    match expr {
        Expr::Empty => Expr::Empty,
        Expr::Term(term) => Expr::Term(resolve_term_paths(term, root)),
        Expr::Not(inner) => Expr::Not(Box::new(resolve_expr_paths(*inner, root))),
        Expr::And(parts) => Expr::And(
            parts
                .into_iter()
                .map(|part| resolve_expr_paths(part, root))
                .collect(),
        ),
        Expr::Or(parts) => Expr::Or(
            parts
                .into_iter()
                .map(|part| resolve_expr_paths(part, root))
                .collect(),
        ),
    }
}

fn resolve_term_paths(term: Term, root: &Path) -> Term {
    match term {
        Term::Word(word) => Term::Word(resolve_word_path(word, root)),
        Term::Filter(filter) => Term::Filter(resolve_filter_paths(filter, root)),
        Term::Regex(pattern) => Term::Regex(pattern),
    }
}

fn resolve_word_path(word: String, _root: &Path) -> String {
    // 词项里的路径一律**不**和监控根拼接：拼接会把首段固定成监控根自己的目录名，
    // 后续段也退化成 Exact，于是 `foo/bar` 匹配不到 `dirfoo/bar`、
    // `anchor/x*/y` 匹配不到 `work-anchor/x-release/y`。
    // 交给分词器按路径段处理（首段后缀、末段前缀），才符合「路径片段搜索」的直觉。
    // 需要锚定到某个目录时用 `infolder:` / `parent:` 这类过滤器。
    word
}

#[allow(dead_code)]
fn should_resolve_relative_path(value: &str) -> bool {
    let trimmed = strip_wrapping_quotes(value);
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') || trimmed.starts_with("\\\\") {
        return false;
    }
    if is_windows_absolute_path(trimmed) {
        return false;
    }
    // 通配符写法不是真实文件路径，不能拿去和监控根拼接拼接；
    // 交给分词器按「路径段」处理（`anchor/mid_re*/goal.txt` 里的 `*` 是段内通配）。
    if trimmed.contains('*') || trimmed.contains('?') {
        return false;
    }
    // 以 `/` 结尾是「目录后缀」搜索语法（`oo.rs/` 表示名字以 oo.rs 结尾的节点），
    // 同样不是相对路径。
    if trimmed.ends_with('/') {
        return false;
    }
    trimmed.contains('/') || trimmed.contains('\\')
}

fn resolve_filter_paths(mut filter: Filter, root: &Path) -> Filter {
    if filter_requires_path(&filter.kind)
        && let Some(argument) = filter.argument.as_mut()
        && should_resolve_relative_filter_path(&argument.raw)
    {
        argument.raw = root.join(&argument.raw).to_string_lossy().into_owned();
    }
    filter
}

/// 去掉包裹整个值的成对引号（`parent:"/a/b"` 的 raw 会保留引号，
/// 直接拿它做 `starts_with('/')` 判断会把绝对路径误判成相对路径）。
fn strip_wrapping_quotes(value: &str) -> &str {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        let last = bytes[bytes.len() - 1];
        if (first == b'"' || first == b'\'') && last == first {
            return trimmed[1..trimmed.len() - 1].trim();
        }
    }
    trimmed
}

fn should_resolve_relative_filter_path(value: &str) -> bool {
    let trimmed = strip_wrapping_quotes(value);
    if trimmed.is_empty() {
        return false;
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') || trimmed.starts_with("\\\\") {
        return false;
    }
    !is_windows_absolute_path(trimmed)
}

fn is_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn expand_filter(mut filter: Filter, home: &str) -> Filter {
    if filter_requires_path(&filter.kind)
        && let Some(argument) = filter.argument.as_mut()
    {
        expand_filter_argument(argument, home);
    }
    filter
}

fn filter_requires_path(kind: &FilterKind) -> bool {
    // Only expand filters whose semantics require filesystem-like paths.
    matches!(
        kind,
        FilterKind::Parent | FilterKind::InFolder | FilterKind::NoSubfolders
    )
}

fn expand_filter_argument(argument: &mut FilterArgument, home: &str) {
    let raw = std::mem::take(&mut argument.raw);
    argument.raw = expand_text(raw, home);
    match &mut argument.kind {
        ArgumentKind::Bare | ArgumentKind::Phrase => {}
        ArgumentKind::List(values) => {
            for value in values.iter_mut() {
                if let Some(expanded) = expand_home_prefix(value, home) {
                    *value = expanded;
                }
            }
        }
        ArgumentKind::Range(range) => expand_range(range, home),
        ArgumentKind::Comparison(value) => expand_comparison(value, home),
    }
}

fn expand_range(range: &mut RangeValue, home: &str) {
    if let Some(start) = range.start.as_mut()
        && let Some(expanded) = expand_home_prefix(start, home)
    {
        *start = expanded;
    }
    if let Some(end) = range.end.as_mut()
        && let Some(expanded) = expand_home_prefix(end, home)
    {
        *end = expanded;
    }
}

fn expand_comparison(value: &mut ComparisonValue, home: &str) {
    if let Some(expanded) = expand_home_prefix(&value.value, home) {
        value.value = expanded;
    }
}

fn expand_text(value: String, home: &str) -> String {
    if let Some(expanded) = expand_home_prefix(&value, home) {
        expanded
    } else {
        value
    }
}

fn expand_home_prefix(value: &str, home: &str) -> Option<String> {
    // Support Unix `~/foo` and Windows-equivalent `~\foo` prefixes while
    // leaving other `~` usages (e.g., `~someone`) untouched.
    if !value.starts_with('~') {
        return None;
    }
    let remainder = &value[1..];
    if remainder.is_empty() {
        return Some(home.to_string());
    }
    let mut chars = remainder.chars();
    match chars.next() {
        Some('/' | '\\') => {
            let mut expanded = String::with_capacity(home.len() + remainder.len());
            expanded.push_str(home);
            expanded.push_str(remainder);
            Some(expanded)
        }
        _ => None,
    }
}

fn home_dir() -> Option<String> {
    env::var("HOME").ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use cardinal_syntax::{RangeSeparator, Term, parse_query};
    use std::path::Path;

    fn expand(input: &str, home: &str) -> Query {
        let parsed = parse_query(input).expect("valid query");
        expand_query_home_dirs_with_home(parsed, home)
    }

    fn expand_filter_term(filter: Filter, home: &str) -> Filter {
        let query = Query {
            expr: Expr::Term(Term::Filter(filter)),
        };
        match expand_query_home_dirs_with_home(query, home).expr {
            Expr::Term(Term::Filter(filter)) => filter,
            other => panic!("Expected filter expr, got {other:?}"),
        }
    }

    fn resolve(input: &str, root: &str) -> Query {
        let parsed = parse_query(input).expect("valid query");
        resolve_query_paths(parsed, Path::new(root))
    }

    fn resolve_with_home(input: &str, home: &str, root: &str) -> Query {
        let parsed = parse_query(input).expect("valid query");
        expand_query_home_dirs_with_home_and_root(parsed, home, Some(Path::new(root)))
    }

    #[test]
    fn expands_tilde_in_word_terms() {
        let query = expand("~/code", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/code"),
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn leaves_regular_terms_untouched() {
        let query = expand("docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "docs"),
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn expands_word_with_only_tilde() {
        let query = expand("~", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo"),
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn expands_path_filters() {
        let query = expand("infolder:~/projects", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                assert!(matches!(filter.kind, FilterKind::InFolder));
                let argument = filter.argument.expect("argument");
                assert_eq!(argument.raw, "/Users/demo/projects");
            }
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn ignores_non_path_filters() {
        let query = expand("ext:~", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                assert!(matches!(filter.kind, FilterKind::Ext));
                let argument = filter.argument.expect("argument");
                assert_eq!(argument.raw, "~");
            }
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn expands_nested_boolean_exprs() {
        let query = expand("~/docs OR NOT parent:~/Downloads", "/Users/demo");
        match query.expr {
            Expr::Or(parts) => {
                assert_eq!(parts.len(), 2);
                match &parts[0] {
                    Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/docs"),
                    other => panic!("Unexpected left expr: {other:?}"),
                }
                match &parts[1] {
                    Expr::Not(inner) => match inner.as_ref() {
                        Expr::Term(Term::Filter(filter)) => {
                            assert!(matches!(filter.kind, FilterKind::Parent));
                            let argument = filter.argument.clone().expect("argument");
                            assert_eq!(argument.raw, "/Users/demo/Downloads");
                        }
                        other => panic!("Unexpected NOT target: {other:?}"),
                    },
                    other => panic!("Unexpected right expr: {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn keeps_word_paths_unresolved_for_segment_matching() {
        let root = "/Users/demo/workspace";
        // 词项里的路径不做「拼接到监控根」的处理，保留原样交给分词器按路径段匹配：
        // 首段按后缀、末段按前缀，`src/main.rs` 因此也能命中 `mylib-src/main.rs`。
        // 需要锚定目录时用 `infolder:` / `parent:`。
        for input in ["src/main.rs", "a/b/c.txt", "foo/", "dist/x.dmg"] {
            let query = resolve(input, root);
            match query.expr {
                Expr::Term(Term::Word(word)) => assert_eq!(word, input, "不应被拼接: {input}"),
                other => panic!("Unexpected expr for {input}: {other:?}"),
            }
        }
    }

    /// 通配符与「目录后缀」写法不是真实文件路径，不能和监控根拼接：
    /// 拼接后首段会被固定成监控根的第一层目录，路径段匹配就永远落空。
    #[test]
    fn keeps_pattern_like_word_paths_unresolved() {
        let root = "/Users/demo/workspace";
        for input in [
            "src/**/*.rs",
            "anchor/mid_re*/goal.txt",
            "work-anchor/mid_release/prefix-target*",
            "oo.rs/",
        ] {
            let query = resolve(input, root);
            match query.expr {
                Expr::Term(Term::Word(word)) => {
                    assert_eq!(word, input, "模式写法不应被当作相对路径展开: {input}")
                }
                other => panic!("Unexpected expr for {input}: {other:?}"),
            }
        }
    }

    /// 过滤器参数被引号包裹时，必须先去引号再判断绝对/相对，
    /// 否则 `parent:"/abs"` 会被误判成相对路径并重复拼接监控根。
    #[test]
    fn does_not_prefix_quoted_absolute_filter_paths() {
        let root = Path::new("/Users/demo/workspace");
        for input in [
            r#"parent:"/Users/demo/other""#,
            r#"infolder:"/Users/demo/other""#,
        ] {
            let query = resolve(input, root.to_string_lossy().as_ref());
            let Expr::Term(Term::Filter(filter)) = query.expr else {
                panic!("expected filter for {input}");
            };
            let raw = filter.argument.expect("filter argument").raw;
            assert_eq!(
                raw, r#""/Users/demo/other""#,
                "绝对路径不应拼接监控根: {input}"
            );
        }
    }

    #[test]
    fn resolves_relative_path_filters_against_root() {
        let root = Path::new("/Users/demo/workspace");
        let query = resolve("path:src/components", root.to_string_lossy().as_ref());
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                assert!(matches!(filter.kind, FilterKind::InFolder));
                let argument = filter.argument.expect("argument");
                assert_eq!(argument.raw, root.join("src/components").to_string_lossy());
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn keeps_plain_keywords_unresolved() {
        let query = resolve("report ext:rs", "/Users/demo/workspace");
        match query.expr {
            Expr::And(parts) => {
                assert!(matches!(&parts[0], Expr::Term(Term::Word(word)) if word == "report"));
                let Expr::Term(Term::Filter(filter)) = &parts[1] else {
                    panic!("Expected ext filter");
                };
                assert!(matches!(filter.kind, FilterKind::Ext));
                assert_eq!(filter.argument.as_ref().expect("argument").raw, "rs");
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn leaves_absolute_and_home_paths_untouched_when_resolving() {
        let root = Path::new("/Users/demo/workspace");
        let absolute = resolve("/tmp/logs", root.to_string_lossy().as_ref());
        match absolute.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/tmp/logs"),
            other => panic!("Unexpected expr: {other:?}"),
        }

        let home = resolve_with_home("~/logs", "/Users/demo", "/Users/demo/workspace");
        match home.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/logs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn leaves_tilde_paths_untouched_without_home_dir() {
        let parsed = parse_query("~/logs").expect("valid query");
        let resolved =
            expand_query_home_dirs_with_home_and_root(parsed, "", Some(Path::new("/tmp/root")));
        match resolved.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "~/logs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn does_not_expand_phrases_or_regexes() {
        let phrase = expand("\"~/docs\"", "/Users/demo");
        match phrase.expr {
            Expr::Term(Term::Word(text)) => assert_eq!(text, "\"~/docs\""),
            other => panic!("Unexpected expr: {other:?}"),
        }

        let regex = expand("regex:^~/docs$", "/Users/demo");
        match regex.expr {
            Expr::Term(Term::Regex(pattern)) => assert_eq!(pattern, "^~/docs$"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expands_only_unquoted_leading_tilde() {
        let query = expand("\"\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }

        let query = expand("\"foo\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"foo\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }

        let query = expand("foo~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "foo/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expands_list_arguments() {
        let query = expand("parent:~/src;~/lib", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                let argument = filter.argument.expect("argument");
                match argument.kind {
                    ArgumentKind::List(values) => {
                        assert_eq!(
                            values,
                            vec![
                                String::from("/Users/demo/src"),
                                String::from("/Users/demo/lib"),
                            ]
                        );
                    }
                    other => panic!("Expected list argument, got {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn expands_range_arguments() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: "~..~/scratch".into(),
                kind: ArgumentKind::Range(RangeValue {
                    start: Some("~".into()),
                    end: Some("~/scratch".into()),
                    separator: RangeSeparator::Dots,
                }),
            }),
        };
        let filter = expand_filter_term(filter, "/Users/demo");
        let argument = filter.argument.expect("argument");
        match argument.kind {
            ArgumentKind::Range(range) => {
                assert_eq!(range.start.as_deref(), Some("/Users/demo"));
                assert_eq!(range.end.as_deref(), Some("/Users/demo/scratch"));
            }
            other => panic!("Expected range argument, got {other:?}"),
        }
    }

    #[test]
    fn expands_comparison_arguments() {
        let query = expand("parent:>=~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                let argument = filter.argument.expect("argument");
                match argument.kind {
                    ArgumentKind::Comparison(value) => {
                        assert_eq!(value.value, "/Users/demo/docs");
                    }
                    other => panic!("Expected comparison argument, got {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn expands_windows_style_separators() {
        let query = expand(r"parent:~\\Downloads", r"C:\\Users\\demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                let argument = filter.argument.expect("argument");
                assert_eq!(argument.raw, r"C:\\Users\\demo\\Downloads");
            }
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn ignores_named_home_prefixes() {
        let query = expand("parent:~shared/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                let argument = filter.argument.expect("argument");
                assert_eq!(argument.raw, "~shared/docs");
            }
            other => panic!("Unexpected expr: {other:?}"),
        };
    }

    #[test]
    fn expands_tilde_after_multiple_empty_quotes() {
        let query = expand("\"\"\"\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"\"\"\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn does_not_expand_tilde_in_quoted_section() {
        let query = expand("\"~/docs\"foo", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~/docs\"foo"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expands_tilde_after_closing_quote() {
        let query = expand("\"prefix\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"prefix\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn handles_tilde_after_quote_pairs() {
        // Matched quote pairs before tilde
        let query = expand("\"x\"\"y\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"x\"\"y\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn handles_multiple_tildes_in_value() {
        let query = expand("~/foo/~/bar", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/foo//Users/demo/bar"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn handles_tilde_not_at_start() {
        let query = expand("prefix~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "prefix/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expands_tilde_with_backslash_on_unix() {
        let query = expand(r"~\docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, r"/Users/demo\docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn handles_empty_string() {
        let query = expand("", "/Users/demo");
        assert!(matches!(query.expr, Expr::Empty));
    }

    #[test]
    fn handles_tilde_with_special_characters_after() {
        let query = expand("~+docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "~+docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expands_and_expression_with_mixed_tilde_usage() {
        let query = expand("~/docs AND \"~/quoted\"", "/Users/demo");
        match query.expr {
            Expr::And(parts) => {
                assert_eq!(parts.len(), 2);
                match &parts[0] {
                    Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/docs"),
                    other => panic!("Expected expanded word, got {other:?}"),
                }
                match &parts[1] {
                    Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~/quoted\""),
                    other => panic!("Expected quoted word, got {other:?}"),
                }
            }
            other => panic!("Expected AND expression, got {other:?}"),
        }
    }

    #[test]
    fn handles_complex_quoted_patterns() {
        // Quote open-close-open-close before tilde
        let query = expand("\"a\"\"b\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"a\"\"b\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expands_range_with_only_start() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: "~/start..".into(),
                kind: ArgumentKind::Range(RangeValue {
                    start: Some("~/start".into()),
                    end: None,
                    separator: RangeSeparator::Dots,
                }),
            }),
        };
        let filter = expand_filter_term(filter, "/Users/demo");
        let argument = filter.argument.expect("argument");
        match argument.kind {
            ArgumentKind::Range(range) => {
                assert_eq!(range.start.as_deref(), Some("/Users/demo/start"));
                assert_eq!(range.end, None);
            }
            other => panic!("Expected range argument, got {other:?}"),
        }
    }

    #[test]
    fn expands_range_with_only_end() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: "..~/end".into(),
                kind: ArgumentKind::Range(RangeValue {
                    start: None,
                    end: Some("~/end".into()),
                    separator: RangeSeparator::Dots,
                }),
            }),
        };
        let filter = expand_filter_term(filter, "/Users/demo");
        let argument = filter.argument.expect("argument");
        match argument.kind {
            ArgumentKind::Range(range) => {
                assert_eq!(range.start, None);
                assert_eq!(range.end.as_deref(), Some("/Users/demo/end"));
            }
            other => panic!("Expected range argument, got {other:?}"),
        }
    }

    #[test]
    fn handles_list_with_non_tilde_values() {
        let query = expand("parent:~/src;regular;~/lib", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                let argument = filter.argument.expect("argument");
                match argument.kind {
                    ArgumentKind::List(values) => {
                        assert_eq!(
                            values,
                            vec![
                                String::from("/Users/demo/src"),
                                String::from("regular"),
                                String::from("/Users/demo/lib"),
                            ]
                        );
                    }
                    other => panic!("Expected list argument, got {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn handles_tilde_alone_in_list() {
        let query = expand("parent:~;foo", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                let argument = filter.argument.expect("argument");
                match argument.kind {
                    ArgumentKind::List(values) => {
                        assert_eq!(
                            values,
                            vec![String::from("/Users/demo"), String::from("foo")]
                        );
                    }
                    other => panic!("Expected list argument, got {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn preserves_nosubfolders_filter_tilde() {
        let query = expand("nosubfolders:~/work", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Filter(filter)) => {
                assert!(matches!(filter.kind, FilterKind::NoSubfolders));
                let argument = filter.argument.expect("argument");
                assert_eq!(argument.raw, "/Users/demo/work");
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn handles_deeply_nested_boolean_with_tildes() {
        let query = expand("(~/a OR ~/b) AND NOT (~/c OR ~/d)", "/Users/demo");
        // Just verify it parses and expands without panicking
        match query.expr {
            Expr::And(_) => {} // Expected structure
            other => panic!("Expected AND expression, got {other:?}"),
        }
    }

    #[test]
    fn handles_tilde_in_bare_argument() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: "~/docs".into(),
                kind: ArgumentKind::Bare,
            }),
        };
        let filter = expand_filter_term(filter, "/Users/demo");
        assert_eq!(filter.argument.expect("argument").raw, "/Users/demo/docs");
    }

    #[test]
    fn handles_tilde_in_phrase_argument() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: "~/my documents".into(),
                kind: ArgumentKind::Phrase,
            }),
        };
        let filter = expand_filter_term(filter, "/Users/demo");
        assert_eq!(
            filter.argument.expect("argument").raw,
            "/Users/demo/my documents"
        );
    }

    #[test]
    fn strip_quotes_from_simple_word() {
        let query = parse_query("\"hello\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "hello"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_from_multiple_quoted_sections() {
        let query = parse_query("\"hello\" \"world\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::And(parts) => {
                assert_eq!(parts.len(), 2);
                match &parts[0] {
                    Expr::Term(Term::Word(word)) => assert_eq!(word, "hello"),
                    other => panic!("Unexpected first term: {other:?}"),
                }
                match &parts[1] {
                    Expr::Term(Term::Word(word)) => assert_eq!(word, "world"),
                    other => panic!("Unexpected second term: {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_preserves_filters() {
        let query = parse_query("ext:\"rs\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Filter(_)) => {} // Should remain a filter
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_preserves_regex() {
        let query = parse_query("regex:\"test\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Regex(pattern)) => assert_eq!(pattern, "test"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_from_nested_expressions() {
        let query = parse_query("\"a\" OR NOT \"b\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Or(parts) => {
                assert_eq!(parts.len(), 2);
                match &parts[0] {
                    Expr::Term(Term::Word(word)) => assert_eq!(word, "a"),
                    other => panic!("Unexpected left term: {other:?}"),
                }
                match &parts[1] {
                    Expr::Not(inner) => match inner.as_ref() {
                        Expr::Term(Term::Word(word)) => assert_eq!(word, "b"),
                        other => panic!("Unexpected NOT target: {other:?}"),
                    },
                    other => panic!("Unexpected right expr: {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_handles_quotes_with_content() {
        let query = parse_query("\"a\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "a"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_handles_multiple_quotes_in_word() {
        let query = parse_query("\"hello\"\"world\"").expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "helloworld"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_escaped_quotes() {
        let query = parse_query(r#"\"hello\""#).expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"hello\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_backslashes() {
        let query = parse_query(r#""C:\\path""#).expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, r"C:\path"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_mixed_content_in_word() {
        let query = parse_query(r#""foo\"bar\"baz""#).expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "foo\"bar\"baz"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_preserves_non_escape_sequences() {
        let query = parse_query(r#""a\bc""#).expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "a\\bc"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_multiple_backslashes() {
        let query = parse_query(r#""C\\\\path""#).expect("valid");
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "C\\\\path"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_bare_argument() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: r#""C\\Users\\demo""#.into(),
                kind: ArgumentKind::Bare,
            }),
        };
        let query = Query {
            expr: Expr::Term(Term::Filter(filter)),
        };
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Filter(filter)) => {
                let arg = filter.argument.expect("argument");
                assert_eq!(arg.raw, "C\\Users\\demo".replace("\\\\", "\\"));
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_phrase_argument() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: r#""C\\Users\\demo Documents""#.into(),
                kind: ArgumentKind::Phrase,
            }),
        };
        let query = Query {
            expr: Expr::Term(Term::Filter(filter)),
        };
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Filter(filter)) => {
                let arg = filter.argument.expect("argument");
                assert_eq!(arg.raw, "C\\Users\\demo Documents".replace("\\\\", "\\"));
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn strip_quotes_unescapes_list_argument_values() {
        let filter = Filter {
            kind: FilterKind::InFolder,
            argument: Some(FilterArgument {
                raw: String::new(),
                kind: ArgumentKind::List(vec![r#""C\\path""#.into(), r#""D\\data""#.into()]),
            }),
        };
        let query = Query {
            expr: Expr::Term(Term::Filter(filter)),
        };
        let stripped = strip_query_quotes(query);
        match stripped.expr {
            Expr::Term(Term::Filter(filter)) => {
                let arg = filter.argument.expect("argument");
                match arg.kind {
                    ArgumentKind::List(values) => {
                        assert_eq!(
                            values,
                            vec![
                                "C\\path".replace("\\\\", "\\"),
                                "D\\data".replace("\\\\", "\\"),
                            ]
                        );
                    }
                    other => panic!("Expected list argument, got {other:?}"),
                }
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    // Tests for ~ inside and outside quotes at various positions

    #[test]
    fn tilde_inside_quotes_single_char() {
        // "~" should not expand
        let query = expand("\"~\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_inside_quotes_with_path() {
        // "~/docs" should not expand
        let query = expand("\"~/docs\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~/docs\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_outside_quotes_after() {
        // ~"docs" - tilde at start but followed by quote (not / or \), won't expand
        let query = expand("~\"docs\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "~\"docs\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_inside_quotes_after_content() {
        // "prefix~" - tilde inside quotes but not at start should not expand
        let query = expand("\"prefix~\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"prefix~\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_inside_quotes_midpath() {
        // "prefix~/docs" - tilde not at word start inside quotes
        let query = expand("\"prefix~/docs\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"prefix~/docs\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_surrounded_by_quotes() {
        // prefix"~"suffix - tilde inside quotes with content on both sides
        let query = expand("prefix\"~\"suffix", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "prefix\"~\"suffix"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn quoted_tilde_then_unquoted_suffix() {
        // "~"suffix - quoted tilde followed by unquoted content
        let query = expand("\"~\"suffix", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~\"suffix"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn quoted_tilde_path_then_unquoted() {
        // "~/docs"rest - quoted tilde path followed by unquoted content
        let query = expand("\"~/docs\"rest", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~/docs\"rest"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn expanded_tilde_then_quoted_suffix() {
        // ~/docs"suffix" - tilde expands, then quoted content follows
        let query = expand("~/docs\"suffix\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/docs\"suffix\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn quoted_tilde_slash_then_unquoted() {
        // "~/"suffix - quoted tilde with slash, then unquoted
        let query = expand("\"~/\"suffix", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~/\"suffix"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_between_two_quoted_sections() {
        // "a"~"b" - tilde not followed by / or \, won't expand
        let query = expand("\"a\"~\"b\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"a\"~\"b\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_slash_between_quoted_sections() {
        // "a"~/docs"b" - tilde after quotes followed by /, should expand
        let query = expand("\"a\"~/docs\"b\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"a\"/Users/demo/docs\"b\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn multiple_tildes_quoted_and_unquoted() {
        // ~"test"~/docs - first tilde not followed by /, second tilde (after quotes) should expand
        let query = expand("~\"test\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "~\"test\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn quoted_section_with_tilde_not_at_start() {
        // a"~/docs" - regular char, then quoted tilde path
        let query = expand("a\"~/docs\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "a\"~/docs\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn empty_quotes_tilde_empty_quotes() {
        // ""~"" - tilde not followed by / or \, won't expand
        let query = expand("\"\"~\"\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"\"~\"\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_only_after_quote_closes_midword() {
        // "prefix"~ - tilde alone after quotes, should expand to home
        let query = expand("\"prefix\"~", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"prefix\"/Users/demo"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn complex_quote_tilde_interleaving() {
        // "a"~"b"~/c"d" - first unquoted ~ not followed by /, second is, expand second
        let query = expand("\"a\"~\"b\"~/c\"d\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"a\"~\"b\"/Users/demo/c\"d\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_with_backslash_in_quotes() {
        // "~\docs" - tilde with backslash inside quotes
        let query = expand("\"~\\docs\"", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"~\\docs\""),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn unmatched_quote_affects_tilde() {
        // Since unmatched quotes cause parse errors, test quote-safe scenarios
        // "a"b~/c - quote closes after 'a', 'b' is unquoted before tilde, should expand
        let query = expand("\"a\"b~/c", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"a\"b/Users/demo/c"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_slash_at_start_expands() {
        // ~/docs - standard case, should expand
        let query = expand("~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_backslash_at_start_expands() {
        // ~\docs - backslash variant, should expand
        let query = expand(r"~\docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, r"/Users/demo\docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn empty_quotes_then_tilde_slash_expands() {
        // ""~/docs - empty quotes at start, then tilde with slash
        let query = expand("\"\"~/docs", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"\"/Users/demo/docs"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tilde_alone_at_start_expands() {
        // ~ - just tilde alone
        let query = expand("~", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "/Users/demo"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn quotes_then_tilde_nonslash_no_expand() {
        // ""~x - empty quotes then tilde not followed by / or \
        let query = expand("\"\"~x", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => assert_eq!(word, "\"\"~x"),
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn multiple_expandable_tildes_all_expand() {
        // ~/a/~/b/~/c - all three tildes should expand
        let query = expand("~/a/~/b/~/c", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => {
                assert_eq!(word, "/Users/demo/a//Users/demo/b//Users/demo/c")
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn tildes_mixed_with_quotes_expand_unquoted_only() {
        // ~/a/"~/b"/~/c - first and third expand, second (in quotes) doesn't
        let query = expand("~/a/\"~/b\"/~/c", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => {
                assert_eq!(word, "/Users/demo/a/\"~/b\"//Users/demo/c")
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    #[test]
    fn multiple_tildes_some_invalid() {
        // ~/a/~x/~/b - first and third expand, second (not followed by / or \) doesn't
        let query = expand("~/a/~x/~/b", "/Users/demo");
        match query.expr {
            Expr::Term(Term::Word(word)) => {
                assert_eq!(word, "/Users/demo/a/~x//Users/demo/b")
            }
            other => panic!("Unexpected expr: {other:?}"),
        }
    }

    // ---- 中文过滤器关键字别名 ----

    fn normalize(input: &str) -> Query {
        normalize_filter_aliases(parse_query(input).expect("valid query"))
    }

    fn filter_of(expr: &Expr) -> &Filter {
        match expr {
            Expr::Term(Term::Filter(filter)) => filter,
            other => panic!("Expected filter expr, got {other:?}"),
        }
    }

    #[test]
    fn chinese_folder_keyword_matches_english_folder_filter() {
        // `文件夹: foo` 必须与 `folder: foo` 完全等价：folder 类型过滤 + 独立词项。
        let chinese = normalize("文件夹: foo");
        let english = normalize("folder: foo");
        assert_eq!(chinese.expr, english.expr);

        let Expr::And(parts) = &chinese.expr else {
            panic!("Expected And expr, got {:?}", chinese.expr);
        };
        assert_eq!(parts.len(), 2);
        let filter = filter_of(&parts[0]);
        assert_eq!(filter.kind, FilterKind::Folder);
        assert!(filter.argument.is_none());
        assert!(matches!(&parts[1], Expr::Term(Term::Word(word)) if word == "foo"));
    }

    #[test]
    fn chinese_folder_keyword_with_inline_argument_matches_english() {
        // `文件夹:cardinal` 与 `folder:cardinal` 等价（参数直接跟在冒号后）。
        let chinese = normalize("文件夹:cardinal");
        let english = normalize("folder:cardinal");
        assert_eq!(chinese.expr, english.expr);
        let filter = filter_of(&chinese.expr);
        assert_eq!(filter.kind, FilterKind::Folder);
        assert_eq!(
            filter.argument.as_ref().map(|arg| arg.raw.as_str()),
            Some("cardinal")
        );

        // 无参数的 `文件夹:` 等价于 `folder:`。
        assert_eq!(normalize("文件夹:").expr, normalize("folder:").expr);
    }

    #[test]
    fn chinese_alias_table_covers_required_keywords() {
        // 关键字 -> 等价英文过滤器
        let cases = [
            ("文件夹名:docs", "folder:docs"),
            ("目录:docs", "dir:docs"),
            ("文件:report", "file:report"),
            ("类型:图片", "type:图片"),
            ("后缀:rs", "ext:rs"),
            ("扩展名:jpg;png", "ext:jpg;png"),
            ("路径:src", "path:src"),
            ("在:src", "path:src"),
            ("大小:1mb..10mb", "size:1mb..10mb"),
            ("日期:today", "dm:today"),
        ];
        for (chinese, english) in cases {
            assert_eq!(
                normalize(chinese).expr,
                normalize(english).expr,
                "中文关键字 {chinese:?} 应等价于 {english:?}"
            );
        }
    }

    #[test]
    fn chinese_regex_keyword_switches_to_regex_term() {
        // `正则:` 与英文 `regex:` 一样，整条查询进入正则模式（Term::Regex）。
        let chinese = normalize("正则:^cardinal");
        let english = normalize("regex:^cardinal");
        assert_eq!(chinese.expr, english.expr);
        assert!(matches!(
            chinese.expr,
            Expr::Term(Term::Regex(ref pattern)) if pattern == "^cardinal"
        ));
    }

    #[test]
    fn chinese_path_keyword_is_resolved_against_root() {
        // 别名重写必须发生在相对路径解析之前，`路径:src` 才会被解析成 root/src。
        let chinese = resolve_with_home("路径:src", "", "/root");
        let english = resolve_with_home("path:src", "", "/root");
        assert_eq!(chinese.expr, english.expr);
        let filter = filter_of(&chinese.expr);
        assert_eq!(filter.kind, FilterKind::InFolder);
        assert_eq!(
            filter.argument.as_ref().map(|arg| arg.raw.as_str()),
            Some("/root/src")
        );
    }

    #[test]
    fn english_queries_are_untouched_by_normalization() {
        // 英文关键字与普通词项不参与重写。
        for query in [
            "folder: foo",
            "folder:docs",
            "ext:rs",
            "cardinal",
            "路径",
            "文件夹",
            "report ext:rs folder: docs",
            "notafilter:value",
        ] {
            let parsed = parse_query(query).expect("valid query");
            let before = parsed.expr.clone();
            let after = normalize_filter_aliases(parsed).expr;
            assert_eq!(before, after, "查询 {query:?} 不应被改动");
        }
        // 单独的 `文件夹`（没有冒号）仍然只是普通词项。
        assert!(matches!(
            normalize("文件夹").expr,
            Expr::Term(Term::Word(ref word)) if word == "文件夹"
        ));
    }

    #[test]
    fn chinese_alias_only_matches_known_keyword_before_colon() {
        // 未知的中文前缀不应被重写成过滤器（避免误伤普通词项）。
        let query = normalize("未知关键字:value");
        assert!(matches!(
            query.expr,
            Expr::Term(Term::Word(ref word)) if word == "未知关键字:value"
        ));
    }
}
