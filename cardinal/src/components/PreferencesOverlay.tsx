import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getWatchRootValidation, isIgnorePatternInputValid } from '../utils/watchRoot';
import {
  recordWindowActivationShortcut,
  validateWindowActivationShortcut,
} from '../windowActivationShortcutPreference';
import ThemeSwitcher from './ThemeSwitcher';
import LanguageSwitcher from './LanguageSwitcher';

type PreferencesOverlayProps = {
  open: boolean;
  onClose: () => void;
  sortThreshold: number;
  defaultSortThreshold: number;
  onSortThresholdChange: (value: number) => void;
  trayIconEnabled: boolean;
  onTrayIconEnabledChange: (enabled: boolean) => void;
  windowActivationShortcut: string;
  defaultWindowActivationShortcut: string;
  onWindowActivationShortcutChange: (shortcut: string) => Promise<void>;
  watchRoot: string;
  defaultWatchRoot: string;
  onWatchConfigChange: (next: { watchRoot: string; ignorePaths: string[] }) => void;
  ignorePaths: string[];
  defaultIgnorePaths: string[];
  onReset: () => void;
  themeResetToken: number;
};

export function PreferencesOverlay({
  open,
  onClose,
  sortThreshold,
  defaultSortThreshold,
  onSortThresholdChange,
  trayIconEnabled,
  onTrayIconEnabledChange,
  windowActivationShortcut,
  defaultWindowActivationShortcut,
  onWindowActivationShortcutChange,
  watchRoot,
  defaultWatchRoot,
  onWatchConfigChange,
  ignorePaths,
  defaultIgnorePaths,
  onReset,
  themeResetToken,
}: PreferencesOverlayProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const windowActivationShortcutInputRef = useRef<HTMLInputElement | null>(null);
  const isRecordingWindowActivationShortcutRef = useRef(false);
  const [thresholdInput, setThresholdInput] = useState<string>(() => sortThreshold.toString());
  const [windowActivationShortcutInput, setWindowActivationShortcutInput] = useState<string>(
    () => windowActivationShortcut,
  );
  const [watchRootInput, setWatchRootInput] = useState<string>(() => watchRoot);
  const [ignorePathsInput, setIgnorePathsInput] = useState<string>(() => ignorePaths.join('\n'));
  const [windowActivationShortcutError, setWindowActivationShortcutError] = useState<string | null>(
    null,
  );
  const [isRecordingWindowActivationShortcut, setIsRecordingWindowActivationShortcut] =
    useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
        event.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setThresholdInput(sortThreshold.toString());
    setWindowActivationShortcutInput(windowActivationShortcut);
    setWindowActivationShortcutError(null);
    isRecordingWindowActivationShortcutRef.current = false;
    setIsRecordingWindowActivationShortcut(false);
  }, [open, sortThreshold, windowActivationShortcut]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setWatchRootInput(watchRoot);
    setIgnorePathsInput(ignorePaths.join('\n'));
  }, [open, watchRoot, ignorePaths]);

  useEffect(() => {
    if (!open || !isRecordingWindowActivationShortcut) {
      return;
    }

    requestAnimationFrame(() => {
      const input = windowActivationShortcutInputRef.current;
      if (!input) {
        return;
      }

      input.focus();
      input.select();
    });
  }, [isRecordingWindowActivationShortcut, open]);

  const commitThreshold = useCallback(() => {
    const numericText = thresholdInput.replace(/[^\d]/g, '');
    if (!numericText) {
      setThresholdInput(sortThreshold.toString());
      return;
    }
    const parsed = Number.parseInt(numericText, 10);
    if (Number.isNaN(parsed)) {
      setThresholdInput(sortThreshold.toString());
      return;
    }
    const normalized = Math.max(1, Math.round(parsed));
    onSortThresholdChange(normalized);
    setThresholdInput(normalized.toString());
  }, [onSortThresholdChange, sortThreshold, thresholdInput]);

  const handleThresholdChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const value = event.target.value;
    if (/^\d*$/.test(value)) {
      setThresholdInput(value);
    }
  };

  const { errorKey: watchRootErrorKey } = getWatchRootValidation(watchRootInput);
  const watchRootErrorMessage = watchRootErrorKey ? t(watchRootErrorKey) : null;

  const handleWatchRootKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setWatchRootInput(watchRoot);
    }
  };

  const parsedIgnorePaths = ignorePathsInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const ignorePathsErrorMessage = (() => {
    const invalid = parsedIgnorePaths.find((line) => !isIgnorePatternInputValid(line));
    return invalid ? t('ignorePaths.errors.pattern') : null;
  })();

  const handleIgnorePathsKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      setIgnorePathsInput(ignorePaths.join('\n'));
    }
  };

  const shortcutValidationResult = validateWindowActivationShortcut(windowActivationShortcutInput);
  const shortcutValidationError = shortcutValidationResult.isValid
    ? null
    : t(shortcutValidationResult.errorKey);
  const effectiveWindowActivationShortcutError =
    windowActivationShortcutError ?? shortcutValidationError;

  const handleWindowActivationShortcutKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    if (!isRecordingWindowActivationShortcutRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      isRecordingWindowActivationShortcutRef.current = false;
      setIsRecordingWindowActivationShortcut(false);
      return;
    }

    const recordedShortcut = recordWindowActivationShortcut(event.nativeEvent);
    if (!recordedShortcut) {
      return;
    }

    setWindowActivationShortcutInput(recordedShortcut);
    setWindowActivationShortcutError(null);
    isRecordingWindowActivationShortcutRef.current = false;
    setIsRecordingWindowActivationShortcut(false);
  };

  const handleWindowActivationShortcutChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ): void => {
    setWindowActivationShortcutInput(event.target.value);
    setWindowActivationShortcutError(null);
  };

  const startWindowActivationShortcutRecording = (): void => {
    setWindowActivationShortcutError(null);
    isRecordingWindowActivationShortcutRef.current = true;
    setIsRecordingWindowActivationShortcut(true);
  };

  const handleSave = async (): Promise<void> => {
    if (watchRootErrorMessage || ignorePathsErrorMessage || shortcutValidationError) {
      setWindowActivationShortcutError(shortcutValidationError);
      return;
    }

    try {
      await onWindowActivationShortcutChange(windowActivationShortcutInput);
      setWindowActivationShortcutError(null);
    } catch {
      setWindowActivationShortcutError(
        t('preferences.windowActivationShortcut.errors.registerFailed'),
      );
      return;
    }

    commitThreshold();
    const trimmedWatchRoot = watchRootInput.trim();
    onWatchConfigChange({ watchRoot: trimmedWatchRoot, ignorePaths: parsedIgnorePaths });
    setWindowActivationShortcutInput(shortcutValidationResult.normalizedShortcut);
    setWatchRootInput(trimmedWatchRoot);
    setIgnorePathsInput(parsedIgnorePaths.join('\n'));
    onClose();
  };

  const handleReset = (): void => {
    setThresholdInput(defaultSortThreshold.toString());
    setWindowActivationShortcutInput(defaultWindowActivationShortcut);
    setWindowActivationShortcutError(null);
    isRecordingWindowActivationShortcutRef.current = false;
    setIsRecordingWindowActivationShortcut(false);
    setWatchRootInput(defaultWatchRoot);
    setIgnorePathsInput(defaultIgnorePaths.join('\n'));
    onReset();
  };

  if (!open) {
    return null;
  }

  const handleOverlayClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const handleOverlayKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div
      className="preferences-overlay"
      role="dialog"
      aria-modal="true"
      onClick={handleOverlayClick}
      onKeyDown={handleOverlayKeyDown}
    >
      <div className="preferences-card">
        <header className="preferences-card__header">
          <h1 className="preferences-card__title">{t('preferences.title')}</h1>
        </header>

        <div className="preferences-section">
          <div className="preferences-row">
            <p className="preferences-label">{t('preferences.appearance')}</p>
            <ThemeSwitcher className="preferences-control" resetToken={themeResetToken} />
          </div>
          <div className="preferences-row">
            <p className="preferences-label">{t('preferences.language')}</p>
            <LanguageSwitcher className="preferences-control" />
          </div>
          <div className="preferences-row">
            <p className="preferences-label">{t('preferences.trayIcon.label')}</p>
            <div className="preferences-control">
              <label className="preferences-switch">
                <input
                  className="preferences-switch__input"
                  type="checkbox"
                  checked={trayIconEnabled}
                  onChange={(event) => onTrayIconEnabledChange(event.target.checked)}
                  aria-label={t('preferences.trayIcon.label')}
                />
                <span className="preferences-switch__track" aria-hidden="true" />
              </label>
            </div>
          </div>
          <div className="preferences-row preferences-row--stacked">
            <div className="preferences-row__details">
              <p className="preferences-label">{t('preferences.windowActivationShortcut.label')}</p>
            </div>
            <div className="preferences-control preferences-control--stacked">
              <input
                ref={windowActivationShortcutInputRef}
                className="preferences-field preferences-watch-root-input"
                type="text"
                value={windowActivationShortcutInput}
                onChange={handleWindowActivationShortcutChange}
                onKeyDown={handleWindowActivationShortcutKeyDown}
                onFocus={startWindowActivationShortcutRecording}
                onClick={startWindowActivationShortcutRecording}
                aria-label={t('preferences.windowActivationShortcut.label')}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('preferences.windowActivationShortcut.placeholder')}
              />
              <div className="preferences-shortcut-actions">
                <button
                  className="preferences-shortcut-button preferences-shortcut-button--secondary"
                  type="button"
                  onClick={() => {
                    setWindowActivationShortcutInput('');
                    setWindowActivationShortcutError(null);
                    isRecordingWindowActivationShortcutRef.current = false;
                    setIsRecordingWindowActivationShortcut(false);
                  }}
                >
                  {t('preferences.windowActivationShortcut.clear')}
                </button>
              </div>
              <p className="preferences-field-hint">
                {isRecordingWindowActivationShortcut
                  ? t('preferences.windowActivationShortcut.recordingHelp')
                  : t('preferences.windowActivationShortcut.help')}
              </p>
              {effectiveWindowActivationShortcutError ? (
                <div aria-live="polite">
                  <p className="permission-status permission-status--error preferences-field-error">
                    {effectiveWindowActivationShortcutError}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          <div className="preferences-row">
            <div className="preferences-row__details">
              <p className="preferences-label">{t('preferences.sortingLimit.label')}</p>
            </div>
            <div className="preferences-control">
              <input
                className="preferences-field preferences-number-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={thresholdInput}
                onChange={handleThresholdChange}
                aria-label={t('preferences.sortingLimit.label')}
              />
            </div>
          </div>
          <div className="preferences-row">
            <div className="preferences-row__details">
              <p className="preferences-label" title={t('watchRoot.help')}>
                {t('watchRoot.label')}
              </p>
            </div>
            <div className="preferences-control">
              <input
                className="preferences-field preferences-number-input preferences-watch-root-input"
                type="text"
                value={watchRootInput}
                onChange={(event) => setWatchRootInput(event.target.value)}
                onKeyDown={handleWatchRootKeyDown}
                aria-label={t('watchRoot.label')}
                autoComplete="off"
                spellCheck={false}
              />
              {watchRootErrorMessage ? (
                <div aria-live="polite">
                  <p className="permission-status permission-status--error preferences-field-error">
                    {watchRootErrorMessage}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
          <div className="preferences-row">
            <div className="preferences-row__details">
              <p className="preferences-label" title={t('ignorePaths.help')}>
                {t('ignorePaths.label')}
              </p>
            </div>
            <div className="preferences-control">
              <textarea
                className="preferences-field preferences-textarea"
                value={ignorePathsInput}
                onChange={(event) => setIgnorePathsInput(event.target.value)}
                onKeyDown={handleIgnorePathsKeyDown}
                aria-label={t('ignorePaths.label')}
                autoComplete="off"
                spellCheck={false}
              />
              {ignorePathsErrorMessage ? (
                <div aria-live="polite">
                  <p className="permission-status permission-status--error preferences-field-error">
                    {ignorePathsErrorMessage}
                  </p>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <footer className="preferences-card__footer">
          <button
            className="preferences-save"
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={Boolean(
              watchRootErrorMessage || ignorePathsErrorMessage || shortcutValidationError,
            )}
          >
            {t('preferences.save')}
          </button>
          <button className="preferences-reset" type="button" onClick={handleReset}>
            {t('preferences.reset')}
          </button>
        </footer>
      </div>
    </div>
  );
}

export default PreferencesOverlay;
