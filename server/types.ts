export interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

export interface ExitMessage {
  type: 'exit';
  code: number;
}

export type ControlMessage = ResizeMessage | ExitMessage;

export interface TerminalInfo {
  sessionId: string;
  pid: number;
}
