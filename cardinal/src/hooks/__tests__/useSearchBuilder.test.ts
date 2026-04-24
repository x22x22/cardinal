import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  applySearchAutocomplete,
  DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
  buildPathSuggestions,
  buildSearchQuery,
  getPathAutocompleteSuggestions,
  getSearchAutocompleteSuggestions,
  normalizeSearchAliasQuery,
  parseSearchInput,
  useSearchBuilder,
  useSuggestionSelection,
} from '../useSearchBuilder';

const ENGLISH_AUTOCOMPLETE_CONFIG = {
  ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
  file: {
    ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.file,
    label: 'Files',
    description: 'Filter files',
    aliases: ['files', 'file', 'fi'],
  },
  folder: {
    ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.folder,
    label: 'Folders',
    description: 'Filter folders',
    aliases: ['folders', 'folder', 'fo'],
  },
  ext: {
    ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.ext,
    label: 'Extension',
    description: 'Filter by extension',
    aliases: ['extension', 'ext', 'suffix'],
  },
  path: {
    ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.path,
    label: 'Path scope',
    description: 'Filter by path scope',
    aliases: ['path', 'scope', 'under', 'in'],
  },
  dir: {
    ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.dir,
    label: 'Directory',
    description: 'Filter current folder only',
    aliases: ['directory', 'dir', 'root'],
  },
  regex: {
    ...DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG.regex,
    label: 'Regex',
    description: 'Switch to regular expression',
    aliases: ['regex', 're', 'pattern'],
  },
};

