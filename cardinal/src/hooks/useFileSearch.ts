import { useReducer, useRef, useCallback, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_INDEX_BUILDING_RETRY_DELAY_MS,
  SEARCH_LOADING_DELAY_MS,
  SEARCH_TIMEOUT_MS,
} from '../constants';
import i18n from '../i18n/config';
import type { AppLifecycleStatus, SearchResponsePayload } from '../types/ipc';
import type { SlabIndex } from '../types/slab';

const LOG_PREFIX = '[cardinal.search]';

/// 单页结果上限，与后端 `DEFAULT_SEARCH_LIMIT` 保持一致。
const SEARCH_PAGE_SIZE = 2000;

/// 索引构建期间的重试上限（1.5 秒/次 ≈ 90 秒）。
export const MAX_INDEX_BUILDING_RETRIES = 60;

/// 后端以稳定错误码拒绝搜索请求，前端据此区分「索引还没好」和真失败。
const SEARCH_BACKEND_ERRORS = {
  indexBuilding: 'index_building',
  timeout: 'search_timeout',
} as const;

/// 稳定 i18n key；实际文案由 `translateSearchKey` 解析。
const SEARCH_I18N = {
  failed: 'search.failed',
  timeout: 'search.timeout',
  indexing: 'search.indexing',
} as const;

type BackendSearchErrorKind = 'index-building' | 'timeout' | 'detail';

type SearchError = string | Error | null;

type SearchState = {
  results: SlabIndex[];
  resultsVersion: number;
  scannedFiles: number;
  processedEvents: number;
  rescanErrors: number;
  currentQuery: string;
  highlightTerms: string[];
  showLoadingUI: boolean;
  initialFetchCompleted: boolean;
  durationMs: number | null;
  resultCount: number;
  /** 当前查询在服务端的命中总数（用于「还有更多」判断）。 */
  total: number;
  /** 当前是否有有效查询；为空表示未输入，UI 应显示引导而不是「没有匹配结果」。 */
  hasQuery: boolean;
  searchError: SearchError;
  lifecycleState: AppLifecycleStatus;
  /** i18n key for the currently surfaced search error, or null. */
  searchErrorKey: string | null;
  /** Lifecycle says the index is not usable yet. */
  indexing: boolean;
  /** Hint shown next to results while the index is still settling. */
  indexingHint: string | null;
  /** Backend reported `index_building` for the latest query. */
  indexBuilding: boolean;
};

type SearchParams = {
  query: string;
  caseSensitive: boolean;
};

type QueueSearchOptions = {
  immediate?: boolean;
  onSearchCommitted?: (query: string) => void;
};

type HandleSearchOptions = {
  /** Set only for automatic retries after `index_building`. */
  autoRetry?: boolean;
  /** 跳过的条数，用于滚动到底加载下一页。 */
  offset?: number;
};

type SearchAction =
  | {
      type: 'STATUS_UPDATE';
      payload: { scannedFiles: number; processedEvents: number; rescanErrors: number };
    }
  | { type: 'SEARCH_REQUEST'; payload: { immediate: boolean } }
  | { type: 'SEARCH_LOADING_DELAY' }
  | { type: 'SEARCH_IDLE' }
  | {
      type: 'SEARCH_SUCCESS';
      payload: {
        results: SlabIndex[];
        query: string;
        duration: number;
        count: number;
        highlightTerms: string[];
        /** 追加到已有结果（滚动加载下一页）而不是替换。 */
        append: boolean;
        total: number;
      };
    }
  | {
      type: 'SEARCH_FAILURE';
      payload: {
        error: SearchError;
        errorKey: string;
        duration: number;
      };
    }
  | {
      type: 'SEARCH_TIMEOUT';
      payload: {
        error: SearchError;
        errorKey: string;
        duration: number;
      };
    }
  | {
      type: 'SEARCH_INDEX_BUILDING';
      payload: { duration: number };
    }
  | { type: 'SET_LIFECYCLE_STATE'; payload: { status: AppLifecycleStatus } };

