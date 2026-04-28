import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_PREFERENCES_EVENT } from '../../constants/appEvents';
import { applyThemePreference, persistThemePreference } from '../../theme';
import { setTrayEnabled } from '../../tray';
import {
  getStoredLaunchMinimizedToTray,
  persistLaunchMinimizedToTray,
} from '../../launchMinimizedToTrayPreference';
import { getStoredTrayIconEnabled, persistTrayIconEnabled } from '../../trayIconPreference';
import { setWatchConfig } from '../../utils/watchConfig';
import { setWindowActivationShortcut } from '../../utils/globalShortcuts';
import { getBrowserLanguage } from '../../i18n/config';
import {
  getStoredWindowActivationShortcut,
  persistWindowActivationShortcut,
} from '../../windowActivationShortcutPreference';
import { useIgnorePaths } from '../useIgnorePaths';
import { useWatchRoot } from '../useWatchRoot';
import { useAppPreferences } from '../useAppPreferences';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('../useWatchRoot', () => ({
  useWatchRoot: vi.fn(),
}));

vi.mock('../useIgnorePaths', () => ({
  useIgnorePaths: vi.fn(),
}));

vi.mock('../../trayIconPreference', () => ({
  getStoredTrayIconEnabled: vi.fn(),
  persistTrayIconEnabled: vi.fn(),
}));

vi.mock('../../launchMinimizedToTrayPreference', () => ({
  getStoredLaunchMinimizedToTray: vi.fn(),
  persistLaunchMinimizedToTray: vi.fn(),
}));

vi.mock('../../tray', () => ({
  setTrayEnabled: vi.fn(),
  updateTrayOpenAccelerator: vi.fn(),
}));

vi.mock('../../theme', () => ({
  applyThemePreference: vi.fn(),
  persistThemePreference: vi.fn(),
}));

vi.mock('../../utils/watchConfig', () => ({
  setWatchConfig: vi.fn(),
}));

vi.mock('../../utils/globalShortcuts', () => ({
  setWindowActivationShortcut: vi.fn(),
}));

vi.mock('../../windowActivationShortcutPreference', () => ({
  getStoredWindowActivationShortcut: vi.fn(),
  validateWindowActivationShortcut: (shortcut: string) => ({
    isValid: true,
    normalizedShortcut: shortcut.trim(),
  }),
  persistWindowActivationShortcut: vi.fn(),
}));

