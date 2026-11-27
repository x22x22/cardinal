import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { i18n as I18nInstance } from 'i18next';
import { OPEN_PREFERENCES_EVENT } from '../constants/appEvents';
import { getBrowserLanguage } from '../i18n/config';
import { applyThemePreference, persistThemePreference } from '../theme';
import { setTrayEnabled, updateTrayOpenAccelerator } from '../tray';
import {
  getStoredLaunchMinimizedToTray,
  persistLaunchMinimizedToTray,
} from '../launchMinimizedToTrayPreference';
import { getStoredTrayIconEnabled, persistTrayIconEnabled } from '../trayIconPreference';
import { setWatchConfig } from '../utils/watchConfig';
import { setWindowActivationShortcut } from '../utils/globalShortcuts';
import {
  getStoredWindowActivationShortcut,
  persistWindowActivationShortcut,
  validateWindowActivationShortcut,
} from '../windowActivationShortcutPreference';
import {
  DEFAULT_RESULT_OPEN_SHORTCUT,
  getStoredResultOpenShortcut,
  persistResultOpenShortcut,
  validateResultOpenShortcut,
} from '../resultOpenShortcutPreference';
import type { FullDiskAccessStatus } from './useFullDiskAccessPermission';
import { useIgnorePaths } from './useIgnorePaths';
import { useWatchRoots } from './useWatchRoot';

type WatchConfigChangePayload = {
  watchRoots: string[];
  ignorePaths: string[];
};

type UseAppPreferencesOptions = {
  fullDiskAccessStatus: FullDiskAccessStatus;
  isCheckingFullDiskAccess: boolean;
  refreshSearchResults: () => void;
  i18n: Pick<I18nInstance, 'changeLanguage'>;
};

type UseAppPreferencesResult = {
  isPreferencesOpen: boolean;
  closePreferences: () => void;
  trayIconEnabled: boolean;
  setTrayIconEnabled: (enabled: boolean) => void;
  launchMinimizedToTray: boolean;
  setLaunchMinimizedToTray: (enabled: boolean) => void;
  windowActivationShortcut: string;
  defaultWindowActivationShortcut: string;
  handleWindowActivationShortcutChange: (shortcut: string) => Promise<void>;
  resultOpenShortcut: string;
  defaultResultOpenShortcut: string;
  handleResultOpenShortcutChange: (shortcut: string) => void;
  watchRoots: string[];
  defaultWatchRoots: string[];
  ignorePaths: string[];
  defaultIgnorePaths: string[];
  preferencesResetToken: number;
  handleWatchConfigChange: (next: WatchConfigChangePayload) => void;
  handleResetPreferences: () => void;
};

const areStringArraysEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Manages app preferences including watch config, tray, theme, language, and overlay state.
 * Provides actions for updating watch settings and resetting preferences to defaults.
 */
