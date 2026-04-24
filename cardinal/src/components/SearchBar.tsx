import React from 'react';
import type { ChangeEvent, FocusEventHandler } from 'react';
import {
  SUGGESTED_EXTENSION_GROUPS,
  type SearchAutocompleteSuggestion,
  type SearchChip,
  type SearchFilters,
  type SearchPathMode,
  type SearchTypeFilter,
} from '../hooks/useSearchBuilder';

type SearchBarProps = {
  inputRef: React.Ref<HTMLInputElement>;
  placeholder: string;
  title?: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  caseSensitive: boolean;
  onToggleCaseSensitive: (event: ChangeEvent<HTMLInputElement>) => void;
  caseSensitiveLabel: string;
  onFocus: FocusEventHandler<HTMLInputElement>;
  onBlur: FocusEventHandler<HTMLInputElement>;
  filterButtonLabel: string;
  filterButtonTitle: string;
  filtersOpen: boolean;
  onToggleFilters: () => void;
  suggestions: SearchAutocompleteSuggestion[];
  suggestionsLabel: string;
  selectedSuggestionIndex: number;
  onApplySuggestion: (suggestion: SearchAutocompleteSuggestion) => void;
  filters: SearchFilters;
  onTypeFilterChange: (value: SearchTypeFilter) => void;
  onRegexChange: (value: boolean) => void;
  onExtensionInputChange: (value: string) => void;
  onSuggestedExtensionToggle: (value: string) => void;
  onPathInputChange: (value: string) => void;
  onPathModeChange: (value: SearchPathMode) => void;
  onOpenPathPicker: () => Promise<void>;
  recentPaths: string[];
  onRecentPathSelect: (value: string) => void;
  onRememberCurrentPath: (value?: string) => void;
  clearFiltersLabel: string;
  onClearFilters: () => void;
  chips: SearchChip[];
  onRemoveChip: (id: SearchChip['id']) => void;
  keywordLabel: string;
  typeLabel: string;
  regexLabel: string;
  extensionLabel: string;
  extensionPlaceholder: string;
  extensionSuggestionsLabel: string;
  documentExtensionsLabel: string;
  developmentExtensionsLabel: string;
  pathLabel: string;
  pathPlaceholder: string;
  pathBrowseLabel: string;
  pathPickerLabel: string;
  pathSuggestions: string[];
  pathSuggestionsLabel: string;
  recentPathsLabel: string;
  recursiveLabel: string;
  directLabel: string;
  fileLabel: string;
  folderLabel: string;
  anyLabel: string;
};

