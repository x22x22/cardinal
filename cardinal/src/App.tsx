import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import './App.css';
import { FileRow } from './components/FileRow';
import { SearchBar } from './components/SearchBar';
import { FilesTabContent } from './components/FilesTabContent';
import { PermissionOverlay } from './components/PermissionOverlay';
import PreferencesOverlay from './components/PreferencesOverlay';
import StatusBar from './components/StatusBar';
import type { SearchResultItem } from './types/search';
import { useColumnResize } from './hooks/useColumnResize';
import { useContextMenu } from './hooks/useContextMenu';
import { useFileSearch } from './hooks/useFileSearch';
import { useEventColumnWidths } from './hooks/useEventColumnWidths';
import { useRecentFSEvents } from './hooks/useRecentFSEvents';
import { DEFAULT_SORTABLE_RESULT_THRESHOLD, useRemoteSort } from './hooks/useRemoteSort';
import { useSelection } from './hooks/useSelection';
import { useQuickLook } from './hooks/useQuickLook';
import { ROW_HEIGHT, OVERSCAN_ROW_COUNT } from './constants';
import type { VirtualListHandle } from './components/VirtualList';
import FSEventsPanel from './components/FSEventsPanel';
import type { FSEventsPanelHandle } from './components/FSEventsPanel';
import { useTranslation } from 'react-i18next';
import { useFullDiskAccessPermission } from './hooks/useFullDiskAccessPermission';
import type { DisplayState } from './components/StateDisplay';
import { openResultPath } from './utils/openResultPath';
import { useStableEvent } from './hooks/useStableEvent';
import { useAppHotkeys } from './hooks/useAppHotkeys';
import { useAppPreferences } from './hooks/useAppPreferences';
import { useAppWindowListeners } from './hooks/useAppWindowListeners';
import { useFilesTabEffects } from './hooks/useFilesTabEffects';
import { useFilesTabState } from './hooks/useFilesTabState';
import {
  applySearchAutocomplete,
  DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
  buildPathSuggestions,
  buildSearchQuery,
  getPathAutocompleteSuggestions,
  getSearchAutocompleteSuggestions,
  normalizeSearchAliasQuery,
  parseSearchInput,
  type SearchBuilderLabels,
  type SearchAutocompleteSuggestion,
  useSuggestionSelection,
  useSearchBuilder,
} from './hooks/useSearchBuilder';
import { open } from '@tauri-apps/plugin-dialog';

