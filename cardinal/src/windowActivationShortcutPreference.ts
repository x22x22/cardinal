const WINDOW_ACTIVATION_SHORTCUT_STORAGE_KEY = 'cardinal.windowActivationShortcut';

const MODIFIER_ALIASES = new Map<string, string>([
  ['cmd', 'Command'],
  ['command', 'Command'],
  ['meta', 'Command'],
  ['ctrl', 'Control'],
  ['control', 'Control'],
  ['cmdorctrl', 'CommandOrControl'],
  ['commandorcontrol', 'CommandOrControl'],
  ['commandorctrl', 'CommandOrControl'],
  ['ctrlorcommand', 'CommandOrControl'],
  ['controlorcommand', 'CommandOrControl'],
  ['alt', 'Option'],
  ['option', 'Option'],
  ['opt', 'Option'],
  ['shift', 'Shift'],
  ['super', 'Super'],
]);

const PRIMARY_KEY_ALIASES = new Map<string, string>([
  ['space', 'Space'],
  ['tab', 'Tab'],
  ['enter', 'Enter'],
  ['return', 'Enter'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['insert', 'Insert'],
  ['ins', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['up', 'Up'],
  ['arrowup', 'Up'],
  ['down', 'Down'],
  ['arrowdown', 'Down'],
  ['left', 'Left'],
  ['arrowleft', 'Left'],
  ['right', 'Right'],
  ['arrowright', 'Right'],
  ['minus', 'Minus'],
  ['equal', 'Equal'],
  ['comma', 'Comma'],
  ['period', 'Period'],
  ['slash', 'Slash'],
  ['backslash', 'Backslash'],
  ['semicolon', 'Semicolon'],
  ['quote', 'Quote'],
  ['backquote', 'Backquote'],
  ['bracketleft', 'BracketLeft'],
  ['bracketright', 'BracketRight'],
  ['plus', 'Plus'],
]);

type ShortcutValidationResult =
  | { isValid: true; normalizedShortcut: string }
  | { isValid: false; normalizedShortcut: string; errorKey: ShortcutValidationErrorKey };

export type ShortcutValidationErrorKey =
  | 'preferences.windowActivationShortcut.errors.invalidFormat'
  | 'preferences.windowActivationShortcut.errors.requiresModifier';

const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Option', 'Shift', 'Super'];

const normalizeModifierToken = (token: string): string | null => {
  const normalized = MODIFIER_ALIASES.get(token.toLowerCase());
  return normalized ?? null;
};

const normalizePrimaryKeyToken = (token: string): string | null => {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const aliased = PRIMARY_KEY_ALIASES.get(trimmed.toLowerCase());
  if (aliased) {
    return aliased;
  }

  if (/^[a-z]$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (/^[0-9]$/.test(trimmed)) {
    return trimmed;
  }

  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  return null;
};

const formatShortcut = (modifiers: string[], primaryKey: string): string =>
  [...modifiers, primaryKey].join('+');

export const normalizeWindowActivationShortcut = (shortcut: string): string => shortcut.trim();

export const validateWindowActivationShortcut = (shortcut: string): ShortcutValidationResult => {
  const normalizedShortcut = normalizeWindowActivationShortcut(shortcut);
  if (!normalizedShortcut) {
    return { isValid: true, normalizedShortcut: '' };
  }

  const rawParts = normalizedShortcut.split('+').map((part) => part.trim());
  if (rawParts.some((part) => part.length === 0)) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.windowActivationShortcut.errors.invalidFormat',
    };
  }

  if (rawParts.length === 1) {
    return normalizePrimaryKeyToken(rawParts[0])
      ? {
          isValid: false,
          normalizedShortcut,
          errorKey: 'preferences.windowActivationShortcut.errors.requiresModifier',
        }
      : {
          isValid: false,
          normalizedShortcut,
          errorKey: 'preferences.windowActivationShortcut.errors.invalidFormat',
        };
  }

  const primaryKeyToken = rawParts[rawParts.length - 1];
  if (!primaryKeyToken) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.windowActivationShortcut.errors.invalidFormat',
    };
  }

  const primaryKey = normalizePrimaryKeyToken(primaryKeyToken);
  if (!primaryKey) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.windowActivationShortcut.errors.invalidFormat',
    };
  }

  const modifiers = new Set<string>();
  for (const token of rawParts.slice(0, -1)) {
    const normalizedModifier = normalizeModifierToken(token);
    if (!normalizedModifier) {
      return {
        isValid: false,
        normalizedShortcut,
        errorKey: 'preferences.windowActivationShortcut.errors.invalidFormat',
      };
    }
    modifiers.add(normalizedModifier);
  }

  if (modifiers.size === 0) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.windowActivationShortcut.errors.requiresModifier',
    };
  }

  return {
    isValid: true,
    normalizedShortcut: formatShortcut(
      MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
      primaryKey,
    ),
  };
};