export function SearchBar({
  inputRef,
  placeholder,
  title,
  value,
  onChange,
  onKeyDown,
  caseSensitive,
  onToggleCaseSensitive,
  caseSensitiveLabel,
  onFocus,
  onBlur,
  filterButtonLabel,
  filterButtonTitle,
  filtersOpen,
  onToggleFilters,
  suggestions,
  suggestionsLabel,
  selectedSuggestionIndex,
  onApplySuggestion,
  filters,
  onTypeFilterChange,
  onRegexChange,
  onExtensionInputChange,
  onSuggestedExtensionToggle,
  onPathInputChange,
  onPathModeChange,
  onOpenPathPicker,
  recentPaths,
  onRecentPathSelect,
  onRememberCurrentPath,
  clearFiltersLabel,
  onClearFilters,
  chips,
  onRemoveChip,
  keywordLabel,
  typeLabel,
  regexLabel,
  extensionLabel,
  extensionPlaceholder,
  extensionSuggestionsLabel,
  documentExtensionsLabel,
  developmentExtensionsLabel,
  pathLabel,
  pathPlaceholder,
  pathBrowseLabel,
  pathPickerLabel,
  pathSuggestions,
  pathSuggestionsLabel,
  recentPathsLabel,
  recursiveLabel,
  directLabel,
  fileLabel,
  folderLabel,
  anyLabel,
}: SearchBarProps): React.JSX.Element {
  return (
    <div className="search-container">
      <div className="search-bar">
        <div className="search-input-stack">
          <input
            id="search-input"
            ref={inputRef}
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            title={title}
            spellCheck={false}
            autoCorrect="off"
            autoComplete="off"
            autoCapitalize="off"
            onFocus={onFocus}
            onBlur={onBlur}
            aria-label={keywordLabel}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={suggestions.length > 0}
            aria-controls={suggestions.length > 0 ? 'search-suggestion-listbox' : undefined}
            aria-activedescendant={
              selectedSuggestionIndex >= 0 && selectedSuggestionIndex < suggestions.length
                ? `search-suggestion-option-${suggestions[selectedSuggestionIndex]?.id}`
                : undefined
            }
            aria-haspopup="listbox"
          />
          {suggestions.length > 0 ? (
            <div className="search-suggestion-dropdown">
              <span
                id="search-suggestion-listbox-label"
                className="search-filter-suggestions__label"
              >
                {suggestionsLabel}
              </span>
              <div
                id="search-suggestion-listbox"
                className="search-suggestion-dropdown__list"
                role="listbox"
                aria-label={suggestionsLabel}
                aria-labelledby="search-suggestion-listbox-label"
              >
                {suggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.id}
                    id={`search-suggestion-option-${suggestion.id}`}
                    type="button"
                    role="option"
                    aria-selected={index === selectedSuggestionIndex}
                    className={`search-suggestion${index === selectedSuggestionIndex ? ' is-active' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onApplySuggestion(suggestion)}
                  >
                    <span className="search-suggestion__label">{suggestion.label}</span>
                    <span className="search-suggestion__description">
                      {suggestion.description}
                      {suggestion.syntaxPreview ? ` · ${suggestion.syntaxPreview}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div className="search-options">
          <button
            type="button"
            className={`search-filter-toggle${filtersOpen ? ' search-filter-toggle--active' : ''}`}
            onClick={onToggleFilters}
            title={filterButtonTitle}
            aria-expanded={filtersOpen}
          >
            {filterButtonLabel}
          </button>
          <label className="search-option" title={caseSensitiveLabel}>
            <input
              type="checkbox"
              checked={caseSensitive}
              onChange={onToggleCaseSensitive}
              aria-label={caseSensitiveLabel}
            />
            <span className="search-option__display" aria-hidden="true">
              Aa
            </span>
            <span className="sr-only">{caseSensitiveLabel}</span>
          </label>
        </div>
      </div>

      {chips.length > 0 ? (
        <div className="search-chips">
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="search-chip"
              onClick={() => onRemoveChip(chip.id)}
              aria-label={`${chip.label} x`}
            >
              <span>{chip.label}</span>
              <span className="search-chip__remove" aria-hidden="true">
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {filtersOpen ? (
        <div className="search-filter-panel">
          <div className="search-filter-grid">
            <label className="search-filter-field">
              <span className="search-filter-label">{typeLabel}</span>
              <div className="search-segmented-control">
                <button
                  type="button"
                  className={filters.type === 'any' ? 'is-active' : ''}
                  onClick={() => onTypeFilterChange('any')}
                >
                  {anyLabel}
                </button>
                <button
                  type="button"
                  className={filters.type === 'file' ? 'is-active' : ''}
                  onClick={() => onTypeFilterChange('file')}
                >
                  {fileLabel}
                </button>
                <button
                  type="button"
                  className={filters.type === 'folder' ? 'is-active' : ''}
                  onClick={() => onTypeFilterChange('folder')}
                >
                  {folderLabel}
                </button>
              </div>
            </label>

            <label className="search-filter-field search-filter-field--checkbox">
              <span className="search-filter-label">{regexLabel}</span>
              <input
                type="checkbox"
                checked={filters.useRegex}
                onChange={(event) => onRegexChange(event.target.checked)}
              />
            </label>

            <label className="search-filter-field">
              <span className="search-filter-label">{extensionLabel}</span>
              <input
                type="text"
                value={filters.extensionInput}
                onChange={(event) => onExtensionInputChange(event.target.value)}
                placeholder={extensionPlaceholder}
              />
              <div className="search-filter-suggestions">
                <span className="search-filter-suggestions__label">{extensionSuggestionsLabel}</span>
                {SUGGESTED_EXTENSION_GROUPS.map((group) => {
                  const groupLabel =
                    group.key === 'document' ? documentExtensionsLabel : developmentExtensionsLabel;
                  return (
                    <div key={group.key} className="search-filter-group">
                      <span className="search-filter-group__title">{groupLabel}</span>
                      <div className="search-filter-suggestions__list">
                        {group.extensions.map((extension) => {
                          const active = filters.extensionInput
                            .split(/[\s,;]+/)
                            .map((part) => part.trim().replace(/^\./, ''))
                            .filter((part) => part.length > 0)
                            .includes(extension);
                          return (
                            <button
                              key={extension}
                              type="button"
                              className={active ? 'is-active' : ''}
                              onClick={() => onSuggestedExtensionToggle(extension)}
                            >
                              .{extension}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </label>

            <label className="search-filter-field search-filter-field--wide">
              <span className="search-filter-label">{pathLabel}</span>
              <div className="search-path-picker">
                <input
                  type="text"
                  value={filters.pathInput}
                  onChange={(event) => onPathInputChange(event.target.value)}
                  placeholder={pathPlaceholder}
                />
                <button
                  type="button"
                  className="search-path-picker__action"
                  onClick={onOpenPathPicker}
                >
                  {pathBrowseLabel}
                </button>
                <button
                  type="button"
                  className="search-path-picker__action"
                  onClick={() => onRememberCurrentPath(filters.pathInput)}
                >
                  {pathPickerLabel}
                </button>
              </div>
              {recentPaths.length > 0 ? (
                <div className="search-filter-suggestions">
                  <span className="search-filter-suggestions__label">{recentPathsLabel}</span>
                  <div className="search-filter-suggestions__list">
                    {recentPaths.map((path) => (
                      <button key={path} type="button" onClick={() => onRecentPathSelect(path)}>
                        {path}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {pathSuggestions.length > 0 ? (
                <div className="search-filter-suggestions">
                  <span className="search-filter-suggestions__label">{pathSuggestionsLabel}</span>
                  <div className="search-filter-suggestions__list">
                    {pathSuggestions.map((path) => (
                      <button key={path} type="button" onClick={() => onRecentPathSelect(path)}>
                        {path}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className="search-segmented-control search-segmented-control--compact">
                <button
                  type="button"
                  className={filters.pathMode === 'recursive' ? 'is-active' : ''}
                  onClick={() => onPathModeChange('recursive')}
                >
                  {recursiveLabel}
                </button>
                <button
                  type="button"
                  className={filters.pathMode === 'direct' ? 'is-active' : ''}
                  onClick={() => onPathModeChange('direct')}
                >
                  {directLabel}
                </button>
              </div>
            </label>
          </div>

          <div className="search-filter-actions">
            <button type="button" className="search-filter-clear" onClick={onClearFilters}>
              {clearFiltersLabel}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
