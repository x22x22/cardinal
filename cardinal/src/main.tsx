import React from 'react';
import ReactDOM from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import './i18n/config';
import App from './App';
import { initializeAppMenu } from './menu';
import { initializeTauriEventRuntime } from './runtime/tauriEventRuntime';
import { initializeGlobalShortcuts } from './utils/globalShortcuts';
import { initializeThemePreference } from './theme';

initializeThemePreference();
void initializeGlobalShortcuts();
void initializeAppMenu();
void initializeTauriEventRuntime();

// release 包没有 devtools，白屏时唯一线索就是把这些异常送到后端日志。
const reportBootFailure = (kind: string, detail: string) => {
  console.error(`[cardinal.boot] ${kind}: ${detail}`);
  try {
    void invoke('log_frontend_error', { message: `${kind}: ${detail}` }).catch(() => {});
  } catch {
    /* 后端尚未就绪时忽略，避免二次异常 */
  }
};

window.addEventListener('error', (event) => {
  reportBootFailure(
    'window.error',
    `${event.message} @ ${event.filename ?? '?'}:${event.lineno ?? 0}:${event.colno ?? 0}`,
  );
});

window.addEventListener('unhandledrejection', (event) => {
  reportBootFailure('unhandledrejection', String(event.reason));
});

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Unable to initialize application: #root element is missing.');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  reportBootFailure('render.failed', detail);
  // 白屏换成可读错误，至少知道出了什么
  rootElement.innerHTML = `<pre style="padding:24px;font:13px/1.6 ui-monospace,monospace;color:#b00;white-space:pre-wrap">启动失败：\n${detail}</pre>`;
}
