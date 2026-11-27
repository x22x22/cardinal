import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useIgnorePaths } from '../useIgnorePaths';

const STORAGE_KEY = 'cardinal.ignorePaths';
const EXPECTED_DEFAULT_IGNORE_PATHS = [
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
  '**/__pycache__',
  '**/.venv',
  '**/venv',
  '**/.pytest_cache',
  '**/.mypy_cache',
  '**/.ruff_cache',
  '**/.tox',
  '**/*.egg-info',
  '**/.eggs',
  '**/.gradle',
  '**/.turbo',
  '**/.parcel-cache',
  '**/.vite',
  '**/.next/cache',
  '**/.pnpm-store',
  '**/.cache',
  '**/.terraform',
  '~/.cargo/registry',
  '~/.cargo/git',
  '~/.rustup',
  '~/go/pkg/mod',
  '~/Library/Caches/go-build',
  '~/.npm',
  '~/.yarn',
  '~/.bun',
  '~/Library/pnpm',
  '~/.cache/uv',
  '~/.cache/pip',
  '~/.gradle/caches',
  '~/.m2/repository',
  '~/.vscode',
  '~/Library/Application Support/Code/Cache',
  '~/Library/Application Support/Code/CachedData',
  '~/Library/Application Support/Code/logs',
  '~/Library/Caches/JetBrains',
  '~/Library/Application Support/JetBrains',
  '~/Library/Containers/com.docker.docker/Data',
];

const flushEffects = async () => {
  await act(async () => {});
};

const DEPENDENCY_MIGRATION_KEY = 'cardinal.ignorePaths.dependenciesMigrated';

describe('useIgnorePaths', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // 默认视为"依赖缓存规则已迁移过"，让既有用例拿到稳定状态；
    // 迁移本身由专门的用例覆盖（会先清掉这个标记）。
    window.localStorage.setItem(DEPENDENCY_MIGRATION_KEY, '1');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hydrates from stored values and filters invalid entries', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([' /tmp ', '', 42, '   ', '/var']));
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths).toEqual(['/tmp', '/var']);

    await flushEffects();

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('uses defaults and persists when no stored value exists', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths).toEqual(EXPECTED_DEFAULT_IGNORE_PATHS);
    expect(result.current.defaultIgnorePaths).toEqual(EXPECTED_DEFAULT_IGNORE_PATHS);

    await flushEffects();

    expect(setItemSpy).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(EXPECTED_DEFAULT_IGNORE_PATHS),
    );
  });

  it('includes cache, biome, logs, metadata, system runtime, and common tool folders in default ignore paths', () => {
    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.defaultIgnorePaths).toContain('~/Library/CloudStorage');
    expect(result.current.defaultIgnorePaths).toContain('~/Library/Caches');
    expect(result.current.defaultIgnorePaths).toContain('/Library/Caches');
    expect(result.current.defaultIgnorePaths).toContain('/System/Library/Caches');
    expect(result.current.defaultIgnorePaths).toContain('~/Library/Biome');
    expect(result.current.defaultIgnorePaths).toContain('~/Library/Logs');
    expect(result.current.defaultIgnorePaths).toContain('~/Library/Metadata');
    expect(result.current.defaultIgnorePaths).toContain('/private/var');
    expect(result.current.defaultIgnorePaths).toContain('/private/tmp');
    expect(result.current.defaultIgnorePaths).toContain('**/node_modules');
    expect(result.current.defaultIgnorePaths).toContain('**/.git');
    expect(result.current.defaultIgnorePaths).toContain('/Users/*/.Trash');
  });

  it('upgrades the legacy .git/** rule so the .git directory itself is skipped', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['**/node_modules', '.git/**', '/private/tmp']),
    );

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths).toContain('**/.git');
    expect(result.current.ignorePaths).not.toContain('.git/**');
    // 其余规则原样保留
    expect(result.current.ignorePaths).toEqual(['**/node_modules', '**/.git', '/private/tmp']);
  });

  it('backfills dependency rules once for a pre-existing config', async () => {
    window.localStorage.clear();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['/private/tmp', '**/node_modules']));

    const { result } = renderHook(() => useIgnorePaths());

    // 老配置里的条目保留，依赖缓存规则被补进来
    expect(result.current.ignorePaths).toContain('/private/tmp');
    expect(result.current.ignorePaths).toContain('**/node_modules');
    expect(result.current.ignorePaths).toContain('**/__pycache__');
    expect(result.current.ignorePaths).toContain('~/.cargo/registry');
    expect(window.localStorage.getItem(DEPENDENCY_MIGRATION_KEY)).toBe('1');
  });

  it('does not resurrect dependency rules the user removed after migration', async () => {
    window.localStorage.clear();
    // 用户迁移后主动删掉了 __pycache__ 规则
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['/private/tmp']));
    window.localStorage.setItem(DEPENDENCY_MIGRATION_KEY, '1');

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths).toEqual(['/private/tmp']);
  });

  it('keeps build output directories searchable', async () => {
    window.localStorage.clear();

    const { result } = renderHook(() => useIgnorePaths());

    const defaults = result.current.defaultIgnorePaths;
    // 构建产出物不在默认忽略列表里，必须能被搜到
    for (const output of ['dist', 'build', 'target', 'out', 'output', '.next', '.nuxt']) {
      expect(defaults.some((rule) => rule.endsWith(`/${output}`))).toBe(false);
    }
    // 但构建器缓存要忽略
    expect(defaults).toContain('**/.next/cache');
    expect(defaults).toContain('**/.turbo');
  });

  it('does not duplicate the git rule when both forms were stored', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(['.git/**', '**/.git', '/private/tmp']),
    );

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths.filter((item) => item.includes('.git'))).toEqual(['**/.git']);
  });

  it('keeps an empty stored array without writing defaults', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['', '   ']));
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths).toEqual([]);

    await flushEffects();

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('cleans and persists updates', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useIgnorePaths());

    await flushEffects();

    act(() => {
      result.current.setIgnorePaths([' /tmp ', '', '/var', '   ']);
    });

    expect(result.current.ignorePaths).toEqual(['/tmp', '/var']);
    expect(setItemSpy).toHaveBeenCalledWith(STORAGE_KEY, JSON.stringify(['/tmp', '/var']));
  });

  it('falls back to defaults when stored JSON is invalid', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.localStorage.setItem(STORAGE_KEY, '{');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    const { result } = renderHook(() => useIgnorePaths());

    expect(result.current.ignorePaths).toEqual(result.current.defaultIgnorePaths);

    await flushEffects();

    expect(setItemSpy).toHaveBeenCalledWith(
      STORAGE_KEY,
      JSON.stringify(result.current.defaultIgnorePaths),
    );
    warnSpy.mockRestore();
  });
});