export const recordWindowActivationShortcut = (event: KeyboardEvent): string | null => {
  const modifiers: string[] = [];
  if (event.metaKey) {
    modifiers.push('Command');
  }
  if (event.ctrlKey) {
    modifiers.push('Control');
  }
  if (event.altKey) {
    modifiers.push('Option');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }

  let primaryKey: string | null = null;
  const { code, key } = event;

  if (/^Key[A-Z]$/.test(code)) {
    primaryKey = code.slice(3);
  } else if (/^Digit[0-9]$/.test(code)) {
    primaryKey = code.slice(5);
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    primaryKey = code;
  } else {
    switch (code) {
      case 'Space':
        primaryKey = 'Space';
        break;
      case 'Tab':
        primaryKey = 'Tab';
        break;
      case 'Enter':
        primaryKey = 'Enter';
        break;
      case 'Backspace':
        primaryKey = 'Backspace';
        break;
      case 'Delete':
        primaryKey = 'Delete';
        break;
      case 'Insert':
        primaryKey = 'Insert';
        break;
      case 'Home':
        primaryKey = 'Home';
        break;
      case 'End':
        primaryKey = 'End';
        break;
      case 'PageUp':
        primaryKey = 'PageUp';
        break;
      case 'PageDown':
        primaryKey = 'PageDown';
        break;
      case 'ArrowUp':
        primaryKey = 'Up';
        break;
      case 'ArrowDown':
        primaryKey = 'Down';
        break;
      case 'ArrowLeft':
        primaryKey = 'Left';
        break;
      case 'ArrowRight':
        primaryKey = 'Right';
        break;
      case 'Minus':
        primaryKey = 'Minus';
        break;
      case 'Equal':
        primaryKey = 'Equal';
        break;
      case 'Comma':
        primaryKey = 'Comma';
        break;
      case 'Period':
        primaryKey = 'Period';
        break;
      case 'Slash':
        primaryKey = 'Slash';
        break;
      case 'Backslash':
        primaryKey = 'Backslash';
        break;
      case 'Semicolon':
        primaryKey = 'Semicolon';
        break;
      case 'Quote':
        primaryKey = 'Quote';
        break;
      case 'Backquote':
        primaryKey = 'Backquote';
        break;
      case 'BracketLeft':
        primaryKey = 'BracketLeft';
        break;
      case 'BracketRight':
        primaryKey = 'BracketRight';
        break;
      default:
        if (key === 'Escape') {
          primaryKey = 'Escape';
        }
    }
  }

  if (!primaryKey) {
    return null;
  }

  if (modifiers.length === 0) {
    return null;
  }

  return formatShortcut(modifiers, primaryKey);
};

export const getStoredWindowActivationShortcut = (): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    const stored = window.localStorage.getItem(WINDOW_ACTIVATION_SHORTCUT_STORAGE_KEY);
    if (!stored) {
      return '';
    }

    const validationResult = validateWindowActivationShortcut(stored);
    return validationResult.isValid ? validationResult.normalizedShortcut : '';
  } catch {
    return '';
  }
};

export const persistWindowActivationShortcut = (shortcut: string): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const validationResult = validateWindowActivationShortcut(shortcut);
  const normalizedShortcut = validationResult.isValid ? validationResult.normalizedShortcut : '';

  try {
    if (normalizedShortcut) {
      window.localStorage.setItem(WINDOW_ACTIVATION_SHORTCUT_STORAGE_KEY, normalizedShortcut);
    } else {
      window.localStorage.removeItem(WINDOW_ACTIVATION_SHORTCUT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
};
