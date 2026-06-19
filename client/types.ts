export interface TerminalWindow {
  id: string;
  sessionId: string;
  type?: 'terminal' | 'browser' | 'explorer' | 'editor' | 'memo';
  url?: string;
  explorerRoot?: string;
  filePath?: string;
  memoText?: string;
  // Last-known cwd, used to reopen a dead-session placeholder in place.
  cwd?: string;
  // True when the backing session is gone but the window is kept as a
  // placeholder (server restart / session death) so the board layout survives.
  dead?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  title: string;
}

// What a "spawn here" action launches in a directory: a plain shell, or one of
// the agent CLIs (claude / codex / antigravity / grok) auto-injected at the prompt.
export type SpawnKind = 'terminal' | 'claude' | 'codex' | 'agy' | 'grok';

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
