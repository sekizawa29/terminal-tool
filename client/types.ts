export interface TerminalWindow {
  id: string;
  sessionId: string;
  type?: 'terminal' | 'browser' | 'explorer' | 'editor' | 'memo';
  url?: string;
  explorerRoot?: string;
  filePath?: string;
  memoText?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  title: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: string;
  extension: string;
}

export interface TerminalLink {
  id: string;
  sourceId: string;
  targetId: string;
}

// Offscreen-attention marker for a window (e.g. an agent finished while the
// window was out of view). Keyed by windowId in the store.
export interface AttentionInfo {
  kind: 'finished';
  at: number;
}

export interface CanvasState {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export interface SessionStatus {
  sessionId: string;
  pid: number;
  cwd: string;
  cwdShort: string;
  foregroundProcess: string;
  isRunning: boolean;
  isProcessing: boolean;
  name?: string;
  shellType?: 'linux' | 'windows';
}
