const LAUNCH_MINIMIZED_TO_TRAY_STORAGE_KEY = 'cardinal.launchMinimizedToTray';

export const getStoredLaunchMinimizedToTray = (): boolean => {
  const stored = window.localStorage.getItem(LAUNCH_MINIMIZED_TO_TRAY_STORAGE_KEY);
  return stored !== 'false';
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
