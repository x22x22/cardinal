import { useCallback, useMemo, useState } from 'react';

export type SearchTypeFilter = 'any' | 'file' | 'folder';
export type SearchPathMode = 'recursive' | 'direct';

export type SearchFilters = {
  type: SearchTypeFilter;
  useRegex: boolean;
  extensionInput: string;
  pathInput: string;
  pathMode: SearchPathMode;
};

export type SearchChip = {
  id: 'type' | 'regex' | 'ext' | 'path';
  label: string;
};

export type SearchSuggestion = {
  id: string;
  label: string;
  description: string;
  apply: 'keyword' | 'regex' | 'path' | 'extension';
  value: string;
};

export type SearchAutocompleteSuggestion = {
  id: string;
  label: string;
  description: string;
  insertText: string;
  syntaxPreview?: string;
};

export type SearchAutocompleteKeyword = 'file' | 'folder' | 'ext' | 'path' | 'dir' | 'regex';

export type SearchAutocompleteConfig = Record<
  SearchAutocompleteKeyword,
  {
    label: string;
    description: string;
    aliases: string[];
    insertText: string;
  }
>;

export type SearchBuilderLabels = {
  fileChip: string;
  folderChip: string;
  regexChip: string;
  extensionChip: string;
  pathChip: string;
  dirChip: string;
};

export type SearchSuggestionState = {
  selectedIndex: number;
  setSelectedIndex: (value: number) => void;
  moveSelection: (direction: 1 | -1, total: number) => void;
  resetSelection: () => void;
};

export const SUGGESTED_EXTENSION_GROUPS = [
  {
    key: 'document',
    extensions: [
      'md',
      'txt',
      'pdf',
      'doc',
      'docx',
      'ppt',
      'pptx',
      'xls',
      'xlsx',
      'csv',
    ] as const,
  },
  {
    key: 'development',
    extensions: ['ts', 'tsx', 'js', 'jsx', 'java', 'py', 'rs', 'json'] as const,
  },
] as const;

export const DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG: SearchAutocompleteConfig = {
  file: {
    label: '文件',
    description: '筛选文件',
    aliases: ['文件', '文', 'file', 'files'],
    insertText: 'file:',
  },
  folder: {
    label: '文件夹',
    description: '筛选文件夹',
    aliases: ['文件夹', '夹', 'folder', 'folders'],
    insertText: 'folder:',
  },
  ext: {
    label: '后缀',
    description: '按后缀筛选',
    aliases: ['后缀', '扩展名', 'ext', 'extension'],
    insertText: 'ext:',
  },
  path: {
    label: '路径',
    description: '按路径范围筛选',
    aliases: ['路径', '范围', 'path', 'under', 'in'],
    insertText: 'path:',
  },
  dir: {
    label: '目录',
    description: '仅当前目录筛选',
    aliases: ['目录', 'dir', 'root'],
    insertText: 'dir:',
  },
  regex: {
    label: '正则',
    description: '切换到正则表达式',
    aliases: ['正则', 'regex', 're'],
    insertText: 'regex:',
  },
};

type UseSearchBuilderResult = {
  keywordInput: string;
  setKeywordInput: (value: string) => void;
  filters: SearchFilters;
  setTypeFilter: (value: SearchTypeFilter) => void;
  setUseRegex: (value: boolean) => void;
  setExtensionInput: (value: string) => void;
  toggleSuggestedExtension: (value: string) => void;
  setPathInput: (value: string) => void;
  setPathMode: (value: SearchPathMode) => void;
  rememberCurrentPath: (value?: string) => void;
  clearFilter: (id: SearchChip['id']) => void;
  resetFilters: () => void;
  chips: SearchChip[];
  recentPaths: string[];
  builtQuery: string;
  hasActiveFilters: boolean;
};

const DEFAULT_FILTERS: SearchFilters = {
  type: 'any',
  useRegex: false,
  extensionInput: '',
  pathInput: '',
  pathMode: 'recursive',
};

const DEFAULT_SEARCH_BUILDER_LABELS: SearchBuilderLabels = {
  fileChip: '文件',
  folderChip: '文件夹',
  regexChip: '正则',
  extensionChip: '后缀',
  pathChip: '范围',
  dirChip: '目录',
};

const SEARCH_AUTOCOMPLETE_ORDER: SearchAutocompleteKeyword[] = [
  'file',
  'folder',
  'ext',
  'path',
  'dir',
  'regex',
];

const splitExtensions = (value: string): string[] =>
  value
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/^\./, ''))
    .filter((part) => part.length > 0);

const quoteIfNeeded = (value: string): string =>
  /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;

