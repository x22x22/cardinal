import { invoke } from '@tauri-apps/api/core';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import {
  getStoredWindowActivationShortcut,
  validateWindowActivationShortcut,
} from '../windowActivationShortcutPreference';

let registeredWindowActivationShortcut = '';

const handleWindowActivationShortcut = (event: { state: 'Released' | 'Pressed' }): void => {
  if (event.state === 'Released') {
    void invoke('toggle_main_window');
  }
};

export async function setWindowActivationShortcut(shortcut: string): Promise<void> {
  const validationResult = validateWindowActivationShortcut(shortcut);
  if (!validationResult.isValid) {
    throw new Error(validationResult.errorKey);
  }

  const normalizedShortcut = validationResult.normalizedShortcut;

  if (registeredWindowActivationShortcut === normalizedShortcut) {
    return;
  }

  const previousShortcut = registeredWindowActivationShortcut;

  if (previousShortcut) {
    await unregister(previousShortcut);
    registeredWindowActivationShortcut = '';
  }

  if (!normalizedShortcut) {
    return;
  }

  try {
    await register(normalizedShortcut, handleWindowActivationShortcut);
    registeredWindowActivationShortcut = normalizedShortcut;
  } catch (error) {
    if (previousShortcut) {
      try {
        await register(previousShortcut, handleWindowActivationShortcut);
        registeredWindowActivationShortcut = previousShortcut;
      } catch (rollbackError) {
        console.error('Failed to restore previous global shortcut', rollbackError);
      }
    }

    throw error;
  }
}

export async function initializeGlobalShortcuts(): Promise<void> {
  try {
    await setWindowActivationShortcut(getStoredWindowActivationShortcut());
  } catch (error) {
    console.error('Failed to register global shortcuts', error);
  }
}