const isIndexing = (status: AppLifecycleStatus): boolean => status !== 'Ready';

const translateSearchKey = (key: string): string => i18n.t(key);

const normalizeBackendError = (error: unknown): string => {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return error ? String(error) : 'An unknown error occurred.';
};

const classifyBackendError = (raw: string): BackendSearchErrorKind => {
  // 历史版本会把控制码包成 `search_failed: index_building`，两种形态都认。
  if (
    raw === SEARCH_BACKEND_ERRORS.indexBuilding ||
    raw.endsWith(SEARCH_BACKEND_ERRORS.indexBuilding)
  ) {
    return 'index-building';
  }
  if (raw === SEARCH_BACKEND_ERRORS.timeout || raw.endsWith(SEARCH_BACKEND_ERRORS.timeout)) {
    return 'timeout';
  }
  // `search_worker_gone` and any other `search_*` variant share the generic
  // failure surface; their raw text is logged for reconciliation with Rust.
  return 'detail';
};

const initialSearchState: SearchState = {
  results: [],
  resultsVersion: 0,
  scannedFiles: 0,
  processedEvents: 0,
  rescanErrors: 0,
  currentQuery: '',
  highlightTerms: [],
  showLoadingUI: false,
  initialFetchCompleted: false,
  durationMs: null,
  resultCount: 0,
  total: 0,
  hasQuery: false,
  searchError: null,
  lifecycleState: 'Initializing',
  searchErrorKey: null,
  indexing: isIndexing('Initializing'),
  indexingHint: isIndexing('Initializing') ? SEARCH_I18N.indexing : null,
  indexBuilding: false,
};

const initialSearchParams: SearchParams = {
  query: '',
  caseSensitive: false,
};

const cancelTimer = (timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
};

// Keep reducer pure and colocated so useReducer stays predictable.
function reducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case 'STATUS_UPDATE':
      return {
        ...state,
        scannedFiles: action.payload.scannedFiles,
        processedEvents: action.payload.processedEvents,
        rescanErrors: action.payload.rescanErrors,
      };
    case 'SEARCH_REQUEST':
      return {
        ...state,
        searchError: null,
        searchErrorKey: null,
        showLoadingUI: action.payload.immediate ? true : state.showLoadingUI,
      };
    case 'SEARCH_LOADING_DELAY':
      return {
        ...state,
        showLoadingUI: true,
      };
    case 'SEARCH_IDLE':
      // 空输入不发请求：清空结果并进入引导态，由 UI 提示「输入关键词」或
      // 索引构建进度。`indexing` 仍然跟着 lifecycle 走。
      return {
        ...state,
        results: [],
        resultsVersion: state.resultsVersion + 1,
        currentQuery: '',
        highlightTerms: [],
        showLoadingUI: false,
        initialFetchCompleted: true,
        durationMs: null,
        resultCount: 0,
        total: 0,
        hasQuery: false,
        searchError: null,
        searchErrorKey: null,
        indexBuilding: false,
      };
    case 'SEARCH_SUCCESS': {
      // 下一页要拼接，首屏页要替换；保留原数组引用，避免多复制一次大数组。
      const results = action.payload.append
        ? [...state.results, ...action.payload.results]
        : action.payload.results;
      return {
        ...state,
        results,
        resultsVersion: state.resultsVersion + 1,
        currentQuery: action.payload.query,
        highlightTerms: action.payload.highlightTerms,
        showLoadingUI: false,
        initialFetchCompleted: true,
        durationMs: action.payload.duration,
        resultCount: results.length,
        total: action.payload.total,
        hasQuery: action.payload.query.trim().length > 0,
        searchError: null,
        searchErrorKey: null,
        indexBuilding: false,
        indexing: isIndexing(state.lifecycleState),
        indexingHint: isIndexing(state.lifecycleState) ? SEARCH_I18N.indexing : null,
      };
    }
    case 'SEARCH_FAILURE':
      return {
        ...state,
        showLoadingUI: false,
        searchError: action.payload.error,
        searchErrorKey: action.payload.errorKey,
        initialFetchCompleted: true,
        durationMs: action.payload.duration,
        resultCount: 0,
        highlightTerms: [],
        indexBuilding: false,
      };
    case 'SEARCH_TIMEOUT':
      return {
        ...state,
        showLoadingUI: false,
        searchError: action.payload.error,
        searchErrorKey: action.payload.errorKey,
        initialFetchCompleted: true,
        durationMs: action.payload.duration,
        // 超时不清空上一轮结果，用户还能继续用已看到的列表。
        indexBuilding: false,
      };
    case 'SEARCH_INDEX_BUILDING':
      // Information, not failure. Keep the previous result set visible and let
      // `indexing`/`indexingHint` carry the "still indexing" message instead of
      // switching the results pane into its error state.
      return {
        ...state,
        showLoadingUI: false,
        initialFetchCompleted: true,
        durationMs: action.payload.duration,
        searchError: null,
        searchErrorKey: null,
        indexBuilding: true,
        indexing: true,
        indexingHint: SEARCH_I18N.indexing,
      };
    case 'SET_LIFECYCLE_STATE': {
      const indexing = isIndexing(action.payload.status);
      return {
        ...state,
        lifecycleState: action.payload.status,
        indexing,
        indexingHint: indexing ? SEARCH_I18N.indexing : null,
      };
    }
    default:
      return state;
  }
}