const joinExtensions = (values: string[]): string => values.join(', ');

const ALL_SUGGESTED_EXTENSIONS = Array.from(
  new Set(SUGGESTED_EXTENSION_GROUPS.flatMap((group) => [...group.extensions])),
);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildAutocompleteSuggestions(
  config: SearchAutocompleteConfig,
): SearchAutocompleteSuggestion[] {
  return SEARCH_AUTOCOMPLETE_ORDER.map((key) => ({
    id: key,
    label: config[key].label,
    description: config[key].description,
    insertText: config[key].insertText,
    syntaxPreview: config[key].insertText,
  }));
}

function tokenizeSearchInput(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of input.trim()) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function unquoteSearchValue(value: string): string {
  return value.trim().replace(/^"|"$/g, '');
}

export function parseSearchInput(
  input: string,
  config: SearchAutocompleteConfig = DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
): {
  keyword: string;
  filters: SearchFilters;
  hasStructuredFilters: boolean;
} {
  const normalized = normalizeSearchAliasQuery(input, config);
  const tokens = tokenizeSearchInput(normalized);
  const filters: SearchFilters = { ...DEFAULT_FILTERS };
  const keywordParts: string[] = [];
  let hasStructuredFilters = false;

  for (const token of tokens) {
    if (token === 'file:') {
      hasStructuredFilters = true;
      filters.type = 'file';
      continue;
    }

    if (token === 'folder:') {
      hasStructuredFilters = true;
      filters.type = 'folder';
      continue;
    }

    if (token.startsWith('ext:')) {
      hasStructuredFilters = true;
      filters.extensionInput = joinExtensions(splitExtensions(token.slice(4)));
      continue;
    }

    if (token.startsWith('path:') || token.startsWith('under:') || token.startsWith('in:')) {
      hasStructuredFilters = true;
      filters.pathMode = 'recursive';
      filters.pathInput = unquoteSearchValue(token.slice(token.indexOf(':') + 1));
      continue;
    }

    if (token.startsWith('dir:') || token.startsWith('root:')) {
      hasStructuredFilters = true;
      filters.pathMode = 'direct';
      filters.pathInput = unquoteSearchValue(token.slice(token.indexOf(':') + 1));
      continue;
    }

    if (token.startsWith('regex:')) {
      hasStructuredFilters = true;
      filters.useRegex = true;
      keywordParts.push(token.slice(6));
      continue;
    }

    keywordParts.push(token);
  }

  return {
    keyword: keywordParts.join(' ').trim(),
    filters,
    hasStructuredFilters,
  };
}

function activeTokenBounds(input: string): { start: number; end: number; token: string } {
  const trimmedEnd = input.length;
  const leading = input.slice(0, trimmedEnd);
  const quotedPathMatch = /(path:|dir:)(?:"[^"]*|[^\s]*)$/i.exec(leading);
  if (quotedPathMatch) {
    const start = quotedPathMatch.index;
    return {
      start,
      end: trimmedEnd,
      token: input.slice(start, trimmedEnd),
    };
  }
  const lastWhitespace = Math.max(leading.lastIndexOf(' '), leading.lastIndexOf('\n'), leading.lastIndexOf('\t'));
  const start = lastWhitespace + 1;
  return {
    start,
    end: trimmedEnd,
    token: input.slice(start, trimmedEnd),
  };
}

export function getSearchAutocompleteSuggestions(
  input: string,
  config: SearchAutocompleteConfig = DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
): SearchAutocompleteSuggestion[] {
  const { token } = activeTokenBounds(input);
  const prefix = token.trim();
  if (!prefix) {
    return [];
  }

  if (prefix.startsWith('ext:')) {
    const extPrefix = prefix.slice(4).replace(/^\./, '').trim().toLowerCase();
    return ALL_SUGGESTED_EXTENSIONS.filter((extension) => extension.startsWith(extPrefix)).map(
      (extension) => ({
        id: `ext-value:${extension}`,
        label: extension,
        description: '补全后缀值',
        insertText: `ext:${extension}`,
        syntaxPreview: `ext:${extension}`,
      }),
    );
  }

  if (prefix.startsWith('path:') || prefix.startsWith('dir:')) {
    return [];
  }

  if (prefix.includes(':')) {
    return [];
  }

  const normalizedPrefix = prefix.toLocaleLowerCase();
  return buildAutocompleteSuggestions(config).filter((suggestion) => {
    const entry = config[suggestion.id as SearchAutocompleteKeyword];
    const terms = [suggestion.label, suggestion.id, ...entry.aliases].map((value) =>
      value.toLocaleLowerCase(),
    );
    return terms.some((term) => term.startsWith(normalizedPrefix));
  });
}