describe('buildSearchQuery', () => {
  it('builds keyword only query', () => {
    expect(
      buildSearchQuery('report', {
        type: 'any',
        useRegex: false,
        extensionInput: '',
        pathInput: '',
        pathMode: 'recursive',
      }),
    ).toBe('report');
  });

  it('combines type, keyword, extension and path filters', () => {
    expect(
      buildSearchQuery('button', {
        type: 'file',
        useRegex: false,
        extensionInput: 'ts,tsx',
        pathInput: 'src/components',
        pathMode: 'recursive',
      }),
    ).toBe('file: button ext:ts;tsx path:src/components');
  });

  it('uses regex and direct path mode', () => {
    expect(
      buildSearchQuery('^App', {
        type: 'folder',
        useRegex: true,
        extensionInput: '',
        pathInput: 'src pages',
        pathMode: 'direct',
      }),
    ).toBe('folder: regex:^App dir:"src pages"');
  });

  it('toggles suggested extensions and remembers recent paths', () => {
    const { result } = renderHook(() => useSearchBuilder());

    act(() => {
      result.current.toggleSuggestedExtension('ts');
      result.current.toggleSuggestedExtension('tsx');
    });
    expect(result.current.filters.extensionInput).toBe('ts, tsx');

    act(() => {
      result.current.toggleSuggestedExtension('ts');
    });
    expect(result.current.filters.extensionInput).toBe('tsx');

    act(() => {
      result.current.setPathInput('src/components');
      result.current.rememberCurrentPath('src/components');
      result.current.setPathInput('src/pages');
      result.current.rememberCurrentPath('src/pages');
    });

    expect(result.current.recentPaths).toEqual(['src/pages', 'src/components']);
  });

  it('builds path picker suggestions from watch root and current path', () => {
    expect(buildPathSuggestions('src/components', '/Users/demo/workspace')).toEqual([
      'src/components',
      'src',
      '/Users/demo/workspace',
      'workspace',
    ]);
  });

  it('cycles suggestion selection safely', () => {
    const { result } = renderHook(() => useSuggestionSelection());

    act(() => {
      result.current.moveSelection(1, 3);
    });
    expect(result.current.selectedIndex).toBe(1);

    act(() => {
      result.current.moveSelection(1, 3);
      result.current.moveSelection(1, 3);
    });
    expect(result.current.selectedIndex).toBe(0);
  });

  it('supports chinese autocomplete and tab insertion', () => {
    const suggestions = getSearchAutocompleteSuggestions('后');
    expect(suggestions[0]?.label).toBe('后缀');
    expect(applySearchAutocomplete('后', suggestions[0]!)).toBe('ext:');
  });

  it('supports raw syntax keyword autocomplete like ext', () => {
    const suggestions = getSearchAutocompleteSuggestions('ext');
    expect(suggestions[0]?.insertText).toBe('ext:');
  });

  it('supports locale-driven autocomplete labels and aliases', () => {
    expect(getSearchAutocompleteSuggestions('ex', ENGLISH_AUTOCOMPLETE_CONFIG)[0]?.label).toBe(
      'Extension',
    );
    expect(normalizeSearchAliasQuery('Files suffix:ts scope:src pattern:^App', ENGLISH_AUTOCOMPLETE_CONFIG)).toBe(
      'file: ext:ts path:src regex:^App',
    );
  });

  it('includes syntax preview in autocomplete suggestions', () => {
    const suggestions = getSearchAutocompleteSuggestions('ext');
    expect(suggestions[0]?.syntaxPreview).toBe('ext:');
  });

  it('supports extension value autocomplete and inserts trailing space', () => {
    const suggestions = getSearchAutocompleteSuggestions('ext:t');
    expect(suggestions.map((item) => item.label)).toEqual(
      expect.arrayContaining(['ts', 'tsx', 'txt']),
    );
    expect(applySearchAutocomplete('ext:t', suggestions[0]!)).toBe(`${suggestions[0]!.insertText} `);
  });

  it('supports path and dir value autocomplete from recent paths and watch root', () => {
    expect(
      getPathAutocompleteSuggestions('path:src', '/Users/demo/workspace', ['src/hooks', 'src/pages'])
        .map((item) => item.label),
    ).toEqual(expect.arrayContaining(['src/hooks', 'src/pages', 'src']));

    expect(applySearchAutocomplete('dir:src', getPathAutocompleteSuggestions('dir:src', '', ['src pages'])[0]!)).toBe(
      'dir:"src pages" ',
    );
  });

  it('supports quoted path autocomplete while typing spaced paths', () => {
    const suggestions = getPathAutocompleteSuggestions('dir:"src p', '', ['src pages', 'src panels']);
    expect(suggestions.map((item) => item.label)).toEqual(
      expect.arrayContaining(['src pages', 'src panels', 'src p']),
    );
    expect(applySearchAutocomplete('dir:"src p', suggestions[0]!)).toBe('dir:"src pages" ');
  });

  it('normalizes chinese alias query into engine syntax', () => {
    expect(normalizeSearchAliasQuery('文件 后缀:ts 路径:src 正则:^App')).toBe(
      'file: ext:ts path:src regex:^App',
    );
  });

  it('parses structured query back into keyword and filters', () => {
    expect(parseSearchInput('file: ext:ts;tsx dir:"src pages" regex:^App')).toEqual({
      keyword: '^App',
      hasStructuredFilters: true,
      filters: {
        type: 'file',
        useRegex: true,
        extensionInput: 'ts, tsx',
        pathInput: 'src pages',
        pathMode: 'direct',
      },
    });
  });

  it('parses backend path aliases back into builder filters', () => {
    expect(parseSearchInput('under:packages/app root:src regex:main')).toEqual({
      keyword: 'main',
      hasStructuredFilters: true,
      filters: {
        type: 'any',
        useRegex: true,
        extensionInput: '',
        pathInput: 'src',
        pathMode: 'direct',
      },
    });

    expect(parseSearchInput('in:docs guide')).toEqual({
      keyword: 'guide',
      hasStructuredFilters: true,
      filters: {
        type: 'any',
        useRegex: false,
        extensionInput: '',
        pathInput: 'docs',
        pathMode: 'recursive',
      },
    });
  });

  it('syncs handwritten query syntax back into builder filters', () => {
    const { result } = renderHook(() => useSearchBuilder());

    act(() => {
      result.current.setKeywordInput('folder: ext:md path:docs regex:guide');
    });

    expect(result.current.filters).toEqual({
      type: 'folder',
      useRegex: true,
      extensionInput: 'md',
      pathInput: 'docs',
      pathMode: 'recursive',
    });
    expect(result.current.builtQuery).toBe('folder: regex:guide ext:md path:docs');
  });

  it('renders chips from provided i18n labels', () => {
    const { result } = renderHook(() =>
      useSearchBuilder(
        '',
        DEFAULT_SEARCH_AUTOCOMPLETE_CONFIG,
        {
          fileChip: 'Files',
          folderChip: 'Folders',
          regexChip: 'Regex',
          extensionChip: 'Extension',
          pathChip: 'Scope',
          dirChip: 'Directory',
        },
      ),
    );

    act(() => {
      result.current.setKeywordInput('file: ext:md root:docs regex:guide');
    });

    expect(result.current.chips.map((chip) => chip.label)).toEqual([
      'Files',
      'Regex',
      'Extension: md',
      'Directory: docs',
    ]);
  });

  it('syncs locale-specific handwritten syntax back into builder filters', () => {
    const { result } = renderHook(() => useSearchBuilder('', ENGLISH_AUTOCOMPLETE_CONFIG));

    act(() => {
      result.current.setKeywordInput('Files suffix:md scope:docs pattern:guide');
    });

    expect(result.current.filters).toEqual({
      type: 'file',
      useRegex: true,
      extensionInput: 'md',
      pathInput: 'docs',
      pathMode: 'recursive',
    });
  });
});
