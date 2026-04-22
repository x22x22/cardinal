import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PreferencesOverlay } from '../PreferencesOverlay';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../ThemeSwitcher', () => ({
  __esModule: true,
  default: () => <div data-testid="theme-switcher" />,
}));

vi.mock('../LanguageSwitcher', () => ({
  __esModule: true,
  default: () => <div data-testid="language-switcher" />,
}));

const baseProps = {
  open: true,
  onClose: vi.fn(),
  sortThreshold: 200,
  defaultSortThreshold: 100,
  onSortThresholdChange: vi.fn(),
  trayIconEnabled: false,
  onTrayIconEnabledChange: vi.fn(),
  windowActivationShortcut: '',
  defaultWindowActivationShortcut: '',
  onWindowActivationShortcutChange: vi.fn().mockResolvedValue(undefined),
  watchRoot: '/old/root',
  defaultWatchRoot: '/default/root',
  ignorePaths: ['/ignore/a', '/ignore/b'],
  defaultIgnorePaths: ['/default/ignore'],
  onReset: vi.fn(),
  themeResetToken: 0,
  onWatchConfigChange: vi.fn(),
};

describe('PreferencesOverlay', () => {
  it('saves watch root updates via onWatchConfigChange', async () => {
    const onWatchConfigChange = vi.fn();
    render(<PreferencesOverlay {...baseProps} onWatchConfigChange={onWatchConfigChange} />);

    const watchRootInput = screen.getByLabelText('watchRoot.label');
    fireEvent.change(watchRootInput, { target: { value: '/new/root' } });

    fireEvent.click(screen.getByText('preferences.save'));

    await waitFor(() => {
      expect(onWatchConfigChange).toHaveBeenCalledWith({
        watchRoot: '/new/root',
        ignorePaths: baseProps.ignorePaths,
      });
    });
  });

  it('saves window activation shortcut updates', async () => {
    const onWindowActivationShortcutChange = vi.fn().mockResolvedValue(undefined);
    render(
      <PreferencesOverlay
        {...baseProps}
        onWindowActivationShortcutChange={onWindowActivationShortcutChange}
      />,
    );

    const shortcutInput = screen.getByLabelText('preferences.windowActivationShortcut.label');
    fireEvent.change(shortcutInput, { target: { value: 'Command+Shift+Space' } });

    fireEvent.click(screen.getByText('preferences.save'));

    await waitFor(() => {
      expect(onWindowActivationShortcutChange).toHaveBeenCalledWith('Command+Shift+Space');
    });
  });

  it('records shortcut combinations from keyboard input', async () => {
    const onWindowActivationShortcutChange = vi.fn().mockResolvedValue(undefined);
    render(
      <PreferencesOverlay
        {...baseProps}
        onWindowActivationShortcutChange={onWindowActivationShortcutChange}
      />,
    );

    const shortcutInput = screen.getByLabelText('preferences.windowActivationShortcut.label');
    fireEvent.focus(shortcutInput);
    fireEvent.keyDown(shortcutInput, {
      key: 'K',
      code: 'KeyK',
      metaKey: true,
      shiftKey: true,
    });

    expect(shortcutInput).toHaveValue('Command+Shift+K');

    fireEvent.click(screen.getByText('preferences.save'));

    await waitFor(() => {
      expect(onWindowActivationShortcutChange).toHaveBeenCalledWith('Command+Shift+K');
    });
  });

  it('focuses the shortcut input when recording starts', async () => {
    render(<PreferencesOverlay {...baseProps} />);

    const shortcutInput = screen.getByLabelText('preferences.windowActivationShortcut.label');
    fireEvent.click(shortcutInput);

    await waitFor(() => {
      expect(shortcutInput).toHaveFocus();
    });
  });

  it('shows recording help when shortcut input is focused', () => {
    render(<PreferencesOverlay {...baseProps} />);

    const shortcutInput = screen.getByLabelText('preferences.windowActivationShortcut.label');
    fireEvent.focus(shortcutInput);

    expect(
      screen.getByText('preferences.windowActivationShortcut.recordingHelp'),
    ).toBeInTheDocument();
  });

  it('shows validation error for shortcut without modifiers', () => {
    render(<PreferencesOverlay {...baseProps} />);

    const shortcutInput = screen.getByLabelText('preferences.windowActivationShortcut.label');
    fireEvent.change(shortcutInput, { target: { value: 'Space' } });

    expect(
      screen.getByText('preferences.windowActivationShortcut.errors.requiresModifier'),
    ).toBeInTheDocument();
    expect(screen.getByText('preferences.save')).toBeDisabled();
  });

  it('saves ignore path updates via onWatchConfigChange', async () => {
    const onWatchConfigChange = vi.fn();
    render(<PreferencesOverlay {...baseProps} onWatchConfigChange={onWatchConfigChange} />);

    const ignorePathsInput = screen.getByLabelText('ignorePaths.label');
    fireEvent.change(ignorePathsInput, { target: { value: '/tmp/one\n/tmp/two' } });

    fireEvent.click(screen.getByText('preferences.save'));

    await waitFor(() => {
      expect(onWatchConfigChange).toHaveBeenCalledWith({
        watchRoot: baseProps.watchRoot,
        ignorePaths: ['/tmp/one', '/tmp/two'],
      });
    });
  });

  it('accepts glob-style ignore patterns', async () => {
    const onWatchConfigChange = vi.fn();
    render(<PreferencesOverlay {...baseProps} onWatchConfigChange={onWatchConfigChange} />);

    const ignorePathsInput = screen.getByLabelText('ignorePaths.label');
    fireEvent.change(ignorePathsInput, { target: { value: '**/node_modules\n.git/**' } });

    fireEvent.click(screen.getByText('preferences.save'));

    await waitFor(() => {
      expect(onWatchConfigChange).toHaveBeenCalledWith({
        watchRoot: baseProps.watchRoot,
        ignorePaths: ['**/node_modules', '.git/**'],
      });
    });
  });

  it('blocks unsupported relative ignore patterns', () => {
    const onWatchConfigChange = vi.fn();
    render(<PreferencesOverlay {...baseProps} onWatchConfigChange={onWatchConfigChange} />);

    const ignorePathsInput = screen.getByLabelText('ignorePaths.label');
    fireEvent.change(ignorePathsInput, { target: { value: './tmp' } });

    expect(screen.getByText('ignorePaths.errors.pattern')).toBeInTheDocument();
    expect(screen.getByText('preferences.save')).toBeDisabled();
    fireEvent.click(screen.getByText('preferences.save'));
    expect(onWatchConfigChange).not.toHaveBeenCalled();
  });

  it('resets inputs to defaults before invoking onReset', () => {
    const onReset = vi.fn();
    const onWatchConfigChange = vi.fn();
    const onSortThresholdChange = vi.fn();
    render(
      <PreferencesOverlay
        {...baseProps}
        onReset={onReset}
        onWatchConfigChange={onWatchConfigChange}
        onSortThresholdChange={onSortThresholdChange}
      />,
    );

    fireEvent.click(screen.getByText('preferences.reset'));

    expect(screen.getByLabelText('preferences.sortingLimit.label')).toHaveValue(
      String(baseProps.defaultSortThreshold),
    );
    expect(screen.getByLabelText('preferences.windowActivationShortcut.label')).toHaveValue(
      baseProps.defaultWindowActivationShortcut,
    );
    expect(screen.getByLabelText('watchRoot.label')).toHaveValue(baseProps.defaultWatchRoot);
    expect(screen.getByLabelText('ignorePaths.label')).toHaveValue(
      baseProps.defaultIgnorePaths.join('\n'),
    );
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSortThresholdChange).not.toHaveBeenCalled();
    expect(onWatchConfigChange).not.toHaveBeenCalled();
  });
});