export function applySearchAutocomplete(
  input: string,
  suggestion: SearchAutocompleteSuggestion,
): string {
  const { start, end } = activeTokenBounds(input);
  const replacement = suggestion.insertText.endsWith(':') ? suggestion.insertText : `${suggestion.insertText} `;
  return `${input.slice(0, start)}${replacement}${input.slice(end)}`;
}

export function getPathAutocompleteSuggestions(
  input: string,
  watchRoot: string,
  recentPaths: string[],
): SearchAutocompleteSuggestion[] {
  const { token } = activeTokenBounds(input);
  const pathMatch = /^(path:|dir:)(.*)$/i.exec(token.trim());
  if (!pathMatch) {
    return [];
  }

  const operator = pathMatch[1];
  const rawValue = unquoteSearchValue(pathMatch[2]);
  const candidates = [
    ...recentPaths,
    ...buildPathSuggestions(rawValue, watchRoot),
  ];
  const unique = Array.from(new Set(candidates.filter((item) => item.length > 0)));
  return unique
    .filter((item) => rawValue.length === 0 || item.toLowerCase().includes(rawValue.toLowerCase()))
    .slice(0, 8)
    .map((item) => ({
      id: `${operator}${item}`,
      label: item,
      description: '补全路径值',
      insertText: `${operator}${/\s/.test(item) ? `"${item}"` : item}`,
      syntaxPreview: `${operator}${/\s/.test(item) ? `"${item}"` : item}`,
    }));
}

export function normalizeSearchAliasQuery(
  input: string,
  config: SearchAutocompleteConfig = DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
): string {
  return SEARCH_AUTOCOMPLETE_ORDER.reduce((current, key) => {
    const aliases = Array.from(new Set([key, ...config[key].aliases])).sort(
      (left, right) => right.length - left.length,
    );
    const pattern = aliases.map(escapeRegex).join('|');
    if (key === 'file' || key === 'folder') {
      return current
        .replace(new RegExp(`(^|\\s)(${pattern})(?=\\s|$)`, 'gi'), `$1${key}:`)
        .replace(new RegExp(`(^|\\s)(${pattern}):`, 'gi'), `$1${key}:`);
    }
    return current.replace(new RegExp(`(^|\\s)(${pattern}):`, 'gi'), `$1${key}:`);
  }, input);
}

export function buildSearchQuery(keywordInput: string, filters: SearchFilters): string {
  const parts: string[] = [];
  const keyword = keywordInput.trim();

  if (filters.type === 'file') {
    parts.push('file:');
  } else if (filters.type === 'folder') {
    parts.push('folder:');
  }

  if (keyword) {
    parts.push(filters.useRegex ? `regex:${keyword}` : keyword);
  }

  const extensions = splitExtensions(filters.extensionInput);
  if (extensions.length > 0) {
    parts.push(`ext:${extensions.join(';')}`);
  }

  const path = filters.pathInput.trim();
  if (path) {
    const operator = filters.pathMode === 'direct' ? 'dir' : 'path';
    parts.push(`${operator}:${quoteIfNeeded(path)}`);
  }

  return parts.join(' ').trim();
}

export function buildPathSuggestions(pathInput: string, watchRoot: string): string[] {
  const trimmed = pathInput.trim();
  const root = watchRoot.trim();
  const next = new Set<string>();

  if (trimmed) {
    next.add(trimmed);
    const segments = trimmed.split(/[\\/]+/).filter(Boolean);
    if (segments.length > 1) {
      next.add(segments.slice(0, -1).join('/'));
    }
  }

  if (root) {
    next.add(root);
    const rootSegments = root.split(/[\\/]+/).filter(Boolean);
    const rootName = rootSegments[rootSegments.length - 1];
    if (rootName) {
      next.add(rootName);
    }
  }

  next.delete('');
  return Array.from(next).slice(0, 8);
}

