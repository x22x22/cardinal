import { describe, expect, it } from 'vitest';
import {
  recordWindowActivationShortcut,
  validateWindowActivationShortcut,
} from '../windowActivationShortcutPreference';

describe('windowActivationShortcutPreference', () => {
  it('normalizes valid shortcut aliases', () => {
    expect(validateWindowActivationShortcut(' cmd+shift+space ')).toEqual({
      isValid: true,
      normalizedShortcut: 'Command+Shift+Space',
    });
  });

  it('rejects shortcuts without modifiers', () => {
    expect(validateWindowActivationShortcut('K')).toEqual({
      isValid: false,
      normalizedShortcut: 'K',
      errorKey: 'preferences.windowActivationShortcut.errors.requiresModifier',
    });
    expect(validateWindowActivationShortcut('Space')).toEqual({
      isValid: false,
      normalizedShortcut: 'Space',
      errorKey: 'preferences.windowActivationShortcut.errors.requiresModifier',
    });
    expect(validateWindowActivationShortcut('Shift+Space')).toEqual({
      isValid: true,
      normalizedShortcut: 'Shift+Space',
    });
  });

  it('records keyboard events into normalized shortcuts', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      shiftKey: true,
    });

    expect(recordWindowActivationShortcut(event)).toBe('Command+Shift+K');
  });

  it('ignores pure modifier key presses during recording', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'Shift',
      code: 'ShiftLeft',
      shiftKey: true,
    });

    expect(recordWindowActivationShortcut(event)).toBeNull();
  });
});
