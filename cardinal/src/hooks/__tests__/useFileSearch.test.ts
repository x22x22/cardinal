import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
  SEARCH_INDEX_BUILDING_RETRY_DELAY_MS,
  SEARCH_LOADING_DELAY_MS,
  SEARCH_TIMEOUT_MS,
} from '../../constants';
import i18n from '../../i18n/config';
import enUS from '../../i18n/resources/en-US.json';
import zhCN from '../../i18n/resources/zh-CN.json';
import type { SlabIndex } from '../../types/slab';
import { MAX_INDEX_BUILDING_RETRIES, useFileSearch } from '../useFileSearch';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

type SearchPayload = { results: SlabIndex[]; highlights?: string[] };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const searchResponse = (results: SlabIndex[], highlights: string[] = []): SearchPayload => ({
  results,
  highlights,
});

// React 18 batches updates coming from promise callbacks; flushing a handful of
// microtask turns inside act() lets the hook's async flow settle.
// 首屏不再自动搜索（空输入进引导态），用例需要显式发起一次查询。
const renderAndSearch = async (
  query = 'probe',
): Promise<{ result: { current: ReturnType<typeof useFileSearch> } }> => {
  const hook = renderHook(() => useFileSearch());
  await flushAsync();
  await act(async () => {
    hook.result.current.queueSearch(query, { immediate: true });
  });
  await flushAsync();
  return hook;
};

