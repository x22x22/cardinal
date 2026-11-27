import React from 'react';
import { useTranslation } from 'react-i18next';

type StateProps = {
  icon: React.ReactNode;
  title: string;
  message?: React.ReactNode;
};

export type DisplayState = 'loading' | 'error' | 'idle' | 'empty' | 'results';
type EmptyState = Exclude<DisplayState, 'results'>;

type StateDisplayProps = {
  state: EmptyState;
  message?: string | null;
  query?: string;
  /** 索引尚未就绪：`idle` 态展示构建进度而不是「请输入关键词」。 */
  indexing?: boolean;
  scannedFiles?: number;
};

const State = ({ icon, title, message }: StateProps): React.JSX.Element => (
  <div className="state-display">
    <div className="state-content">
      <div className="state-icon">{icon}</div>
      <div className="state-title">{title}</div>
      <div className="state-message">{message}</div>
    </div>
  </div>
);

// Consistent empty/error/loading presentation inside the results pane.
export function StateDisplay({
  state,
  message,
  query,
  indexing = false,
  scannedFiles = 0,
}: StateDisplayProps): React.JSX.Element {
  const { t } = useTranslation();
  if (state === 'loading') {
    return <State icon={<div className="spinner" />} title={t('stateDisplay.loading')} />;
  }

  if (state === 'error') {
    return (
      <State
        icon={<div className="error-icon">!</div>}
        title={t('stateDisplay.error')}
        message={message}
      />
    );
  }

  if (state === 'idle') {
    // 未输入关键词：索引没就绪就报进度，就绪了引导用户开始搜索。
    if (indexing) {
      return (
        <State
          icon={<div className="spinner" />}
          title={t('stateDisplay.indexingTitle')}
          message={t('stateDisplay.indexingMessage', { count: scannedFiles })}
        />
      );
    }
    return (
      <State
        icon={
          <svg
            width="72"
            height="72"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        }
        title={t('stateDisplay.idleTitle')}
        message={t('stateDisplay.idleMessage')}
      />
    );
  }

  const icon = (
    <svg
      width="72"
      height="72"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="13" y1="9" x2="9" y2="13" />
      <line x1="9" y1="9" x2="13" y2="13" />
    </svg>
  );
  const emptyTitle = t('stateDisplay.emptyTitle', { query: query ?? '' });
  return <State icon={icon} title={emptyTitle} message={t('stateDisplay.emptyMessage')} />;
}
