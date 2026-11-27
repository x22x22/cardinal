import { invoke } from '@tauri-apps/api/core';

export type WatchConfigPayload = {
  watchRoot: string;
  /// 多根列表（有序即优先级）；后端归一化时会去掉被父路径覆盖的子路径。
  watchRoots?: string[];
  ignorePaths: string[];
};

export const setWatchConfig = (payload: WatchConfigPayload): Promise<void> => {
  return invoke('set_watch_config', payload);
};
