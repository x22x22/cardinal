const LAUNCH_MINIMIZED_TO_TRAY_STORAGE_KEY = 'cardinal.launchMinimizedToTray';

export const getStoredLaunchMinimizedToTray = (): boolean => {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const stored = window.localStorage.getItem(LAUNCH_MINIMIZED_TO_TRAY_STORAGE_KEY);
    return stored !== 'false';
  } catch {
    // Ignore storage failures and fall back to the default.
    return true;
  }
};

export const persistLaunchMinimizedToTray = (enabled: boolean): void => {
  try {
    if (enabled) {
      window.localStorage.removeItem(LAUNCH_MINIMIZED_TO_TRAY_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LAUNCH_MINIMIZED_TO_TRAY_STORAGE_KEY, 'false');
    }
  } catch {
    // Ignore storage failures.
  }
};
