export interface TerminalWindow {
  id: string;
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  title: string;
}

export interface TerminalLink {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface CanvasState {
  offsetX: number;
  offsetY: number;
  scale: number;
}
