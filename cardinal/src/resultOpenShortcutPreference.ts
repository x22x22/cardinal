const RESULT_OPEN_SHORTCUT_STORAGE_KEY = 'cardinal.resultOpenShortcut';

export const DEFAULT_RESULT_OPEN_SHORTCUT = 'Command+O';

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
  ['up', 'Up'],
  ['arrowup', 'Up'],
  ['down', 'Down'],
  ['arrowdown', 'Down'],
  ['left', 'Left'],
  ['arrowleft', 'Left'],
  ['right', 'Right'],
  ['arrowright', 'Right'],
]);

const MODIFIER_ORDER = ['CommandOrControl', 'Command', 'Control', 'Option', 'Shift'];

export type ResultOpenShortcutValidationResult =
  | { isValid: true; normalizedShortcut: string }
  | {
      isValid: false;
      normalizedShortcut: string;
      errorKey: 'preferences.resultOpenShortcut.errors.invalidFormat';
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

const normalizePrimaryKeyFromEvent = (event: KeyboardEvent): string | null => {
  const { code, key } = event;

  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }
  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    return code;
  }

  switch (code) {
    case 'Space':
    case 'Tab':
    case 'Enter':
    case 'Backspace':
    case 'Delete':
      return code;
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    default:
      return key === 'Escape' ? 'Escape' : null;
  }
};

const formatShortcut = (modifiers: string[], primaryKey: string): string =>
  [...modifiers, primaryKey].join('+');

export const validateResultOpenShortcut = (
  shortcut: string,
): ResultOpenShortcutValidationResult => {
  const normalizedShortcut = shortcut.trim();
  if (!normalizedShortcut) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.resultOpenShortcut.errors.invalidFormat',
    };
  }

  const rawParts = normalizedShortcut.split('+').map((part) => part.trim());
  if (rawParts.some((part) => part.length === 0)) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.resultOpenShortcut.errors.invalidFormat',
    };
  }

  const primaryKey = normalizePrimaryKeyToken(rawParts[rawParts.length - 1]);
  if (!primaryKey) {
    return {
      isValid: false,
      normalizedShortcut,
      errorKey: 'preferences.resultOpenShortcut.errors.invalidFormat',
    };
  }

  const modifiers = new Set<string>();
  for (const token of rawParts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
    if (!modifier) {
      return {
        isValid: false,
        normalizedShortcut,
        errorKey: 'preferences.resultOpenShortcut.errors.invalidFormat',
      };
    }
    modifiers.add(modifier);
  }

  return {
    isValid: true,
    normalizedShortcut: formatShortcut(
      MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)),
      primaryKey,
    ),
  };
};

export const recordResultOpenShortcut = (event: KeyboardEvent): string | null => {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push('Command');
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Option');
  if (event.shiftKey) modifiers.push('Shift');

  const primaryKey = normalizePrimaryKeyFromEvent(event);
  return primaryKey ? formatShortcut(modifiers, primaryKey) : null;
};

export const isResultOpenShortcutEvent = (shortcut: string, event: KeyboardEvent): boolean => {
  const validationResult = validateResultOpenShortcut(shortcut);
  if (!validationResult.isValid) {
    return false;
  }

  const recordedShortcut = recordResultOpenShortcut(event);
  return recordedShortcut === validationResult.normalizedShortcut;
};

export const getStoredResultOpenShortcut = (): string => {
  if (typeof window === 'undefined') {
    return DEFAULT_RESULT_OPEN_SHORTCUT;
  }

  try {
    const stored = window.localStorage.getItem(RESULT_OPEN_SHORTCUT_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_RESULT_OPEN_SHORTCUT;
    }

    const validationResult = validateResultOpenShortcut(stored);
    return validationResult.isValid
      ? validationResult.normalizedShortcut
      : DEFAULT_RESULT_OPEN_SHORTCUT;
  } catch {
    return DEFAULT_RESULT_OPEN_SHORTCUT;
  }
};

export const persistResultOpenShortcut = (shortcut: string): void => {
  if (typeof window === 'undefined') {
    return;
  }

  const validationResult = validateResultOpenShortcut(shortcut);
  const normalizedShortcut = validationResult.isValid
    ? validationResult.normalizedShortcut
    : DEFAULT_RESULT_OPEN_SHORTCUT;

  try {
    if (normalizedShortcut === DEFAULT_RESULT_OPEN_SHORTCUT) {
      window.localStorage.removeItem(RESULT_OPEN_SHORTCUT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(RESULT_OPEN_SHORTCUT_STORAGE_KEY, normalizedShortcut);
    }
  } catch {
    // Ignore storage failures.
  }
};
