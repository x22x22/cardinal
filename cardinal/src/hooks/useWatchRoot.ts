import { useCallback } from 'react';
import { useStoredState } from './useStoredState';

const STORAGE_KEY = 'cardinal.watchRoots';
const LEGACY_KEY = 'cardinal.watchRoot';
const DEFAULT_WATCH_ROOTS = ['/'];

function parseWatchRoots(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const cleaned = parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return cleaned.length > 0 ? cleaned : null;
    }
  } catch {
    // 旧版本存的是裸路径字符串，走下面的兼容分支。
  }
  const single = raw.trim();
  return single.length > 0 ? [single] : null;
}

export function useWatchRoots() {
  // 旧版本只存了单根字符串：首次启动时把它当作默认值，从而迁移到新 key。
  const legacyRoot = readLegacyWatchRoot();
  const defaultValue = legacyRoot ? [legacyRoot] : DEFAULT_WATCH_ROOTS;
  const [watchRoots, setWatchRootsState] = useStoredState<string[]>({
    key: STORAGE_KEY,
    defaultValue,
    read: (raw) => parseWatchRoots(raw),
    write: (value) => JSON.stringify(value),
    readErrorMessage: 'Unable to read saved watch roots',
    writeErrorMessage: 'Unable to persist watch roots',
  });

  const setWatchRoots = useCallback(
    (next: string[]) => {
      const cleaned = next.map((item) => item.trim()).filter((item) => item.length > 0);
      setWatchRootsState(cleaned.length > 0 ? cleaned : DEFAULT_WATCH_ROOTS);
    },
    [setWatchRootsState],
  );

  return { watchRoots, setWatchRoots, defaultWatchRoots: DEFAULT_WATCH_ROOTS };
}

/// 读取旧版单根配置，用于首次启动时迁移。
export function readLegacyWatchRoot(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY);
    if (raw == null) {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
