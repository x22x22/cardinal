// UI constants

// Column width ratios derived from the viewport width percentages.
export const COL_WIDTH_RATIOS = {
  filename: 0.25, // 25%
  path: 0.38, // 38%
  size: 0.08, // 8%
  modified: 0.145, // 14.5%
  created: 0.145, // 14.5%
} as const;

export type ColumnKey = keyof typeof COL_WIDTH_RATIOS;

// Derive the initial column widths given the available window width.
export const calculateInitialColWidths = (windowWidth: number): Record<ColumnKey, number> => {
  // Reserve space for padding and the custom scrollbar so column math aligns with CSS.
  const availableWidth = windowWidth - CONTAINER_PADDING - SCROLLBAR_WIDTH;

  const calculatedWidths = {} as Record<ColumnKey, number>;

  for (const [key, ratio] of Object.entries(COL_WIDTH_RATIOS) as [ColumnKey, number][]) {
    const calculatedWidth = Math.floor(availableWidth * ratio);
    calculatedWidths[key] = Math.max(calculatedWidth, MIN_COL_WIDTH);
  }

  return calculatedWidths;
};

export const ROW_HEIGHT = 24;
export const CONTAINER_PADDING = 10;
// Keep in sync with the CSS variable --virtual-scrollbar-width.
export const SCROLLBAR_WIDTH = 14;

// Minimum thumb height for the virtual scrollbar (in px). Keep this in sync with
// the CSS variable --virtual-scrollbar-thumb-min in src/App.css.
export const SCROLLBAR_THUMB_MIN = 24;

// Cache and performance tuning
export const CACHE_SIZE = 1000;
export const SEARCH_DEBOUNCE_MS = 300;
export const STATUS_FADE_DELAY_MS = 2000;
export const OVERSCAN_ROW_COUNT = 1;

// Search reliability tuning.
// Upper bound (ms) a single `search` IPC request may stay in flight before the
// watchdog gives up and surfaces a readable error. The backend runs on a
// single-threaded event loop, so a busy FSEvents scan can starve the command
// and leave an unbounded pending promise; without this bound the UI would spin
// forever.
export const SEARCH_TIMEOUT_MS = 10_000;
// Delay (ms) before the loading UI is shown for a re-query. Keeps fast responses
// from flashing a spinner.
export const SEARCH_LOADING_DELAY_MS = 150;
// Delay (ms) before re-issuing a search that the backend rejected with
// `index_building`. A single automatic retry is allowed per user-initiated
// query; the delay keeps the retry from becoming a request storm while the
// index rebuild runs.
export const SEARCH_INDEX_BUILDING_RETRY_DELAY_MS = 1500;

export const MIN_COL_WIDTH = 30;
export const MAX_COL_WIDTH = 10000;
