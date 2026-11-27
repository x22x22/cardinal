import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getWatchRootValidation, isIgnorePatternInputValid } from '../utils/watchRoot';
import {
  recordWindowActivationShortcut,
  validateWindowActivationShortcut,
} from '../windowActivationShortcutPreference';
import {
  recordResultOpenShortcut,
  validateResultOpenShortcut,
} from '../resultOpenShortcutPreference';
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
  launchMinimizedToTray: boolean;
  onLaunchMinimizedToTrayChange: (enabled: boolean) => void;
  windowActivationShortcut: string;
  defaultWindowActivationShortcut: string;
  onWindowActivationShortcutChange: (shortcut: string) => Promise<void>;
  resultOpenShortcut: string;
  defaultResultOpenShortcut: string;
  onResultOpenShortcutChange: (shortcut: string) => void;
  watchRoots: string[];
  defaultWatchRoots: string[];
  onWatchConfigChange: (next: { watchRoots: string[]; ignorePaths: string[] }) => void;
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
  launchMinimizedToTray,
  onLaunchMinimizedToTrayChange,
  windowActivationShortcut,
  defaultWindowActivationShortcut,
  onWindowActivationShortcutChange,
  resultOpenShortcut,
  defaultResultOpenShortcut,
  onResultOpenShortcutChange,
  watchRoots,
  defaultWatchRoots,
  onWatchConfigChange,
  ignorePaths,
  defaultIgnorePaths,
  onReset,
  themeResetToken,
}: PreferencesOverlayProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const windowActivationShortcutInputRef = useRef<HTMLInputElement | null>(null);
  const resultOpenShortcutInputRef = useRef<HTMLInputElement | null>(null);
  const isRecordingWindowActivationShortcutRef = useRef(false);
  const isRecordingResultOpenShortcutRef = useRef(false);
  const [thresholdInput, setThresholdInput] = useState<string>(() => sortThreshold.toString());
  const [windowActivationShortcutInput, setWindowActivationShortcutInput] = useState<string>(
    () => windowActivationShortcut,
  );
  const [resultOpenShortcutInput, setResultOpenShortcutInput] = useState<string>(
    () => resultOpenShortcut,
  );
  const [watchRootsInput, setWatchRootsInput] = useState<string>(() => watchRoots.join('\n'));
  const [ignorePathsInput, setIgnorePathsInput] = useState<string>(() => ignorePaths.join('\n'));
  const [windowActivationShortcutError, setWindowActivationShortcutError] = useState<string | null>(
    null,
  );
  const [resultOpenShortcutError, setResultOpenShortcutError] = useState<string | null>(null);
  const [isRecordingWindowActivationShortcut, setIsRecordingWindowActivationShortcut] =
    useState(false);
  const [isRecordingResultOpenShortcut, setIsRecordingResultOpenShortcut] = useState(false);

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
    setResultOpenShortcutInput(resultOpenShortcut);
    setWindowActivationShortcutError(null);
    setResultOpenShortcutError(null);
    isRecordingWindowActivationShortcutRef.current = false;
    isRecordingResultOpenShortcutRef.current = false;
    setIsRecordingWindowActivationShortcut(false);
    setIsRecordingResultOpenShortcut(false);
  }, [open, resultOpenShortcut, sortThreshold, windowActivationShortcut]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setWatchRootsInput(watchRoots.join('\n'));
    setIgnorePathsInput(ignorePaths.join('\n'));
  }, [open, watchRoots, ignorePaths]);

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

  useEffect(() => {
    if (!open || !isRecordingResultOpenShortcut) {
      return;
    }

    requestAnimationFrame(() => {
      const input = resultOpenShortcutInputRef.current;
      if (!input) {
        return;
      }

      input.focus();
      input.select();
    });
  }, [isRecordingResultOpenShortcut, open]);

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

  // 多根：逐行校验，任意一行非法就阻断保存。
  const parsedWatchRoots = watchRootsInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const watchRootErrorKey =
    parsedWatchRoots
      .map((line) => getWatchRootValidation(line).errorKey)
      .find((key) => key != null) ??
    (parsedWatchRoots.length === 0 ? 'watchRoot.errors.required' : null);
  const watchRootErrorMessage = watchRootErrorKey ? t(watchRootErrorKey) : null;

  const handleWatchRootsKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      setWatchRootsInput(watchRoots.join('\n'));
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
  const resultOpenShortcutValidationResult = validateResultOpenShortcut(resultOpenShortcutInput);
  const resultOpenShortcutValidationError = resultOpenShortcutValidationResult.isValid
    ? null
    : t(resultOpenShortcutValidationResult.errorKey);
  const effectiveResultOpenShortcutError =
    resultOpenShortcutError ?? resultOpenShortcutValidationError;

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

  const handleResultOpenShortcutKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!isRecordingResultOpenShortcutRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      isRecordingResultOpenShortcutRef.current = false;
      setIsRecordingResultOpenShortcut(false);
      return;
    }

    const recordedShortcut = recordResultOpenShortcut(event.nativeEvent);
    if (!recordedShortcut) {
      return;
    }

    setResultOpenShortcutInput(recordedShortcut);
    setResultOpenShortcutError(null);
    isRecordingResultOpenShortcutRef.current = false;
    setIsRecordingResultOpenShortcut(false);
  };

  const handleResultOpenShortcutChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
    setResultOpenShortcutInput(event.target.value);
    setResultOpenShortcutError(null);
  };

  const startResultOpenShortcutRecording = (): void => {
    setResultOpenShortcutError(null);
    isRecordingResultOpenShortcutRef.current = true;
    setIsRecordingResultOpenShortcut(true);
  };

  const handleSave = async (): Promise<void> => {
    if (
      watchRootErrorMessage ||
      ignorePathsErrorMessage ||
      shortcutValidationError ||
      resultOpenShortcutValidationError
    ) {
      setWindowActivationShortcutError(shortcutValidationError);
      setResultOpenShortcutError(resultOpenShortcutValidationError);
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

    try {
      onResultOpenShortcutChange(resultOpenShortcutInput);
      setResultOpenShortcutError(null);
    } catch {
      setResultOpenShortcutError(t('preferences.resultOpenShortcut.errors.invalidFormat'));
      return;
    }

    commitThreshold();
    onWatchConfigChange({ watchRoots: parsedWatchRoots, ignorePaths: parsedIgnorePaths });
    setWindowActivationShortcutInput(shortcutValidationResult.normalizedShortcut);
    setResultOpenShortcutInput(resultOpenShortcutValidationResult.normalizedShortcut);
    setWatchRootsInput(parsedWatchRoots.join('\n'));
    setIgnorePathsInput(parsedIgnorePaths.join('\n'));
    onClose();
  };

  const handleReset = (): void => {
    setThresholdInput(defaultSortThreshold.toString());
    setWindowActivationShortcutInput(defaultWindowActivationShortcut);
    setResultOpenShortcutInput(defaultResultOpenShortcut);
    setWindowActivationShortcutError(null);
    setResultOpenShortcutError(null);
    isRecordingWindowActivationShortcutRef.current = false;
    isRecordingResultOpenShortcutRef.current = false;
    setIsRecordingWindowActivationShortcut(false);
    setIsRecordingResultOpenShortcut(false);
    setWatchRootsInput(defaultWatchRoots.join('\n'));
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
          <div className="preferences-row">
            <p className="preferences-label">{t('preferences.launchMinimizedToTray.label')}</p>
            <div className="preferences-control">
              <label className="preferences-switch">
                <input
                  className="preferences-switch__input"
                  type="checkbox"
                  checked={launchMinimizedToTray}
                  onChange={(event) => onLaunchMinimizedToTrayChange(event.target.checked)}
                  aria-label={t('preferences.launchMinimizedToTray.label')}
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
          <div className="preferences-row preferences-row--stacked">
            <div className="preferences-row__details">
              <p className="preferences-label">{t('preferences.resultOpenShortcut.label')}</p>
            </div>
            <div className="preferences-control preferences-control--stacked">
              <input
                ref={resultOpenShortcutInputRef}
                className="preferences-field preferences-watch-root-input"
                type="text"
                value={resultOpenShortcutInput}
                onChange={handleResultOpenShortcutChange}
                onKeyDown={handleResultOpenShortcutKeyDown}
                onFocus={startResultOpenShortcutRecording}
                onClick={startResultOpenShortcutRecording}
                aria-label={t('preferences.resultOpenShortcut.label')}
                autoComplete="off"
                spellCheck={false}
                placeholder={defaultResultOpenShortcut}
              />
              <p className="preferences-field-hint">
                {isRecordingResultOpenShortcut
                  ? t('preferences.resultOpenShortcut.recordingHelp')
                  : t('preferences.resultOpenShortcut.help')}
              </p>
              {effectiveResultOpenShortcutError ? (
                <div aria-live="polite">
                  <p className="permission-status permission-status--error preferences-field-error">
                    {effectiveResultOpenShortcutError}
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
              <textarea
                className="preferences-field preferences-watch-root-input preferences-watch-roots-input"
                rows={Math.min(6, Math.max(2, parsedWatchRoots.length + 1))}
                value={watchRootsInput}
                onChange={(event) => setWatchRootsInput(event.target.value)}
                onKeyDown={handleWatchRootsKeyDown}
                aria-label={t('watchRoot.label')}
                autoComplete="off"
                spellCheck={false}
                placeholder={'/Users/you/project\n/Volumes/data/work'}
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
              watchRootErrorMessage ||
              ignorePathsErrorMessage ||
              shortcutValidationError ||
              resultOpenShortcutValidationError,
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