export function useAppPreferences({
  fullDiskAccessStatus,
  isCheckingFullDiskAccess,
  refreshSearchResults,
  i18n,
}: UseAppPreferencesOptions): UseAppPreferencesResult {
  const { watchRoots, setWatchRoots, defaultWatchRoots } = useWatchRoots();
  const { ignorePaths, setIgnorePaths, defaultIgnorePaths } = useIgnorePaths();
  const logicStartedRef = useRef(false);
  const startupMinimizeHandledRef = useRef(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [trayIconEnabled, setTrayIconEnabled] = useState<boolean>(() => getStoredTrayIconEnabled());
  const [launchMinimizedToTray, setLaunchMinimizedToTray] = useState<boolean>(() =>
    getStoredLaunchMinimizedToTray(),
  );
  const [windowActivationShortcut, setWindowActivationShortcutState] = useState<string>(() =>
    getStoredWindowActivationShortcut(),
  );
  const [resultOpenShortcut, setResultOpenShortcutState] = useState<string>(() =>
    getStoredResultOpenShortcut(),
  );
  const [preferencesResetToken, setPreferencesResetToken] = useState(0);

  useEffect(() => {
    persistTrayIconEnabled(trayIconEnabled);
    persistLaunchMinimizedToTray(launchMinimizedToTray);
    void setTrayEnabled(trayIconEnabled || launchMinimizedToTray);
  }, [launchMinimizedToTray, trayIconEnabled]);

  useEffect(() => {
    if (startupMinimizeHandledRef.current) {
      return;
    }

    startupMinimizeHandledRef.current = true;
    if (launchMinimizedToTray) {
      void setTrayEnabled(true, { silent: true }).then((initialized) => {
        if (initialized) {
          return invoke('hide_main_window');
        }
        return invoke('activate_main_window');
      });
    } else {
      void invoke('activate_main_window');
    }
  }, [launchMinimizedToTray]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleOpenPreferences = () => setIsPreferencesOpen(true);
    window.addEventListener(OPEN_PREFERENCES_EVENT, handleOpenPreferences);
    return () => window.removeEventListener(OPEN_PREFERENCES_EVENT, handleOpenPreferences);
  }, []);

  useEffect(() => {
    // 启动配置是索引构建的唯一入口：条件不满足时必须留下可查的痕迹，
    // 否则表现就是「界面在、但索引永远不开始」。
    const blockedReason = isCheckingFullDiskAccess
      ? 'checking_full_disk_access'
      : fullDiskAccessStatus !== 'granted'
        ? 'full_disk_access_denied'
        : watchRoots.length === 0
          ? 'watch_root_empty'
          : logicStartedRef.current
            ? 'already_started'
            : null;

    if (blockedReason) {
      console.log(`[cardinal.boot] start_logic 未触发：${blockedReason}`);
      if (blockedReason !== 'already_started' && blockedReason !== 'checking_full_disk_access') {
        void invoke('log_frontend_error', {
          message: `start_logic 未触发：${blockedReason}`,
        }).catch(() => {});
      }
      return;
    }

    logicStartedRef.current = true;
    console.log('[cardinal.boot] 发送 start_logic', { watchRoots, ignorePaths });
    void invoke('start_logic', {
      watchRoot: watchRoots[0] ?? '/',
      watchRoots,
      ignorePaths,
    });
  }, [fullDiskAccessStatus, ignorePaths, isCheckingFullDiskAccess, watchRoots]);

  const applyWatchConfig = useCallback(
    (nextWatchRoots: string[], nextIgnorePaths: string[]) => {
      const watchConfigChanged =
        !areStringArraysEqual(nextWatchRoots, watchRoots) ||
        !areStringArraysEqual(nextIgnorePaths, ignorePaths);

      if (!watchConfigChanged) {
        return;
      }

      setWatchRoots(nextWatchRoots);
      setIgnorePaths(nextIgnorePaths);
      if (logicStartedRef.current && nextWatchRoots.length > 0) {
        void setWatchConfig({
          watchRoot: nextWatchRoots[0] ?? '/',
          watchRoots: nextWatchRoots,
          ignorePaths: nextIgnorePaths,
        });
      }
      refreshSearchResults();
    },
    [ignorePaths, refreshSearchResults, setIgnorePaths, setWatchRoots, watchRoots],
  );

  const handleWatchConfigChange = useCallback(
    (next: WatchConfigChangePayload) => {
      applyWatchConfig(next.watchRoots, next.ignorePaths);
    },
    [applyWatchConfig],
  );

  const handleWindowActivationShortcutChange = useCallback(async (shortcut: string) => {
    const validationResult = validateWindowActivationShortcut(shortcut);
    if (!validationResult.isValid) {
      throw new Error(validationResult.errorKey);
    }

    const normalizedShortcut = validationResult.normalizedShortcut;

    await setWindowActivationShortcut(normalizedShortcut);
    persistWindowActivationShortcut(normalizedShortcut);
    setWindowActivationShortcutState(normalizedShortcut);
    await updateTrayOpenAccelerator(normalizedShortcut);
  }, []);

  const handleResultOpenShortcutChange = useCallback((shortcut: string) => {
    const validationResult = validateResultOpenShortcut(shortcut);
    if (!validationResult.isValid) {
      throw new Error(validationResult.errorKey);
    }

    persistResultOpenShortcut(validationResult.normalizedShortcut);
    setResultOpenShortcutState(validationResult.normalizedShortcut);
  }, []);

  const handleResetPreferences = useCallback(() => {
    setTrayIconEnabled(false);
    setLaunchMinimizedToTray(true);
    void handleWindowActivationShortcutChange('').catch((error) => {
      console.error('Failed to reset window activation shortcut', error);
    });
    handleResultOpenShortcutChange(DEFAULT_RESULT_OPEN_SHORTCUT);
    persistThemePreference('system');
    applyThemePreference('system');
    const nextLanguage = getBrowserLanguage();
    void i18n.changeLanguage(nextLanguage);
    setPreferencesResetToken((token) => token + 1);
  }, [handleResultOpenShortcutChange, handleWindowActivationShortcutChange, i18n]);

  const closePreferences = useCallback(() => setIsPreferencesOpen(false), []);

  return {
    isPreferencesOpen,
    closePreferences,
    trayIconEnabled,
    setTrayIconEnabled,
    launchMinimizedToTray,
    setLaunchMinimizedToTray,
    windowActivationShortcut,
    defaultWindowActivationShortcut: '',
    handleWindowActivationShortcutChange,
    resultOpenShortcut,
    defaultResultOpenShortcut: DEFAULT_RESULT_OPEN_SHORTCUT,
    handleResultOpenShortcutChange,
    watchRoots,
    defaultWatchRoots,
    ignorePaths,
    defaultIgnorePaths,
    preferencesResetToken,
    handleWatchConfigChange,
    handleResetPreferences,
  };
}