const searchParamsReducer = (prev: SearchParams, patch: Partial<SearchParams>): SearchParams => {
  const next = { ...prev, ...patch };
  return next;
};

type UseFileSearchResult = {
  state: SearchState;
  searchParams: SearchParams;
  updateSearchParams: (patch: Partial<SearchParams>) => void;
  queueSearch: (query: string, options?: QueueSearchOptions) => void;
  handleStatusUpdate: (scannedFiles: number, processedEvents: number, rescanErrors: number) => void;
  setLifecycleState: (status: AppLifecycleStatus) => void;
  requestRescan: () => Promise<void>;
  /** 追加下一页（滚动到底部触发）。 */
  loadMore: () => void;
  /** 当前查询还有没有未加载的页。 */
  hasMore: boolean;
};

type HandleSearch = (
  overrides?: Partial<SearchParams>,
  options?: HandleSearchOptions,
) => Promise<void>;

export function useFileSearch(): UseFileSearchResult {
  const [state, dispatch] = useReducer(reducer, initialSearchState);
  const latestSearchRef = useRef<SearchParams>(initialSearchParams);
  const searchVersionRef = useRef(0);
  const hasInitialSearchRunRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Request version that already surfaced a timeout. A late response for that
  // version must not flip the settled "timed out" UI back into loading/results.
  const timedOutVersionRef = useRef<number | null>(null);
  const indexBuildingRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 索引构建期间的重试计数，超过上限就停手，避免请求风暴。
  const autoRetryUsedRef = useRef(0);
  const handleSearchRef = useRef<HandleSearch | null>(null);
  const loadingMoreRef = useRef(false);

  const [searchParams, patchSearchParams] = useReducer(searchParamsReducer, initialSearchParams);

  const updateSearchParams = useCallback((patch: Partial<SearchParams>) => {
    latestSearchRef.current = { ...latestSearchRef.current, ...patch };
    patchSearchParams(patch);
  }, []);

  const handleStatusUpdate = useCallback(
    (scannedFiles: number, processedEvents: number, rescanErrors: number) => {
      dispatch({
        type: 'STATUS_UPDATE',
        payload: { scannedFiles, processedEvents, rescanErrors },
      });
    },
    [],
  );

  const setLifecycleState = useCallback((status: AppLifecycleStatus) => {
    dispatch({ type: 'SET_LIFECYCLE_STATE', payload: { status } });
  }, []);

  // 后端每次状态迁移都会 emit `app_lifecycle_state`；订阅它比轮询更及时。
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void listen<string>('app_lifecycle_state', (event) => {
      if (!disposed) {
        setLifecycleState(event.payload as AppLifecycleStatus);
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to subscribe app lifecycle state:', error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setLifecycleState]);

  // 索引加载完成前是 `Initializing`/`Updating`。轮询到 `Ready` 为止，
  // 供 `indexing` 提示与搜索可用性判断使用。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      try {
        const status = await invoke<AppLifecycleStatus>('get_app_status');
        if (cancelled) {
          return;
        }
        setLifecycleState(status);
        if (status === 'Ready') {
          return;
        }
      } catch (error) {
        console.error('Failed to fetch app lifecycle status:', error);
      }
      if (!cancelled) {
        timer = setTimeout(() => void poll(), 1000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [setLifecycleState]);

  const cancelPendingSearches = useCallback(() => {
    cancelTimer(debounceTimerRef);
    cancelTimer(loadingDelayTimerRef);
  }, []);

  // Drop the watchdog / retry timer when the hook unmounts so a pending timer
  // can never dispatch into a torn-down component.
  useEffect(
    () => () => {
      cancelTimer(watchdogTimerRef);
      cancelTimer(indexBuildingRetryTimerRef);
    },
    [],
  );

  const scheduleIndexBuildingRetry = useCallback(() => {
    // 索引构建/加载是有限时长（本机 3~15 秒），期间持续重试直到就绪；
    // 早期只给 1 次预算，首屏那次几乎必然撞上加载中，之后就再也不补搜索，
    // 表现就是 UI 永远停在「正在搜索…」。上限用次数兜底，防止真正卡死时
    // 变成请求风暴。
    if (autoRetryUsedRef.current >= MAX_INDEX_BUILDING_RETRIES) {
      console.info(`${LOG_PREFIX} state=index-building-retry-skipped reason=budget-exhausted`);
      return;
    }
    autoRetryUsedRef.current += 1;
    cancelTimer(indexBuildingRetryTimerRef);
    console.info(
      `${LOG_PREFIX} state=index-building-retry-scheduled attempt=${autoRetryUsedRef.current} delayMs=${SEARCH_INDEX_BUILDING_RETRY_DELAY_MS}`,
    );
    indexBuildingRetryTimerRef.current = setTimeout(() => {
      indexBuildingRetryTimerRef.current = null;
      void handleSearchRef.current?.({}, { autoRetry: true });
    }, SEARCH_INDEX_BUILDING_RETRY_DELAY_MS);
  }, []);

  const handleSearch = useCallback(
    async (overrides: Partial<SearchParams> = {}, options: HandleSearchOptions = {}) => {
      // A user-initiated search supersedes any queued automatic retry and
      // refills the retry budget.
      if (!options.autoRetry) {
        cancelTimer(indexBuildingRetryTimerRef);
        autoRetryUsedRef.current = 0;
      }

      const nextSearch = { ...latestSearchRef.current, ...overrides };
      latestSearchRef.current = nextSearch;
      // Monotonic request identity. Only the latest request may commit state.
      const requestVersion = searchVersionRef.current + 1;
      searchVersionRef.current = requestVersion;

      const { query, caseSensitive } = nextSearch;
      const startTs = performance.now();
      const isInitial = !hasInitialSearchRunRef.current;

      console.debug(
        `${LOG_PREFIX} request=${requestVersion} state=request query=${JSON.stringify(query)} caseSensitive=${caseSensitive} autoRetry=${Boolean(options.autoRetry)}`,
      );

      // 空输入没有任何信息量：不发请求，直接进入「输入关键词」引导态。
      // 索引构建进度由 lifecycle / scannedFiles 单独驱动。
      if (query.trim().length === 0 && !options.autoRetry) {
        dispatch({ type: 'SEARCH_IDLE' });
        hasInitialSearchRunRef.current = true;
        return;
      }

      dispatch({ type: 'SEARCH_REQUEST', payload: { immediate: isInitial } });

      // A newer request always supersedes the previous watchdog.
      cancelTimer(watchdogTimerRef);
      const watchdog = setTimeout(() => {
        watchdogTimerRef.current = null;
        if (searchVersionRef.current !== requestVersion) {
          return;
        }
        timedOutVersionRef.current = requestVersion;
        cancelTimer(loadingDelayTimerRef);
        const elapsedMs = Math.round(performance.now() - startTs);
        console.warn(
          `${LOG_PREFIX} request=${requestVersion} state=timeout elapsedMs=${elapsedMs} query=${JSON.stringify(query)}`,
        );
        dispatch({
          type: 'SEARCH_TIMEOUT',
          payload: {
            error: translateSearchKey(SEARCH_I18N.timeout),
            errorKey: SEARCH_I18N.timeout,
            duration: elapsedMs,
          },
        });
      }, SEARCH_TIMEOUT_MS);
      watchdogTimerRef.current = watchdog;

      if (!isInitial) {
        cancelTimer(loadingDelayTimerRef);
        loadingDelayTimerRef.current = setTimeout(() => {
          dispatch({ type: 'SEARCH_LOADING_DELAY' });
          loadingDelayTimerRef.current = null;
        }, SEARCH_LOADING_DELAY_MS);
      }

      try {
        const rawResults = await invoke<SearchResponsePayload>('search', {
          query,
          options: {
            caseInsensitive: !caseSensitive,
            // 空查询是有意义的：列出可搜索的文件/目录，但要分页，否则
            // 本机 549 万节点会把 IPC 打爆。
            limit: SEARCH_PAGE_SIZE,
            offset: options.offset ?? 0,
          },
          version: requestVersion,
        });

        if (searchVersionRef.current !== requestVersion) {
          // Superseded by a newer query: never overwrite newer state.
          console.debug(
            `${LOG_PREFIX} request=${requestVersion} state=stale-dropped current=${searchVersionRef.current}`,
          );
          return;
        }

        if (timedOutVersionRef.current === requestVersion) {
          console.warn(
            `${LOG_PREFIX} request=${requestVersion} state=late-response-dropped elapsedMs=${Math.round(
              performance.now() - startTs,
            )}`,
          );
          return;
        }

        const searchResults = (rawResults?.results ?? []) as SlabIndex[];
        const highlightTerms = Array.isArray(rawResults?.highlights)
          ? rawResults.highlights.filter((term): term is string => typeof term === 'string')
          : [];

        cancelTimer(loadingDelayTimerRef);

        const endTs = performance.now();
        const duration = endTs - startTs;

        console.info(
          `${LOG_PREFIX} request=${requestVersion} state=success elapsedMs=${Math.round(
            duration,
          )} results=${searchResults.length}`,
        );

        dispatch({
          type: 'SEARCH_SUCCESS',
          payload: {
            results: searchResults,
            query,
            duration,
            count: searchResults.length,
            highlightTerms,
            append: (options.offset ?? 0) > 0,
            total: rawResults?.total ?? searchResults.length,
          },
        });
      } catch (error) {
        if (searchVersionRef.current !== requestVersion) {
          console.debug(
            `${LOG_PREFIX} request=${requestVersion} state=stale-error-dropped current=${searchVersionRef.current}`,
          );
          return;
        }

        if (timedOutVersionRef.current === requestVersion) {
          console.warn(`${LOG_PREFIX} request=${requestVersion} state=late-error-dropped`);
          return;
        }

        cancelTimer(loadingDelayTimerRef);

        const duration = performance.now() - startTs;
        const elapsedMs = Math.round(duration);
        // Tauri rejects with the command's error payload. The Rust side now
        // fails fast with stable codes instead of leaving the promise pending.
        const rawMessage = normalizeBackendError(error);
        const kind = classifyBackendError(rawMessage);

        if (kind === 'index-building') {
          // Informational: the index is being rebuilt. Keep prior results,
          // surface the "indexing" hint, and retry after a short delay.
          console.info(
            `${LOG_PREFIX} request=${requestVersion} state=index-building elapsedMs=${elapsedMs}`,
          );
          dispatch({ type: 'SEARCH_INDEX_BUILDING', payload: { duration } });
          scheduleIndexBuildingRetry();
          return;
        }

        if (kind === 'timeout') {
          // Backend-side timeout. The frontend watchdog normally fires first,
          // but map it to the same user-facing message when it does not.
          console.warn(
            `${LOG_PREFIX} request=${requestVersion} state=backend-timeout elapsedMs=${elapsedMs}`,
          );
          dispatch({
            type: 'SEARCH_TIMEOUT',
            payload: {
              error: translateSearchKey(SEARCH_I18N.timeout),
              errorKey: SEARCH_I18N.timeout,
              duration,
            },
          });
          return;
        }

        // `search_worker_gone`, `search_failed: ...`, `search_dispatch_failed`,
        // `search_join_failed` and any unexpected IPC error all share the
        // generic failure surface; keep the raw text in the console for
        // reconciliation with the Rust logs.
        console.error(
          `${LOG_PREFIX} request=${requestVersion} state=failure elapsedMs=${elapsedMs} reason=${JSON.stringify(
            rawMessage,
          )}`,
          error,
        );

        dispatch({
          type: 'SEARCH_FAILURE',
          payload: {
            error: translateSearchKey(SEARCH_I18N.failed),
            errorKey: SEARCH_I18N.failed,
            duration,
          },
        });
      } finally {
        if (watchdogTimerRef.current === watchdog) {
          clearTimeout(watchdog);
          watchdogTimerRef.current = null;
        }
        hasInitialSearchRunRef.current = true;
      }
    },
    [scheduleIndexBuildingRetry],
  );

  useEffect(() => {
    handleSearchRef.current = handleSearch;
  }, [handleSearch]);

  const queueSearch = useCallback(
    (query: string, options?: QueueSearchOptions) => {
      updateSearchParams({ query });
      cancelPendingSearches();
      if (options?.immediate) {
        options.onSearchCommitted?.(query);
        void handleSearch({ query });
        return;
      }

      debounceTimerRef.current = setTimeout(() => {
        options?.onSearchCommitted?.(query);
        handleSearch({ query });
      }, SEARCH_DEBOUNCE_MS);
    },
    [cancelPendingSearches, handleSearch, updateSearchParams],
  );

  useEffect(() => cancelPendingSearches, [cancelPendingSearches]);

  useEffect(() => {
    if (!hasInitialSearchRunRef.current) {
      // 首屏不搜索：空输入直接进引导态，等用户输入关键词。
      hasInitialSearchRunRef.current = true;
      dispatch({ type: 'SEARCH_IDLE' });
      return;
    }

    if (!latestSearchRef.current.query) {
      return;
    }

    void handleSearch();
  }, [handleSearch, searchParams.caseSensitive]);

  const requestRescan = useCallback(async () => {
    await invoke('trigger_rescan');
  }, []);

  const hasMore = state.hasQuery && state.resultCount < state.total;

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current) {
      return;
    }
    if (!state.hasQuery || state.resultCount >= state.total) {
      return;
    }
    loadingMoreRef.current = true;
    console.info(`${LOG_PREFIX} state=load-more offset=${state.resultCount} total=${state.total}`);
    void handleSearch({}, { offset: state.resultCount }).finally(() => {
      loadingMoreRef.current = false;
    });
  }, [handleSearch, state.hasQuery, state.resultCount, state.total]);

  return {
    state,
    searchParams,
    updateSearchParams,
    queueSearch,
    handleStatusUpdate,
    setLifecycleState,
    requestRescan,
    loadMore,
    hasMore,
  };
}

export const SEARCH_I18N_KEYS = SEARCH_I18N;