vi.mock('../../i18n/config', () => ({
  getBrowserLanguage: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);
const mockedUseWatchRoot = vi.mocked(useWatchRoot);
const mockedUseIgnorePaths = vi.mocked(useIgnorePaths);
const mockedGetStoredTrayIconEnabled = vi.mocked(getStoredTrayIconEnabled);
const mockedPersistTrayIconEnabled = vi.mocked(persistTrayIconEnabled);
const mockedGetStoredLaunchMinimizedToTray = vi.mocked(getStoredLaunchMinimizedToTray);
const mockedPersistLaunchMinimizedToTray = vi.mocked(persistLaunchMinimizedToTray);
const mockedSetTrayEnabled = vi.mocked(setTrayEnabled);
const mockedPersistThemePreference = vi.mocked(persistThemePreference);
const mockedApplyThemePreference = vi.mocked(applyThemePreference);
const mockedSetWatchConfig = vi.mocked(setWatchConfig);
const mockedSetWindowActivationShortcut = vi.mocked(setWindowActivationShortcut);
const mockedGetBrowserLanguage = vi.mocked(getBrowserLanguage);
const mockedGetStoredWindowActivationShortcut = vi.mocked(getStoredWindowActivationShortcut);
const mockedPersistWindowActivationShortcut = vi.mocked(persistWindowActivationShortcut);

describe('useAppPreferences', () => {
  const setWatchRoot = vi.fn();
  const setIgnorePaths = vi.fn();
  const changeLanguage = vi.fn().mockResolvedValue(undefined);
  const refreshSearchResults = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    mockedUseWatchRoot.mockReturnValue({
      watchRoot: '/workspace',
      setWatchRoot,
      defaultWatchRoot: '/',
    });
    mockedUseIgnorePaths.mockReturnValue({
      ignorePaths: ['/Volumes'],
      setIgnorePaths,
      defaultIgnorePaths: ['/Volumes'],
    });
    mockedGetStoredTrayIconEnabled.mockReturnValue(true);
    mockedGetStoredLaunchMinimizedToTray.mockReturnValue(false);
    mockedSetTrayEnabled.mockResolvedValue(true);
    mockedSetWatchConfig.mockResolvedValue(undefined);
    mockedSetWindowActivationShortcut.mockResolvedValue(undefined);
    mockedInvoke.mockResolvedValue(undefined);
    mockedGetBrowserLanguage.mockReturnValue('fr-FR');
    mockedGetStoredWindowActivationShortcut.mockReturnValue('');
  });

  it('updates window activation shortcut preference', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'denied',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await act(async () => {
      await result.current.handleWindowActivationShortcutChange(' Command+Shift+K ');
    });

    expect(mockedSetWindowActivationShortcut).toHaveBeenCalledWith('Command+Shift+K');
    expect(mockedPersistWindowActivationShortcut).toHaveBeenCalledWith('Command+Shift+K');
    expect(result.current.windowActivationShortcut).toBe('Command+Shift+K');
  });

  it('starts logic once when permission is granted', async () => {
    const { rerender } = renderHook((props) => useAppPreferences(props), {
      initialProps: {
        fullDiskAccessStatus: 'granted' as const,
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      },
    });

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    rerender({
      fullDiskAccessStatus: 'granted' as const,
      isCheckingFullDiskAccess: false,
      refreshSearchResults,
      i18n: { changeLanguage },
    });

    expect(mockedInvoke.mock.calls.filter(([command]) => command === 'start_logic')).toHaveLength(
      1,
    );
  });

  it('hides the main window on startup when launch minimized to tray is enabled', async () => {
    mockedGetStoredTrayIconEnabled.mockReturnValue(false);
    mockedGetStoredLaunchMinimizedToTray.mockReturnValue(true);

    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'denied',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    expect(result.current.launchMinimizedToTray).toBe(true);
    await waitFor(() => {
      expect(mockedSetTrayEnabled).toHaveBeenCalledWith(true, { silent: true });
      expect(mockedInvoke).toHaveBeenCalledWith('hide_main_window');
    });
    expect(mockedPersistLaunchMinimizedToTray).toHaveBeenCalledWith(true);
  });

  it('shows the main window on startup when tray initialization fails', async () => {
    mockedGetStoredTrayIconEnabled.mockReturnValue(false);
    mockedGetStoredLaunchMinimizedToTray.mockReturnValue(true);
    mockedSetTrayEnabled.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'denied',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('activate_main_window');
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith('hide_main_window');
  });

  it('updates watch config and refreshes search when preferences change', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'granted',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    mockedSetWatchConfig.mockClear();
    refreshSearchResults.mockClear();

    act(() => {
      result.current.handleWatchConfigChange({
        watchRoot: '/tmp',
        ignorePaths: ['/tmp/ignore'],
      });
    });

    expect(setWatchRoot).toHaveBeenCalledWith('/tmp');
    expect(setIgnorePaths).toHaveBeenCalledWith(['/tmp/ignore']);
    expect(mockedSetWatchConfig).toHaveBeenCalledWith({
      watchRoot: '/tmp',
      ignorePaths: ['/tmp/ignore'],
    });
    expect(refreshSearchResults).toHaveBeenCalledTimes(1);
  });

  it('skips setWatchConfig when watch config is unchanged', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'granted',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    mockedSetWatchConfig.mockClear();
    refreshSearchResults.mockClear();
    setWatchRoot.mockClear();
    setIgnorePaths.mockClear();

    act(() => {
      result.current.handleWatchConfigChange({
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    expect(setWatchRoot).not.toHaveBeenCalled();
    expect(setIgnorePaths).not.toHaveBeenCalled();
    expect(mockedSetWatchConfig).not.toHaveBeenCalled();
    expect(refreshSearchResults).not.toHaveBeenCalled();
  });

  it('updates watch config when only watchRoot changes', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'granted',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    mockedSetWatchConfig.mockClear();
    refreshSearchResults.mockClear();
    setWatchRoot.mockClear();
    setIgnorePaths.mockClear();

    act(() => {
      result.current.handleWatchConfigChange({
        watchRoot: '/new-root',
        ignorePaths: ['/Volumes'], // same as before
      });
    });

    expect(setWatchRoot).toHaveBeenCalledWith('/new-root');
    expect(setIgnorePaths).toHaveBeenCalledWith(['/Volumes']);
    expect(mockedSetWatchConfig).toHaveBeenCalledWith({
      watchRoot: '/new-root',
      ignorePaths: ['/Volumes'],
    });
    expect(refreshSearchResults).toHaveBeenCalledTimes(1);
  });

  it('updates watch config when only ignorePaths changes', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'granted',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    mockedSetWatchConfig.mockClear();
    refreshSearchResults.mockClear();
    setWatchRoot.mockClear();
    setIgnorePaths.mockClear();

    act(() => {
      result.current.handleWatchConfigChange({
        watchRoot: '/workspace', // same as before
        ignorePaths: ['/tmp/ignore'], // different
      });
    });

    expect(setWatchRoot).toHaveBeenCalledWith('/workspace');
    expect(setIgnorePaths).toHaveBeenCalledWith(['/tmp/ignore']);
    expect(mockedSetWatchConfig).toHaveBeenCalledWith({
      watchRoot: '/workspace',
      ignorePaths: ['/tmp/ignore'],
    });
    expect(refreshSearchResults).toHaveBeenCalledTimes(1);
  });

  it('passes glob-style ignore patterns through watch config updates', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'granted',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes'],
      });
    });

    mockedSetWatchConfig.mockClear();
    setIgnorePaths.mockClear();

    act(() => {
      result.current.handleWatchConfigChange({
        watchRoot: '/workspace',
        ignorePaths: ['**/node_modules', '.git/**'],
      });
    });

    expect(setIgnorePaths).toHaveBeenCalledWith(['**/node_modules', '.git/**']);
    expect(mockedSetWatchConfig).toHaveBeenCalledWith({
      watchRoot: '/workspace',
      ignorePaths: ['**/node_modules', '.git/**'],
    });
  });

  it('treats reordered ignorePaths as a change', async () => {
    // areStringArraysEqual is index-sensitive: same strings in different order
    // must NOT be treated as equal, so the update must fire.
    mockedUseIgnorePaths.mockReturnValue({
      ignorePaths: ['/Volumes', '/System'],
      setIgnorePaths,
      defaultIgnorePaths: ['/Volumes', '/System'],
    });

    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'granted',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('start_logic', {
        watchRoot: '/workspace',
        ignorePaths: ['/Volumes', '/System'],
      });
    });

    mockedSetWatchConfig.mockClear();
    refreshSearchResults.mockClear();
    setWatchRoot.mockClear();
    setIgnorePaths.mockClear();

    act(() => {
      result.current.handleWatchConfigChange({
        watchRoot: '/workspace',
        ignorePaths: ['/System', '/Volumes'], // same items, different order
      });
    });

    expect(mockedSetWatchConfig).toHaveBeenCalledWith({
      watchRoot: '/workspace',
      ignorePaths: ['/System', '/Volumes'],
    });
    expect(refreshSearchResults).toHaveBeenCalledTimes(1);
  });

  it('opens and closes preferences, and resets user preferences', async () => {
    const { result } = renderHook(() =>
      useAppPreferences({
        fullDiskAccessStatus: 'denied',
        isCheckingFullDiskAccess: false,
        refreshSearchResults,
        i18n: { changeLanguage },
      }),
    );

    await waitFor(() => {
      expect(mockedSetTrayEnabled).toHaveBeenCalledWith(true);
    });

    mockedSetTrayEnabled.mockClear();
    mockedPersistTrayIconEnabled.mockClear();
    mockedPersistLaunchMinimizedToTray.mockClear();

    act(() => {
      window.dispatchEvent(new Event(OPEN_PREFERENCES_EVENT));
    });
    expect(result.current.isPreferencesOpen).toBe(true);

    act(() => {
      result.current.closePreferences();
    });
    expect(result.current.isPreferencesOpen).toBe(false);

    const initialToken = result.current.preferencesResetToken;
    act(() => {
      result.current.handleResetPreferences();
    });

    await waitFor(() => {
      expect(mockedSetTrayEnabled).toHaveBeenCalledWith(true);
    });
    expect(mockedPersistTrayIconEnabled).toHaveBeenCalledWith(false);
    expect(mockedPersistLaunchMinimizedToTray).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(mockedSetWindowActivationShortcut).toHaveBeenCalledWith('');
    });
    expect(mockedPersistWindowActivationShortcut).toHaveBeenCalledWith('');
    expect(mockedPersistThemePreference).toHaveBeenCalledWith('system');
    expect(mockedApplyThemePreference).toHaveBeenCalledWith('system');
    expect(changeLanguage).toHaveBeenCalledWith('fr-FR');
    expect(result.current.preferencesResetToken).toBe(initialToken + 1);
  });
});