function App() {
  const {
    state,
    searchParams,
    updateSearchParams,
    queueSearch,
    handleStatusUpdate,
    setLifecycleState,
    requestRescan,
  } = useFileSearch();
  const {
    results,
    resultsVersion,
    scannedFiles,
    processedEvents,
    rescanErrors,
    currentQuery,
    highlightTerms,
    showLoadingUI,
    initialFetchCompleted,
    durationMs,
    resultCount,
    searchError,
    lifecycleState,
  } = state;

  const eventsPanelRef = useRef<FSEventsPanelHandle | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<VirtualListHandle | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const { colWidths, onResizeStart, autoFitColumns } = useColumnResize();
  const { caseSensitive } = searchParams;
  const { eventColWidths, onEventResizeStart, autoFitEventColumns } = useEventColumnWidths();
  const { t, i18n } = useTranslation();
  const autocompleteConfig = useMemo(
    () => ({
      file: {
        ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.file,
        label: t('search.filters.file'),
        description: t('search.autocomplete.fileDescription'),
        aliases: [t('search.filters.file'), t('search.autocomplete.fileAlias'), 'file', 'files'],
      },
      folder: {
        ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.folder,
        label: t('search.filters.folder'),
        description: t('search.autocomplete.folderDescription'),
        aliases: [t('search.filters.folder'), t('search.autocomplete.folderAlias'), 'folder', 'folders'],
      },
      ext: {
        ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.ext,
        label: t('search.filters.extension'),
        description: t('search.autocomplete.extensionDescription'),
        aliases: [t('search.filters.extension'), t('search.autocomplete.extensionAlias'), 'ext', 'extension'],
      },
      path: {
        ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.path,
        label: t('search.filters.path'),
        description: t('search.autocomplete.pathDescription'),
        aliases: [t('search.filters.path'), t('search.autocomplete.pathAlias'), 'path', 'under', 'in'],
      },
      dir: {
        ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.dir,
        label: t('search.autocomplete.dirLabel'),
        description: t('search.autocomplete.dirDescription'),
        aliases: [t('search.autocomplete.dirLabel'), t('search.autocomplete.dirAlias'), 'dir', 'root'],
      },
      regex: {
        ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.regex,
        label: t('search.filters.regex'),
        description: t('search.autocomplete.regexDescription'),
        aliases: [t('search.filters.regex'), t('search.autocomplete.regexAlias'), 'regex', 're'],
      },
    }),
    [t],
  );
  const searchBuilderLabels = useMemo<SearchBuilderLabels>(
    () => ({
      fileChip: t('search.filters.file'),
      folderChip: t('search.filters.folder'),
      regexChip: t('search.filters.regex'),
      extensionChip: t('search.filters.extension'),
      pathChip: t('search.autocomplete.pathAlias'),
      dirChip: t('search.autocomplete.dirLabel'),
    }),
    [t],
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const {
    keywordInput,
    setKeywordInput,
    filters,
    setTypeFilter,
    setUseRegex,
    setExtensionInput,
    toggleSuggestedExtension,
    setPathInput,
    setPathMode,
    rememberCurrentPath,
    clearFilter,
    resetFilters,
    chips,
    recentPaths,
  } = useSearchBuilder(searchParams.query, autocompleteConfig, searchBuilderLabels);
  const { selectedIndex, moveSelection: moveSuggestionSelection, resetSelection } =
    useSuggestionSelection();
  // `resultsVersion` tracks raw backend search result-set changes.
  // `displayedResultsVersion` additionally tracks UI ordering/projection changes (e.g. sort toggle).
  const {
    sortState,
    displayedResults,
    displayedResultsVersion,
    sortThreshold,
    setSortThreshold,
    sortDisabledTooltip,
    sortButtonsDisabled,
    handleSortToggle,
  } = useRemoteSort(results, resultsVersion, i18n.language, (limit) =>
    t('sorting.disabled', { limit }),
  );

  const {
    activeTab,
    isSearchFocused,
    handleSearchFocus,
    handleSearchBlur,
    eventFilterQuery,
    setEventFilterQuery,
    onTabChange,
    searchInputValue,
    onQueryChange,
    onSearchInputKeyDown,
    submitFilesQuery,
  } = useFilesTabState({
    searchQuery: searchParams.query,
    queueSearch,
    filesInputValue: keywordInput,
    onFilesInputChange: setKeywordInput,
    onSubmitFilesQuery: (query, options) => {
      const normalizedQuery = normalizeSearchAliasQuery(query, autocompleteConfig);
      const parsedQuery = parseSearchInput(normalizedQuery, autocompleteConfig);
      const nextQuery =
        activeTab === 'events'
          ? query
          : buildSearchQuery(
              parsedQuery.keyword,
              parsedQuery.hasStructuredFilters ? parsedQuery.filters : filters,
            );
      queueSearch(nextQuery, {
        immediate: options?.immediate,
      });
    },
    onSearchInputKeyDownOverride: (event) => {
      if (!(activeTab === 'files' && autocompleteSuggestions.length > 0)) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveSuggestionSelection(1, autocompleteSuggestions.length);
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        moveSuggestionSelection(-1, autocompleteSuggestions.length);
        return true;
      }

      if (event.key === 'Tab') {
        const suggestion = autocompleteSuggestions[selectedIndex];
        if (!suggestion) {
          return false;
        }
        event.preventDefault();
        setKeywordInput(applySearchAutocomplete(keywordInput, suggestion));
        resetSelection();
        return true;
      }

      return false;
    },
  });
  const { filteredEvents } = useRecentFSEvents({
    caseSensitive,
    isActive: activeTab === 'events',
    eventFilterQuery,
  });

  // Centralized selection management for the virtualized files list.
  // Provides memoized helpers for click/keyboard selection and keeps Quick Look hooks fed.
  const {
    selectedIndices,
    selectedIndicesRef,
    activeRowIndex,
    selectedPaths,
    handleRowSelect,
    selectSingleRow,
    clearSelection,
    moveSelection,
  } = useSelection(displayedResults, displayedResultsVersion, virtualListRef);

  const getQuickLookPaths = useCallback(
    () => (activeTab === 'files' ? selectedPaths : []),
    [activeTab, selectedPaths],
  );
  // Quick Look controller keeps preview panel in sync with whichever rows are currently selected.
  const { toggleQuickLook, updateQuickLook, closeQuickLook } = useQuickLook({
    getPaths: getQuickLookPaths,
  });

  const {
    showContextMenu: showFilesContextMenu,
    showHeaderContextMenu: showFilesHeaderContextMenu,
  } = useContextMenu(autoFitColumns, toggleQuickLook);

  const {
    showContextMenu: showEventsContextMenu,
    showHeaderContextMenu: showEventsHeaderContextMenu,
  } = useContextMenu(autoFitEventColumns);

  const {
    status: fullDiskAccessStatus,
    isChecking: isCheckingFullDiskAccess,
    requestPermission: requestFullDiskAccessPermission,
  } = useFullDiskAccessPermission();

  const focusSearchInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
  }, []);

  useEffect(() => {
    focusSearchInput();
  }, [focusSearchInput]);

  const refreshSearchResults = useCallback(() => {
    queueSearch(currentQuery, { immediate: true });
  }, [currentQuery, queueSearch]);

  const {
    isPreferencesOpen,
    closePreferences,
    trayIconEnabled,
    setTrayIconEnabled,
    windowActivationShortcut,
    defaultWindowActivationShortcut,
    handleWindowActivationShortcutChange,
    watchRoot,
    defaultWatchRoot,
    ignorePaths,
    defaultIgnorePaths,
    preferencesResetToken,
    handleWatchConfigChange,
    handleResetPreferences,
  } = useAppPreferences({
    fullDiskAccessStatus,
    isCheckingFullDiskAccess,
    refreshSearchResults,
    i18n,
  });

  useAppWindowListeners({
    activeTab,
    searchInputRef,
    focusSearchInput,
    handleStatusUpdate,
    setLifecycleState,
    submitFilesQuery,
    setEventFilterQuery,
  });

  const navigateSelection = useStableEvent(moveSelection);
  const triggerQuickLook = useStableEvent(toggleQuickLook);

  useAppHotkeys({
    activeTab,
    selectedPaths,
    selectedIndicesRef,
    focusSearchInput,
    navigateSelection,
    triggerQuickLook,
  });

  useFilesTabEffects({
    activeTab,
    selectedIndices,
    activeRowIndex,
    closeQuickLook,
    updateQuickLook,
    clearSelection,
    resultsVersion,
    virtualListRef,
    eventsPanelRef,
  });

  const onToggleCaseSensitive = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.checked;
      updateSearchParams({ caseSensitive: nextValue });
    },
    [updateSearchParams],
  );

  const handleHorizontalSync = useCallback((scrollLeft: number) => {
    // VirtualList drives the scroll position; mirror it onto the sticky header for alignment.
    if (headerRef.current) {
      headerRef.current.scrollLeft = scrollLeft;
    }
  }, []);

  const selectedIndexSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);

  const handleRowContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, path: string, rowIndex: number) => {
      const isRowSelected = selectedIndexSet.has(rowIndex);
      if (!isRowSelected) {
        selectSingleRow(rowIndex);
      }
      const targetPaths = isRowSelected && selectedPaths.length > 0 ? selectedPaths : [path];
      showFilesContextMenu(event, targetPaths);
    },
    [selectedIndexSet, selectedPaths, selectSingleRow, showFilesContextMenu],
  );

  const handleEventsContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, path: string) => {
      showEventsContextMenu(event, [path]);
    },
    [showEventsContextMenu],
  );

  const renderRow = useCallback(
    (rowIndex: number, item: SearchResultItem | undefined, rowStyle: CSSProperties) => {
      if (!item) {
        return (
          <div
            key={`placeholder-${rowIndex}`}
            className="row columns row-loading"
            style={{ ...rowStyle, width: 'var(--columns-total)' }}
          />
        );
      }

      return (
        <FileRow
          key={item.path}
          rowIndex={rowIndex}
          item={item}
          style={{ ...rowStyle, width: 'var(--columns-total)' }}
          isSelected={selectedIndexSet.has(rowIndex)}
          selectedPathsForDrag={selectedPaths}
          caseInsensitive={!caseSensitive}
          highlightTerms={highlightTerms}
          onContextMenu={handleRowContextMenu}
          onSelect={handleRowSelect}
          onOpen={openResultPath}
        />
      );
    },
    [
      handleRowContextMenu,
      handleRowSelect,
      highlightTerms,
      caseSensitive,
      selectedIndexSet,
      selectedPaths,
    ],
  );

  const displayState: DisplayState = (() => {
    if (!initialFetchCompleted) return 'loading';
    if (showLoadingUI) return 'loading';
    if (searchError) return 'error';
    if (results.length === 0) return 'empty';
    return 'results';
  })();
  const searchErrorMessage =
    typeof searchError === 'string' ? searchError : (searchError?.message ?? null);

  const containerStyle = useMemo(
    () =>
      ({
        '--w-filename': `${colWidths.filename}px`,
        '--w-path': `${colWidths.path}px`,
        '--w-size': `${colWidths.size}px`,
        '--w-modified': `${colWidths.modified}px`,
        '--w-created': `${colWidths.created}px`,
        '--w-event-flags': `${eventColWidths.event}px`,
        '--w-event-name': `${eventColWidths.name}px`,
        '--w-event-path': `${eventColWidths.path}px`,
        '--w-event-time': `${eventColWidths.time}px`,
        '--columns-events-total': `${
          eventColWidths.event + eventColWidths.name + eventColWidths.path + eventColWidths.time
        }px`,
      }) as CSSProperties,
    [colWidths, eventColWidths],
  );

  const showFullDiskAccessOverlay = fullDiskAccessStatus === 'denied';
  const overlayStatusMessage = isCheckingFullDiskAccess
    ? t('app.fullDiskAccess.status.checking')
    : t('app.fullDiskAccess.status.disabled');
  const caseSensitiveLabel = t('search.options.caseSensitive');
  const searchPlaceholder =
    activeTab === 'files' ? t('search.placeholder.files') : t('search.placeholder.events');
  const searchHelp = activeTab === 'files' ? t('search.help.files') : t('search.help.events');
  const filterButtonLabel = t('search.filters.toggle');
  const filterButtonTitle = t('search.filters.toggleTitle');
  const effectiveWatchRoot = watchRoot ?? defaultWatchRoot;
  const pathSuggestions = buildPathSuggestions(filters.pathInput || keywordInput, effectiveWatchRoot);
  const autocompleteSuggestions = useMemo(
    () => [
      ...getSearchAutocompleteSuggestions(keywordInput, autocompleteConfig),
      ...getPathAutocompleteSuggestions(keywordInput, effectiveWatchRoot, recentPaths),
    ],
    [autocompleteConfig, effectiveWatchRoot, keywordInput, recentPaths],
  );

  const handleOpenPathPicker = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: effectiveWatchRoot,
    });
    if (typeof selected !== 'string' || selected.length === 0) {
      return;
    }
    setPathInput(selected);
    rememberCurrentPath(selected);
  }, [effectiveWatchRoot, rememberCurrentPath, setPathInput]);

  const permissionSteps = [
    t('app.fullDiskAccess.steps.one'),
    t('app.fullDiskAccess.steps.two'),
    t('app.fullDiskAccess.steps.three'),
  ];
  const openSettingsLabel = t('app.fullDiskAccess.openSettings');
  const resultsContainerClassName = `results-container${
    isSearchFocused ? ' results-container--search-focused' : ''
  }`;

  return (
    <>
      <main className="container" aria-hidden={showFullDiskAccessOverlay || isPreferencesOpen}>
        <SearchBar
          inputRef={searchInputRef}
          placeholder={searchPlaceholder}
          title={searchHelp}
          value={searchInputValue}
          onChange={onQueryChange}
          onKeyDown={onSearchInputKeyDown}
          caseSensitive={caseSensitive}
          onToggleCaseSensitive={onToggleCaseSensitive}
          caseSensitiveLabel={caseSensitiveLabel}
          onFocus={handleSearchFocus}
          onBlur={handleSearchBlur}
          filterButtonLabel={filterButtonLabel}
          filterButtonTitle={filterButtonTitle}
          filtersOpen={filtersOpen && activeTab === 'files'}
          onToggleFilters={() => setFiltersOpen((prev) => !prev)}
          suggestions={autocompleteSuggestions}
          suggestionsLabel={t('search.filters.suggestions')}
          selectedSuggestionIndex={selectedIndex}
          onApplySuggestion={(suggestion: SearchAutocompleteSuggestion) => {
            setKeywordInput(applySearchAutocomplete(keywordInput, suggestion));
          }}
          filters={filters}
          onTypeFilterChange={setTypeFilter}
          onRegexChange={setUseRegex}
          onExtensionInputChange={setExtensionInput}
          onSuggestedExtensionToggle={toggleSuggestedExtension}
          onPathInputChange={setPathInput}
          onPathModeChange={setPathMode}
          onOpenPathPicker={handleOpenPathPicker}
          recentPaths={recentPaths}
          onRecentPathSelect={setPathInput}
          onRememberCurrentPath={rememberCurrentPath}
          clearFiltersLabel={t('search.filters.clear')}
          onClearFilters={resetFilters}
          chips={activeTab === 'files' ? chips : []}
          onRemoveChip={clearFilter}
          keywordLabel={t('search.filters.keyword')}
          typeLabel={t('search.filters.type')}
          regexLabel={t('search.filters.regex')}
          extensionLabel={t('search.filters.extension')}
          extensionPlaceholder={t('search.filters.extensionPlaceholder')}
          extensionSuggestionsLabel={t('search.filters.extensionSuggestions')}
          documentExtensionsLabel={t('search.filters.documentExtensions')}
          developmentExtensionsLabel={t('search.filters.developmentExtensions')}
          pathLabel={t('search.filters.path')}
          pathPlaceholder={t('search.filters.pathPlaceholder')}
          pathBrowseLabel={t('search.filters.pathBrowse')}
          pathPickerLabel={t('search.filters.pathPicker')}
          pathSuggestions={pathSuggestions}
          pathSuggestionsLabel={t('search.filters.pathSuggestions')}
          recentPathsLabel={t('search.filters.recentPaths')}
          recursiveLabel={t('search.filters.recursive')}
          directLabel={t('search.filters.direct')}
          fileLabel={t('search.filters.file')}
          folderLabel={t('search.filters.folder')}
          anyLabel={t('search.filters.any')}
        />
        <div className={resultsContainerClassName} style={containerStyle}>
          {activeTab === 'events' ? (
            <FSEventsPanel
              ref={eventsPanelRef}
              events={filteredEvents}
              onResizeStart={onEventResizeStart}
              onContextMenu={handleEventsContextMenu}
              onHeaderContextMenu={showEventsHeaderContextMenu}
              searchQuery={eventFilterQuery}
              caseInsensitive={!caseSensitive}
            />
          ) : (
            // `dataResultsVersion`: backend result-set changes. This resets row metadata cache.
            // `displayedResultsVersion`: visible-order/projection changes. This refreshes viewport
            // work such as icon hydration and frozen-view handoff in VirtualList.
            <FilesTabContent
              headerRef={headerRef}
              onResizeStart={onResizeStart}
              onHeaderContextMenu={showFilesHeaderContextMenu}
              displayState={displayState}
              searchErrorMessage={searchErrorMessage}
              currentQuery={currentQuery}
              virtualListRef={virtualListRef}
              results={displayedResults}
              dataResultsVersion={resultsVersion}
              displayedResultsVersion={displayedResultsVersion}
              rowHeight={ROW_HEIGHT}
              overscan={OVERSCAN_ROW_COUNT}
              renderRow={renderRow}
              onScrollSync={handleHorizontalSync}
              sortState={sortState}
              onSortToggle={handleSortToggle}
              sortDisabled={sortButtonsDisabled}
              sortDisabledTooltip={sortDisabledTooltip}
            />
          )}
        </div>
        <StatusBar
          scannedFiles={scannedFiles}
          processedEvents={processedEvents}
          lifecycleState={lifecycleState}
          searchDurationMs={durationMs}
          resultCount={resultCount}
          activeTab={activeTab}
          onTabChange={onTabChange}
          onRequestRescan={requestRescan}
          rescanErrorCount={rescanErrors}
        />
      </main>
      <PreferencesOverlay
        open={isPreferencesOpen}
        onClose={closePreferences}
        sortThreshold={sortThreshold}
        defaultSortThreshold={DEFAULT_SORTABLE_RESULT_THRESHOLD}
        onSortThresholdChange={setSortThreshold}
        trayIconEnabled={trayIconEnabled}
        onTrayIconEnabledChange={setTrayIconEnabled}
        windowActivationShortcut={windowActivationShortcut}
        defaultWindowActivationShortcut={defaultWindowActivationShortcut}
        onWindowActivationShortcutChange={handleWindowActivationShortcutChange}
        watchRoot={watchRoot ?? defaultWatchRoot}
        defaultWatchRoot={defaultWatchRoot}
        onWatchConfigChange={handleWatchConfigChange}
        ignorePaths={ignorePaths}
        defaultIgnorePaths={defaultIgnorePaths}
        onReset={handleResetPreferences}
        themeResetToken={preferencesResetToken}
      />
      {showFullDiskAccessOverlay && (
        <PermissionOverlay
          title={t('app.fullDiskAccess.title')}
          description={t('app.fullDiskAccess.description')}
          steps={permissionSteps}
          statusMessage={overlayStatusMessage}
          onRequestPermission={requestFullDiskAccessPermission}
          disabled={isCheckingFullDiskAccess}
          actionLabel={openSettingsLabel}
        />
      )}
    </>
  );
}

export default App;