const flushAsync = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useFileSearch', () => {
  beforeAll(async () => {
    // Pin the language so `searchError` assertions are deterministic and the
    // translation is guaranteed to be loaded before fake timers take over.
    await i18n.changeLanguage('en-US');
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mockedInvoke.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reuses backend results array without copying and reports a ready index', async () => {
    const backendResults = [1, 2, 3] as SlabIndex[];

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        return Promise.resolve(searchResponse(backendResults, ['term']));
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    expect(result.current.state.initialFetchCompleted).toBe(true);
    expect(result.current.state.results).toBe(backendResults);
    expect(result.current.state.resultCount).toBe(backendResults.length);
    expect(result.current.state.showLoadingUI).toBe(false);
    expect(result.current.state.searchError).toBeNull();
    expect(result.current.state.searchErrorKey).toBeNull();
    expect(result.current.state.lifecycleState).toBe('Ready');
    expect(result.current.state.indexing).toBe(false);
    expect(result.current.state.indexingHint).toBeNull();
  });

  it('recovers from a hung search through the watchdog while keeping previous results', async () => {
    const firstResults = [7, 8] as SlabIndex[];
    let searchCalls = 0;

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        searchCalls += 1;
        // Second request never settles: this reproduces a backend whose event
        // loop is starved by an FSEvents scan.
        return searchCalls === 1
          ? Promise.resolve(searchResponse(firstResults))
          : new Promise<SearchPayload>(() => {});
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    expect(result.current.state.results).toBe(firstResults);

    act(() => {
      result.current.queueSearch('hung', { immediate: true });
    });
    await flushAsync();

    // A re-query only shows the spinner after the loading delay.
    expect(result.current.state.showLoadingUI).toBe(false);
    await advance(SEARCH_LOADING_DELAY_MS);
    expect(result.current.state.showLoadingUI).toBe(true);

    await advance(SEARCH_TIMEOUT_MS);

    expect(result.current.state.showLoadingUI).toBe(false);
    expect(result.current.state.searchErrorKey).toBe('search.timeout');
    // Regression guard: the message must be an actual translation, not the raw key.
    expect(result.current.state.searchError).toBe(enUS.search.timeout);
    expect(result.current.state.searchError).not.toBe('search.timeout');
    // The last successful result set must survive the timeout.
    expect(result.current.state.results).toBe(firstResults);
    expect(result.current.state.resultCount).toBe(firstResults.length);
    expect(result.current.state.initialFetchCompleted).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('state=timeout'));
  });

  it('drops responses belonging to superseded requests', async () => {
    const staleResults = [1] as SlabIndex[];
    const freshResults = [2, 3] as SlabIndex[];
    const stale = createDeferred<SearchPayload>();
    const fresh = createDeferred<SearchPayload>();
    let searchCalls = 0;

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        searchCalls += 1;
        return searchCalls === 1 ? stale.promise : fresh.promise;
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    act(() => {
      result.current.queueSearch('newer', { immediate: true });
    });
    await flushAsync();

    await act(async () => {
      fresh.resolve(searchResponse(freshResults));
    });
    await flushAsync();

    expect(result.current.state.results).toBe(freshResults);

    // The first (superseded) request answers late and must be discarded.
    await act(async () => {
      stale.resolve(searchResponse(staleResults));
    });
    await flushAsync();

    expect(result.current.state.results).toBe(freshResults);
    expect(result.current.state.resultCount).toBe(freshResults.length);
    expect(console.debug).toHaveBeenCalledWith(expect.stringContaining('state=stale-dropped'));
  });

  it('exposes an indexing hint while the lifecycle is not Ready and still arms the watchdog', async () => {
    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Updating');
      }
      if (command === 'search') {
        return new Promise<SearchPayload>(() => {});
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    expect(result.current.state.lifecycleState).toBe('Updating');
    expect(result.current.state.indexing).toBe(true);
    expect(result.current.state.indexingHint).toBe('search.indexing');

    // The watchdog applies during index rebuilds too.
    await advance(SEARCH_TIMEOUT_MS);
    expect(result.current.state.showLoadingUI).toBe(false);
    expect(result.current.state.searchErrorKey).toBe('search.timeout');
  });

  it('ignores a late response that arrives after the watchdog fired', async () => {
    const late = createDeferred<SearchPayload>();

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        return late.promise;
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    await advance(SEARCH_TIMEOUT_MS);
    expect(result.current.state.searchErrorKey).toBe('search.timeout');
    expect(result.current.state.showLoadingUI).toBe(false);

    await act(async () => {
      late.resolve(searchResponse([9] as SlabIndex[]));
    });
    await flushAsync();

    // A settled timeout state must not flip back to loading or adopt the result.
    expect(result.current.state.showLoadingUI).toBe(false);
    expect(result.current.state.searchErrorKey).toBe('search.timeout');
    expect(result.current.state.results).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('state=late-response-dropped'),
    );
  });

  it('maps the backend search_timeout rejection to the timeout surface without auto-retrying', async () => {
    const previousResults = [4, 5] as SlabIndex[];
    let searchCalls = 0;

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        searchCalls += 1;
        return searchCalls === 1
          ? Promise.resolve(searchResponse(previousResults))
          : Promise.reject('search_timeout');
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();
    expect(result.current.state.results).toBe(previousResults);

    act(() => {
      result.current.queueSearch('slow-backend', { immediate: true });
    });
    await flushAsync();

    expect(result.current.state.searchErrorKey).toBe('search.timeout');
    expect(result.current.state.searchError).toBe(enUS.search.timeout);
    expect(result.current.state.showLoadingUI).toBe(false);
    expect(result.current.state.results).toBe(previousResults);

    // A backend timeout must never trigger an automatic re-issue.
    const callsAfterFailure = searchCalls;
    await advance(SEARCH_TIMEOUT_MS + 5_000);
    expect(searchCalls).toBe(callsAfterFailure);
  });

  it('treats index_building as informational, keeps prior results and retries exactly once', async () => {
    const previousResults = [10] as SlabIndex[];
    const refreshedResults = [11, 12] as SlabIndex[];
    let searchCalls = 0;

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        searchCalls += 1;
        if (searchCalls === 1) {
          return Promise.resolve(searchResponse(previousResults));
        }
        if (searchCalls === 2) {
          return Promise.reject('index_building');
        }
        return Promise.resolve(searchResponse(refreshedResults));
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    act(() => {
      result.current.queueSearch('during-rebuild', { immediate: true });
    });
    await flushAsync();

    // Informational, not an error: previous results stay visible and the hint
    // takes over from the error surface.
    expect(result.current.state.searchError).toBeNull();
    expect(result.current.state.searchErrorKey).toBeNull();
    expect(result.current.state.results).toBe(previousResults);
    expect(result.current.state.indexBuilding).toBe(true);
    expect(result.current.state.indexing).toBe(true);
    expect(result.current.state.indexingHint).toBe('search.indexing');
    expect(searchCalls).toBe(2);

    // Exactly one automatic retry, which now succeeds and clears the hint.
    await advance(SEARCH_INDEX_BUILDING_RETRY_DELAY_MS);
    await flushAsync();

    expect(searchCalls).toBe(3);
    expect(result.current.state.results).toBe(refreshedResults);
    expect(result.current.state.indexBuilding).toBe(false);
    expect(result.current.state.indexing).toBe(false);
    expect(result.current.state.searchError).toBeNull();
  });

  it('keeps retrying while the index rebuilds, then stops at the budget cap', async () => {
    let searchCalls = 0;

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        // 保持 Initializing：本用例只验证重试预算，索引就绪后的补搜索会污染计数。
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        searchCalls += 1;
        return Promise.reject('index_building');
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    expect(searchCalls).toBe(1);
    expect(result.current.state.indexing).toBe(true);

    await advance(SEARCH_INDEX_BUILDING_RETRY_DELAY_MS);
    await flushAsync();
    expect(searchCalls).toBeGreaterThan(1);

    // 索引一直不就绪时最终必须停下，否则就是请求风暴。
    await advance(SEARCH_INDEX_BUILDING_RETRY_DELAY_MS * (MAX_INDEX_BUILDING_RETRIES + 5));
    await flushAsync();
    const callsAtCap = searchCalls;
    await advance(SEARCH_INDEX_BUILDING_RETRY_DELAY_MS * 5);
    await flushAsync();
    expect(searchCalls).toBe(callsAtCap);
    expect(result.current.state.searchError).toBeNull();
    expect(result.current.state.showLoadingUI).toBe(false);
  });

  it('falls back to the generic error surface and logs raw search_* details', async () => {
    let searchCalls = 0;

    mockedInvoke.mockImplementation((command: string) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        searchCalls += 1;
        return Promise.reject(
          searchCalls === 1 ? 'search_worker_gone' : 'search_failed: disk io error',
        );
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch();

    expect(result.current.state.searchErrorKey).toBe('search.failed');
    expect(result.current.state.searchError).toBe(enUS.search.failed);
    expect(result.current.state.showLoadingUI).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('reason="search_worker_gone"'),
      'search_worker_gone',
    );

    act(() => {
      result.current.queueSearch('again', { immediate: true });
    });
    await flushAsync();

    expect(result.current.state.searchErrorKey).toBe('search.failed');
    // Detailed reasons still reach the console verbatim for Rust log matching.
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('reason="search_failed: disk io error"'),
      'search_failed: disk io error',
    );
  });

  it('ships the timeout/indexing/retry copy in both zh-CN and en-US', () => {
    expect(zhCN.search.timeout).toBe('搜索超时，后台索引可能正忙，请稍后重试');
    expect(zhCN.search.indexing).toBe('索引更新中，结果可能不完整');
    expect(zhCN.search.retry).toBe('重试');

    expect(enUS.search.timeout.length).toBeGreaterThan(0);
    expect(enUS.search.indexing.length).toBeGreaterThan(0);
    expect(enUS.search.retry).toBe('Retry');
    expect(enUS.search.failed.length).toBeGreaterThan(0);
    expect(zhCN.search.failed).toBe('搜索失败，请稍后重试');
  });

  it('skips the IPC entirely for an empty query and lands in the idle state', async () => {
    const searchCalls: string[] = [];
    mockedInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        const payload = args as { query?: string } | undefined;
        searchCalls.push(payload?.query ?? '');
        return Promise.resolve(searchResponse([1] as SlabIndex[]));
      }
      return Promise.resolve(null);
    });

    const { result } = renderHook(() => useFileSearch());
    await flushAsync();

    // 首屏空输入：不发请求，直接可交互。
    expect(searchCalls).toHaveLength(0);
    expect(result.current.state.hasQuery).toBe(false);
    expect(result.current.state.initialFetchCompleted).toBe(true);
    expect(result.current.state.showLoadingUI).toBe(false);
    expect(result.current.state.results).toEqual([]);
    expect(result.current.state.searchError).toBeNull();

    // 用户清空输入后回到 idle，仍然不发请求。
    await act(async () => {
      result.current.queueSearch('hello', { immediate: true });
    });
    await flushAsync();
    expect(searchCalls).toEqual(['hello']);
    expect(result.current.state.hasQuery).toBe(true);

    await act(async () => {
      result.current.queueSearch('', { immediate: true });
    });
    await flushAsync();
    expect(searchCalls).toEqual(['hello']);
    expect(result.current.state.hasQuery).toBe(false);
    expect(result.current.state.results).toEqual([]);
  });

  it('appends the next page on loadMore and stops at the reported total', async () => {
    const page1 = [1, 2] as SlabIndex[];
    const page2 = [3, 4] as SlabIndex[];
    const offsets: Array<number | undefined> = [];

    mockedInvoke.mockImplementation((command: string, args?: unknown) => {
      if (command === 'get_app_status') {
        return Promise.resolve('Ready');
      }
      if (command === 'search') {
        const payload = args as { options?: { offset?: number } } | undefined;
        const offset = payload?.options?.offset;
        offsets.push(offset);
        return Promise.resolve(
          offset && offset > 0
            ? { results: page2, highlights: [], total: 4 }
            : { results: page1, highlights: [], total: 4 },
        );
      }
      return Promise.resolve(null);
    });

    const { result } = await renderAndSearch('paged');

    expect(result.current.state.results).toBe(page1);
    expect(result.current.state.resultCount).toBe(2);
    expect(result.current.state.total).toBe(4);
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      result.current.loadMore();
    });
    await flushAsync();

    expect(offsets).toEqual([0, 2]);
    expect(result.current.state.results).toEqual([1, 2, 3, 4]);
    expect(result.current.state.resultCount).toBe(4);
    expect(result.current.hasMore).toBe(false);

    // 已经到底，再触发也不会重复请求。
    await act(async () => {
      result.current.loadMore();
    });
    await flushAsync();
    expect(offsets).toEqual([0, 2]);
  });
});
