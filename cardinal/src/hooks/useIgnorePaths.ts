import { useCallback } from 'react';
import { useStoredState } from './useStoredState';

const STORAGE_KEY = 'cardinal.ignorePaths';
// Ignore generated, disposable, or high-churn macOS paths by default:
// - `/Volumes` can include external drives and network mounts that are large or slow to traverse.
// - `~/Library/CloudStorage` can contain cloud stubs that trigger downloads or network I/O.
// - `~/Library/Biome` stores system suggestions/activity data rather than user-authored files.
// - `~/Library/Caches`, `~/Library/Logs`, and `~/Library/Metadata` are cache/log/metadata stores rather than user-authored files.
// - `/Library/Caches` and `/System/Library/Caches` are transient system caches with low search value.
// - `/private/var` is a broad system runtime area for temp files, caches, logs, and databases.
// - `/private/tmp` is a temporary-file area with very high churn and little search value.
// - `**/node_modules` and `/Users/*/.Trash` skip common dependency folders and the trash.
// - `**/.git` skips VCS metadata. The trailing-`**` form (`.git/**`) only matched entries *inside*
//   the directory, so the `.git` node itself was still walked, stat'ed and counted; matching the
//   directory instead lets the walker drop the whole subtree without descending into it.
// 项目内的依赖目录与工具缓存。这些内容可以随时重新生成，几乎不会有人按文件名去找它们，
// 却往往占据一个仓库里大部分文件数（`__pycache__`、虚拟环境、构建器缓存）。
//
// 刻意**不**包含构建产出物：`dist`、`build`、`target`、`out`、`output`、`.next`、`.nuxt`、
// `.svelte-kit`、`bin`、`release`。产物是本地可能唯一一份的交付内容，需要能搜到。
const PROJECT_DEPENDENCY_IGNORES = [
  // Python
  '**/__pycache__',
  '**/.venv',
  '**/venv',
  '**/.pytest_cache',
  '**/.mypy_cache',
  '**/.ruff_cache',
  '**/.tox',
  '**/*.egg-info',
  '**/.eggs',
  // JVM：Gradle 依赖缓存（`build/` 是产出，保留）
  '**/.gradle',
  // 前端构建器缓存（只排除缓存子目录，产物目录本身保留）
  '**/.turbo',
  '**/.parcel-cache',
  '**/.vite',
  '**/.next/cache',
  '**/.pnpm-store',
  // 通用工具缓存
  '**/.cache',
  // Terraform provider 缓存
  '**/.terraform',
];

// 用户级依赖缓存。这些路径通常落在主目录而不是项目里，只有当用户把 home 加进监控根时
// 才会被遍历；默认列出来是为了让那种配置不再被几百万个依赖文件拖慢。
const USER_DEPENDENCY_IGNORES = [
  // Rust
  '~/.cargo/registry',
  '~/.cargo/git',
  '~/.rustup',
  // Go
  '~/go/pkg/mod',
  '~/Library/Caches/go-build',
  // Node 系
  '~/.npm',
  '~/.yarn',
  '~/.bun',
  '~/Library/pnpm',
  // Python
  '~/.cache/uv',
  '~/.cache/pip',
  // JVM
  '~/.gradle/caches',
  '~/.m2/repository',
  // IDE 插件与索引
  '~/.vscode',
  '~/Library/Application Support/Code/Cache',
  '~/Library/Application Support/Code/CachedData',
  '~/Library/Application Support/Code/logs',
  '~/Library/Caches/JetBrains',
  '~/Library/Application Support/JetBrains',
  // Docker 镜像与虚拟机数据
  '~/Library/Containers/com.docker.docker/Data',
];

const DEFAULT_IGNORE_PATHS = [
  '/Volumes',
  '~/Library/CloudStorage',
  '~/Library/Biome',
  '~/Library/Caches',
  '~/Library/Logs',
  '~/Library/Metadata',
  '/Library/Caches',
  '/System/Library/Caches',
  '/private/var',
  '/private/tmp',
  '**/node_modules',
  '**/.git',
  '/Users/*/.Trash',
  ...PROJECT_DEPENDENCY_IGNORES,
  ...USER_DEPENDENCY_IGNORES,
];

// Older builds shipped `.git/**`, which misses the `.git` directory node itself. Upgrade stored
// configs on read so existing installs pick up the corrected rule without editing preferences.
const LEGACY_IGNORE_PATH_UPGRADES: Record<string, string> = {
  '.git/**': '**/.git',
};

const upgradeIgnorePaths = (paths: string[]): string[] =>
  Array.from(new Set(paths.map((item) => LEGACY_IGNORE_PATH_UPGRADES[item] ?? item)));

// 依赖缓存规则是一次性补进老配置的：用标记位记住做过这件事，之后用户若在偏好设置里
// 主动删掉某条规则，重启不会把它加回来。
const DEPENDENCY_MIGRATION_KEY = 'cardinal.ignorePaths.dependenciesMigrated';

const migrateDependencies = (paths: string[]): string[] => {
  if (window.localStorage.getItem(DEPENDENCY_MIGRATION_KEY) != null) {
    return paths;
  }
  window.localStorage.setItem(DEPENDENCY_MIGRATION_KEY, '1');
  return Array.from(new Set([...paths, ...PROJECT_DEPENDENCY_IGNORES, ...USER_DEPENDENCY_IGNORES]));
};

const cleanPaths = (next: string[]): string[] =>
  next.map((item) => item.trim()).filter((item) => item.length > 0);

export function useIgnorePaths() {
  const [ignorePaths, setIgnorePathsState] = useStoredState<string[]>({
    key: STORAGE_KEY,
    defaultValue: DEFAULT_IGNORE_PATHS,
    read: (raw) => {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const paths = cleanPaths(parsed.filter((item): item is string => typeof item === 'string'));
      return migrateDependencies(upgradeIgnorePaths(paths));
    },
    write: (value) => JSON.stringify(value),
    readErrorMessage: 'Unable to read saved ignore paths',
    writeErrorMessage: 'Unable to persist default ignore paths',
  });

  const setIgnorePaths = useCallback(
    (next: string[]) => {
      const cleaned = cleanPaths(next);
      setIgnorePathsState(cleaned);
    },
    [setIgnorePathsState],
  );

  return { ignorePaths, setIgnorePaths, defaultIgnorePaths: DEFAULT_IGNORE_PATHS };
}
