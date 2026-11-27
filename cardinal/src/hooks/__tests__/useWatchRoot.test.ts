import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWatchRoots } from '../useWatchRoot';

const STORAGE_KEY = 'cardinal.watchRoots';
const LEGACY_KEY = 'cardinal.watchRoot';

const flushEffects = async () => {
  await act(async () => {});
};

describe('useWatchRoots', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hydrates a list from stored values', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['/a', '/b']));
    const { result } = renderHook(() => useWatchRoots());

    expect(result.current.watchRoots).toEqual(['/a', '/b']);
    await flushEffects();
  });

  it('migrates the legacy single-root key', async () => {
    window.localStorage.setItem(LEGACY_KEY, '/legacy/root');
    const { result } = renderHook(() => useWatchRoots());

    expect(result.current.watchRoots).toEqual(['/legacy/root']);
    await flushEffects();
  });

  it('falls back to the default when nothing is stored', async () => {
    const { result } = renderHook(() => useWatchRoots());

    expect(result.current.watchRoots).toEqual(['/']);
    expect(result.current.defaultWatchRoots).toEqual(['/']);
    await flushEffects();
  });

  it('drops blank entries when updating', async () => {
    const { result } = renderHook(() => useWatchRoots());

    act(() => {
      result.current.setWatchRoots(['  /a  ', '', '/b']);
    });

    expect(result.current.watchRoots).toEqual(['/a', '/b']);
  });

  it('keeps at least the default root when everything is blank', async () => {
    const { result } = renderHook(() => useWatchRoots());

    act(() => {
      result.current.setWatchRoots(['', '   ']);
    });

    expect(result.current.watchRoots).toEqual(['/']);
  });
});