export function useSuggestionSelection(): SearchSuggestionState {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const moveSelection = useCallback((direction: 1 | -1, total: number) => {
    if (total <= 0) {
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex((prev) => {
      const next = prev + direction;
      if (next < 0) {
        return total - 1;
      }
      if (next >= total) {
        return 0;
      }
      return next;
    });
  }, []);

  const resetSelection = useCallback(() => {
    setSelectedIndex(0);
  }, []);

  return {
    selectedIndex,
    setSelectedIndex,
    moveSelection,
    resetSelection,
  };
}

export function useSearchBuilder(
  initialQuery = '',
  autocompleteConfig: SearchAutocompleteConfig = DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
  labels: SearchBuilderLabels = DEFAULT_SEARCH_BUILDER_LABELS,
): UseSearchBuilderResult {
  const initialParsed = parseSearchInput(initialQuery, autocompleteConfig);
  const [keywordInputState, setKeywordInputState] = useState(initialQuery);
  const [filters, setFilters] = useState<SearchFilters>(initialParsed.filters);
  const [inputControlsFilters, setInputControlsFilters] = useState(initialParsed.hasStructuredFilters);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);

  const setKeywordInput = useCallback((value: string) => {
    setKeywordInputState(value);
    const parsed = parseSearchInput(value, autocompleteConfig);
    setInputControlsFilters((prev) => parsed.hasStructuredFilters || (prev && value.trim().length > 0));
    setFilters((prev) => {
      if (!parsed.hasStructuredFilters && !inputControlsFilters) {
        return prev;
      }
      return parsed.filters;
    });
  }, [autocompleteConfig, inputControlsFilters]);

  const setTypeFilter = useCallback((value: SearchTypeFilter) => {
    setInputControlsFilters(false);
    setFilters((prev) => ({ ...prev, type: value }));
  }, []);

  const setUseRegex = useCallback((value: boolean) => {
    setInputControlsFilters(false);
    setFilters((prev) => ({ ...prev, useRegex: value }));
  }, []);

  const setExtensionInput = useCallback((value: string) => {
    setInputControlsFilters(false);
    setFilters((prev) => ({ ...prev, extensionInput: value }));
  }, []);

  const toggleSuggestedExtension = useCallback((value: string) => {
    const normalized = value.trim().replace(/^\./, '');
    if (!normalized) {
      return;
    }
    setInputControlsFilters(false);
    setFilters((prev) => {
      const existing = splitExtensions(prev.extensionInput);
      const next = existing.includes(normalized)
        ? existing.filter((item) => item !== normalized)
        : [...existing, normalized];
      return {
        ...prev,
        extensionInput: joinExtensions(next),
      };
    });
  }, []);

  const setPathInput = useCallback((value: string) => {
    setInputControlsFilters(false);
    setFilters((prev) => ({ ...prev, pathInput: value }));
  }, []);

  const setPathMode = useCallback((value: SearchPathMode) => {
    setInputControlsFilters(false);
    setFilters((prev) => ({ ...prev, pathMode: value }));
  }, []);

  const rememberCurrentPath = useCallback((value?: string) => {
    const path = (value ?? filters.pathInput).trim();
    if (!path) {
      return;
    }
    setRecentPaths((prev) => {
      const next = [path, ...prev.filter((item) => item !== path)];
      return next.slice(0, 6);
    });
  }, [filters.pathInput]);

  const clearFilter = useCallback((id: SearchChip['id']) => {
    setInputControlsFilters(false);
    if (id === 'type') {
      setFilters((prev) => ({ ...prev, type: 'any' }));
      return;
    }
    if (id === 'regex') {
      setFilters((prev) => ({ ...prev, useRegex: false }));
      return;
    }
    if (id === 'ext') {
      setFilters((prev) => ({ ...prev, extensionInput: '' }));
      return;
    }
    setFilters((prev) => ({ ...prev, pathInput: '', pathMode: 'recursive' }));
  }, []);

  const resetFilters = useCallback(() => {
    setInputControlsFilters(false);
    setFilters(DEFAULT_FILTERS);
  }, []);

  const chips = useMemo<SearchChip[]>(() => {
    const next: SearchChip[] = [];
    if (filters.type === 'file') {
      next.push({ id: 'type', label: labels.fileChip });
    } else if (filters.type === 'folder') {
      next.push({ id: 'type', label: labels.folderChip });
    }

    if (filters.useRegex) {
      next.push({ id: 'regex', label: labels.regexChip });
    }

    const extensions = splitExtensions(filters.extensionInput);
    if (extensions.length > 0) {
      next.push({ id: 'ext', label: `${labels.extensionChip}: ${extensions.join(', ')}` });
    }

    const path = filters.pathInput.trim();
    if (path) {
      next.push({
        id: 'path',
        label: `${filters.pathMode === 'direct' ? labels.dirChip : labels.pathChip}: ${path}`,
      });
    }

    return next;
  }, [filters, labels]);

  const builtQuery = useMemo(() => {
    const parsed = parseSearchInput(keywordInputState, autocompleteConfig);
    return buildSearchQuery(parsed.keyword, parsed.hasStructuredFilters ? parsed.filters : filters);
  }, [autocompleteConfig, filters, keywordInputState]);
  const hasActiveFilters = chips.length > 0;

  return {
    keywordInput: keywordInputState,
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
    builtQuery,
    hasActiveFilters,
  };
}
