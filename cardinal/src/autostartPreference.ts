import { disable, enable } from '@tauri-apps/plugin-autostart';

const AUTOSTART_ENABLED_STORAGE_KEY = 'cardinal.autostart.enabled';

export const DEFAULT_AUTOSTART_ENABLED = true;

const readStoredValue = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(AUTOSTART_ENABLED_STORAGE_KEY);
  } catch {
    return null;
  }
};

export const getStoredAutostartEnabled = (): boolean => {
  const storedValue = readStoredValue();
  if (storedValue === 'false') {
    return false;
  }
  if (storedValue === 'true') {
    return true;
  }
  return DEFAULT_AUTOSTART_ENABLED;
};

export const persistAutostartEnabled = (enabled: boolean): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(AUTOSTART_ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // Best effort: the OS-level setting is still applied even if localStorage is unavailable.
  }
};

export const setAutostartEnabled = async (enabled: boolean): Promise<void> => {
  if (enabled) {
    await enable();
  } else {
    await disable();
  }
};
