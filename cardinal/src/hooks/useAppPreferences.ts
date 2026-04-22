import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { i18n as I18nInstance } from 'i18next';
import { OPEN_PREFERENCES_EVENT } from '../constants/appEvents';
import { getBrowserLanguage } from '../i18n/config';
import { applyThemePreference, persistThemePreference } from '../theme';
import { setTrayEnabled, updateTrayOpenAccelerator } from '../tray';
import { getStoredTrayIconEnabled, persistTrayIconEnabled } from '../trayIconPreference';
import { setWatchConfig } from '../utils/watchConfig';
import { setWindowActivationShortcut } from '../utils/globalShortcuts';
import {
  getStoredWindowActivationShortcut,
  persistWindowActivationShortcut,
  validateWindowActivationShortcut,
} from '../windowActivationShortcutPreference';
import type { FullDiskAccessStatus } from './useFullDiskAccessPermission';
import { useIgnorePaths } from './useIgnorePaths';
import { useWatchRoot } from './useWatchRoot';

type WatchConfigChangePayload = {
  watchRoot: string;
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
  windowActivationShortcut: string;
  defaultWindowActivationShortcut: string;
  handleWindowActivationShortcutChange: (shortcut: string) => Promise<void>;
  watchRoot: string;
  defaultWatchRoot: string;
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
  const { watchRoot, setWatchRoot, defaultWatchRoot } = useWatchRoot();
  const { ignorePaths, setIgnorePaths, defaultIgnorePaths } = useIgnorePaths();
  const logicStartedRef = useRef(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [trayIconEnabled, setTrayIconEnabled] = useState<boolean>(() => getStoredTrayIconEnabled());
  const [windowActivationShortcut, setWindowActivationShortcutState] = useState<string>(() =>
    getStoredWindowActivationShortcut(),
  );
  const [preferencesResetToken, setPreferencesResetToken] = useState(0);

  useEffect(() => {
    persistTrayIconEnabled(trayIconEnabled);
    void setTrayEnabled(trayIconEnabled);
  }, [trayIconEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleOpenPreferences = () => setIsPreferencesOpen(true);
    window.addEventListener(OPEN_PREFERENCES_EVENT, handleOpenPreferences);
    return () => window.removeEventListener(OPEN_PREFERENCES_EVENT, handleOpenPreferences);
  }, []);

  useEffect(() => {
    if (isCheckingFullDiskAccess) {
      return;
    }
    if (fullDiskAccessStatus !== 'granted') {
      return;
    }
    if (!watchRoot) {
      return;
    }
    if (logicStartedRef.current) {
      return;
    }

    logicStartedRef.current = true;
    void invoke('start_logic', { watchRoot, ignorePaths });
  }, [fullDiskAccessStatus, ignorePaths, isCheckingFullDiskAccess, watchRoot]);

  const applyWatchConfig = useCallback(
    (nextWatchRoot: string, nextIgnorePaths: string[]) => {
      const watchConfigChanged =
        nextWatchRoot !== watchRoot || !areStringArraysEqual(nextIgnorePaths, ignorePaths);

      if (!watchConfigChanged) {
        return;
      }

      setWatchRoot(nextWatchRoot);
      setIgnorePaths(nextIgnorePaths);
      if (logicStartedRef.current && nextWatchRoot) {
        void setWatchConfig({
          watchRoot: nextWatchRoot,
          ignorePaths: nextIgnorePaths,
        });
      }
      refreshSearchResults();
    },
    [ignorePaths, refreshSearchResults, setIgnorePaths, setWatchRoot, watchRoot],
  );

  const handleWatchConfigChange = useCallback(
    (next: WatchConfigChangePayload) => {
      applyWatchConfig(next.watchRoot, next.ignorePaths);
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

  const handleResetPreferences = useCallback(() => {
    setTrayIconEnabled(false);
    void handleWindowActivationShortcutChange('').catch((error) => {
      console.error('Failed to reset window activation shortcut', error);
    });
    persistThemePreference('system');
    applyThemePreference('system');
    const nextLanguage = getBrowserLanguage();
    void i18n.changeLanguage(nextLanguage);
    setPreferencesResetToken((token) => token + 1);
  }, [handleWindowActivationShortcutChange, i18n]);

  const closePreferences = useCallback(() => setIsPreferencesOpen(false), []);

  return {
    isPreferencesOpen,
    closePreferences,
    trayIconEnabled,
    setTrayIconEnabled,
    windowActivationShortcut,
    defaultWindowActivationShortcut: '',
    handleWindowActivationShortcutChange,
    watchRoot,
    defaultWatchRoot,
    ignorePaths,
    defaultIgnorePaths,
    preferencesResetToken,
    handleWatchConfigChange,
    handleResetPreferences,
  };
}
