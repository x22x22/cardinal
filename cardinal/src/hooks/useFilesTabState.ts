import { useCallback, useMemo, useState } from 'react';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { StatusTabKey } from '../components/StatusBar';
import { useSearchHistory } from './useSearchHistory';

type QueueSearchOptions = {
  immediate?: boolean;
  onSearchCommitted?: (query: string) => void;
};

type UseFilesTabStateOptions = {
  searchQuery: string;
  queueSearch: (query: string, options?: QueueSearchOptions) => void;
  filesInputValue?: string;
  onFilesInputChange?: (value: string) => void;
  onSubmitFilesQuery?: (query: string, options?: { immediate?: boolean }) => void;
  onSearchInputKeyDownOverride?: (event: ReactKeyboardEvent<HTMLInputElement>) => boolean;
  maxSearchHistoryEntries?: number;
};

type UseFilesTabStateResult = {
  activeTab: StatusTabKey;
  setActiveTab: (tab: StatusTabKey) => void;
  onTabChange: (tab: StatusTabKey) => void;
  isSearchFocused: boolean;
  handleSearchFocus: () => void;
  handleSearchBlur: () => void;
  eventFilterQuery: string;
  setEventFilterQuery: (value: string) => void;
  searchInputValue: string;
  onQueryChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSearchInputKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  submitFilesQuery: (query: string, options?: { immediate?: boolean }) => void;
};

/**
 * Manages files/events tab UI state, including search input behavior and history navigation.
 */
export function useFilesTabState({
  searchQuery,
  queueSearch,
  filesInputValue,
  onFilesInputChange,
  onSubmitFilesQuery,
  onSearchInputKeyDownOverride,
  maxSearchHistoryEntries = 50,
}: UseFilesTabStateOptions): UseFilesTabStateResult {
  const [activeTab, setActiveTab] = useState<StatusTabKey>('files');
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const [eventFilterQuery, setEventFilterQuery] = useState('');
  const {
    handleInputChange: updateHistoryFromInput,
    navigate: navigateSearchHistory,
    ensureTailValue: ensureHistoryBuffer,
    resetCursorToTail,
  } = useSearchHistory({ maxEntries: maxSearchHistoryEntries });

  const handleSearchFocus = useCallback(() => {
    setIsSearchFocused(true);
  }, []);

  const handleSearchBlur = useCallback(() => {
    setIsSearchFocused(false);
  }, []);

  const submitFilesQuery = useCallback(
    (query: string, options?: { immediate?: boolean }) => {
      onFilesInputChange?.(query);
      if (onSubmitFilesQuery) {
        onSubmitFilesQuery(query, options);
        return;
      }

      queueSearch(query, {
        immediate: options?.immediate,
        onSearchCommitted: updateHistoryFromInput,
      });
    },
    [onFilesInputChange, onSubmitFilesQuery, queueSearch, updateHistoryFromInput],
  );

  const handleHistoryNavigation = useCallback(
    (direction: 'older' | 'newer') => {
      if (activeTab !== 'files') {
        return;
      }

      const nextValue = navigateSearchHistory(direction);
      if (nextValue === null) {
        return;
      }

      queueSearch(nextValue);
    },
    [activeTab, navigateSearchHistory, queueSearch],
  );

  const onSearchInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (onSearchInputKeyDownOverride?.(event)) {
        return;
      }

      if (activeTab !== 'files') {
        return;
      }

      if (event.key === 'Enter') {
        submitFilesQuery(event.currentTarget.value, { immediate: true });
        return;
      }

      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }

      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) {
        return;
      }

      event.preventDefault();
      handleHistoryNavigation(event.key === 'ArrowUp' ? 'older' : 'newer');
    },
    [activeTab, handleHistoryNavigation, onSearchInputKeyDownOverride, submitFilesQuery],
  );

  const onQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const inputValue = event.target.value;

      if (activeTab === 'events') {
        setEventFilterQuery(inputValue);
        return;
      }

      onFilesInputChange?.(inputValue);
      submitFilesQuery(inputValue);
    },
    [activeTab, onFilesInputChange, submitFilesQuery],
  );

  const onTabChange = useCallback(
    (nextTab: StatusTabKey) => {
      setActiveTab(nextTab);

      if (nextTab === 'events') {
        setEventFilterQuery('');
        resetCursorToTail();
        return;
      }

      ensureHistoryBuffer('');
      queueSearch('', { immediate: true });
    },
    [ensureHistoryBuffer, queueSearch, resetCursorToTail],
  );

  const searchInputValue = useMemo(
    () => (activeTab === 'events' ? eventFilterQuery : (filesInputValue ?? searchQuery)),
    [activeTab, eventFilterQuery, filesInputValue, searchQuery],
  );

  return {
    activeTab,
    setActiveTab,
    onTabChange,
    isSearchFocused,
    handleSearchFocus,
    handleSearchBlur,
    eventFilterQuery,
    setEventFilterQuery,
    searchInputValue,
    onQueryChange,
    onSearchInputKeyDown,
    submitFilesQuery,
  };
}
