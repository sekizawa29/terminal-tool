import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { readFileSync, readlinkSync } from 'fs';
import { execSync } from 'child_process';
import { platform } from 'os';
import { basename } from 'path';
import type { WebSocket } from 'ws';
import type { ExitMessage, ResizeMessage } from './types.js';

const currentPlatform = platform();

function stripAnsiCodes(str: string): string {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

function getDefaultShell(shell?: string): string {
  if (shell) return shell;
  if (process.env.SHELL) return process.env.SHELL;
  if (currentPlatform === 'win32') return process.env.ComSpec || 'powershell.exe';
  return '/bin/bash';
}

function normalizeProcessName(name: string): string {
  return basename(name).replace(/^-/, '').replace(/\.exe$/i, '');
}

export interface SessionStatus {
  sessionId: string;
  pid: number;
  cwd: string;
  cwdShort: string;
  foregroundProcess: string;
  isRunning: boolean;
  isProcessing: boolean; // recent PTY output detected (agent actively generating)
  name?: string; // user-assigned label
}

const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1MB
const SCROLLBACK_BUFFER_LIMIT = 200 * 1024; // 200KB of output history

interface PtySession {
  pty: pty.IPty;
  ws: WebSocket | null;
  alive: boolean;
  buffer: string; // buffered output while detached
  lastOutputAt: number; // timestamp of last PTY output
  shellName: string; // normalized base name of shell (e.g. 'bash', 'zsh', 'cmd', 'powershell')
  name?: string; // user-assigned label
  onDataDisposable: pty.IDisposable | null;
  onExitDisposable: pty.IDisposable | null;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private nameIndex = new Map<string, string>(); // name → sessionId
  private serverPort: number;
  private binDir: string;

  constructor(port: number = 3001, binDir: string = '') {
    this.serverPort = port;
    this.binDir = binDir;
  }

  create(cols: number, rows: number, cwd?: string, shell?: string): string {
    const sessionId = randomBytes(16).toString('hex');
    const resolvedShell = getDefaultShell(shell);
    const shellName = normalizeProcessName(resolvedShell);
    const home = getHomeDir();

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TBOARD_URL: `http://127.0.0.1:${this.serverPort}`,
      TBOARD_SESSION: sessionId,
    };
    if (this.binDir) {
      env.PATH = `${this.binDir}:${env.PATH || ''}`;
    }

    const p = pty.spawn(resolvedShell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd || home || '/',
      env,
    });

    const session: PtySession = {
      pty: p,
      ws: null,
      alive: true,
      buffer: '',
      lastOutputAt: 0,
      shellName,
      onDataDisposable: null,
      onExitDisposable: null,
    };

    // Always buffer all output (for replay on reconnect)
    session.onDataDisposable = p.onData((data: string) => {
      session.lastOutputAt = Date.now();

      // Always append to rolling buffer
      session.buffer += data;
      if (session.buffer.length > SCROLLBACK_BUFFER_LIMIT) {
        session.buffer = session.buffer.slice(-SCROLLBACK_BUFFER_LIMIT);
      }

      // Send to WebSocket if connected
      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        if (session.ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
          session.pty.pause();
          const checkDrain = () => {
            if (!session.ws || session.ws.bufferedAmount <= BACKPRESSURE_THRESHOLD) {
              session.pty.resume();
            } else {
              setTimeout(checkDrain, 50);
            }
          };
          setTimeout(checkDrain, 50);
        }
        session.ws.send(data);
      }
    });

    // Listen for exit
    session.onExitDisposable = p.onExit(({ exitCode }) => {
      session.alive = false;
      if (session.ws && session.ws.readyState === session.ws.OPEN) {
        const msg: ExitMessage = { type: 'exit', code: exitCode };
        session.ws.send('\x00' + JSON.stringify(msg));
        session.ws.close();
      }
      session.onDataDisposable?.dispose();
      session.onExitDisposable?.dispose();
      this.sessions.delete(sessionId);
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  attach(sessionId: string, ws: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    // If already attached, close old connection (stale from reload)
    if (session.ws) {
      try {
        session.ws.removeAllListeners();
        session.ws.close();
      } catch {}
      session.ws = null;
    }

    session.ws = ws;

    // Replay buffered output (keep buffer for future reconnects)
    if (session.buffer.length > 0) {
      ws.send(session.buffer);
    }

    // Resume PTY if it was paused
    session.pty.resume();

    // Handle incoming messages
    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (!this.sessions.has(sessionId)) return;

      if (isBinary) {
        session.pty.write(data.toString('binary'));
        return;
      }

      const str = data.toString();
      // Control message: starts with NUL byte
      if (str.charCodeAt(0) === 0) {
        try {
          const msg = JSON.parse(str.slice(1)) as ResizeMessage;
          if (msg.type === 'resize') {
            this.resize(sessionId, msg.cols, msg.rows);
          }
        } catch {
          // ignore malformed control messages
        }
        return;
      }

      // Data: keyboard input
      session.pty.write(str);
    });

    // On WS close: detach but keep PTY alive
    // Check identity to avoid stale close handler nullifying a new connection
    ws.on('close', () => {
      if (session.ws === ws) {
        session.ws = null;
      }
    });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.resize(Math.max(1, cols), Math.max(1, rows));
    }
  }

  write(sessionId: string, data: string | Buffer): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.write(typeof data === 'string' ? data : data.toString());
    }
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.name) {
        this.nameIndex.delete(session.name);
      }
      session.onDataDisposable?.dispose();
      session.onExitDisposable?.dispose();
      try {
        session.pty.kill();
      } catch {
        // already dead
      }
      this.sessions.delete(sessionId);
    }
  }

  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.alive ?? false;
  }

  isAttached(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.ws != null;
  }

  getPid(sessionId: string): number | undefined {
    return this.sessions.get(sessionId)?.pty.pid;
  }

  /** List all active (alive) session IDs */
  listSessions(): string[] {
    return Array.from(this.sessions.entries())
      .filter(([, s]) => s.alive)
      .map(([id]) => id);
  }

  getSessionStatus(sessionId: string): SessionStatus | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) return null;

    const pid = session.pty.pid;
    const home = getHomeDir();
    let cwd = home || '~';
    let foregroundProcess = session.shellName;
    let isRunning = false;

    if (currentPlatform === 'linux') {
      // Linux: use /proc filesystem for precise status
      try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch {}

      try {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
        const lastParen = stat.lastIndexOf(')');
        const fields = stat.slice(lastParen + 2).split(' ');
        const pgrp = parseInt(fields[2]);
        const tpgid = parseInt(fields[5]);

        if (tpgid > 0 && tpgid !== pgrp) {
          isRunning = true;
          try {
            foregroundProcess = readFileSync(`/proc/${tpgid}/comm`, 'utf-8').trim();
          } catch {
            foregroundProcess = 'running';
          }
        } else {
          try {
            foregroundProcess = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
          } catch {}
        }
      } catch {}
    } else if (currentPlatform === 'darwin') {
      // macOS: use lsof for CWD, pty.process for foreground process
      try {
        const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
          encoding: 'utf-8', timeout: 2000,
        });
        const match = out.match(/\nn(.+)/);
        if (match) cwd = match[1];
      } catch {}

      const currentProcess = normalizeProcessName(session.pty.process || '');
      if (currentProcess && currentProcess !== session.shellName) {
        foregroundProcess = currentProcess;
        isRunning = true;
      }
    } else if (currentPlatform === 'win32') {
      // Windows: use pty.process for foreground process; CWD not reliably obtainable
      const currentProcess = normalizeProcessName(session.pty.process || '');
      if (currentProcess && currentProcess !== session.shellName) {
        foregroundProcess = currentProcess;
        isRunning = true;
      }
    }

    const cwdShort = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
    const isProcessing = isRunning && (Date.now() - session.lastOutputAt < 3000);

    return { sessionId, pid, cwd, cwdShort, foregroundProcess, isRunning, isProcessing, name: session.name };
  }

  getAllStatuses(): SessionStatus[] {
    const statuses: SessionStatus[] = [];
    for (const [id, session] of this.sessions) {
      if (session.alive) {
        const status = this.getSessionStatus(id);
        if (status) statuses.push(status);
      }
    }
    return statuses;
  }

  /** Resolve a session by full ID, short prefix (4+ chars), or name */
  resolveSession(idOrName: string): string | null {
    if (!idOrName) return null;

    // Exact session ID match
    if (this.sessions.has(idOrName)) return idOrName;

    // Name match
    const byName = this.nameIndex.get(idOrName);
    if (byName && this.sessions.has(byName)) return byName;

    // Prefix match (minimum 4 chars)
    if (idOrName.length >= 4) {
      const matches: string[] = [];
      for (const [id] of this.sessions) {
        if (id.startsWith(idOrName)) matches.push(id);
      }
      if (matches.length === 1) return matches[0];
    }

    return null;
  }

  setName(sessionId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Remove old name from index
    if (session.name) {
      this.nameIndex.delete(session.name);
    }

    session.name = name || undefined;
    if (name) {
      this.nameIndex.set(name, sessionId);
    }
  }

  getName(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.name;
  }

  getBuffer(sessionId: string, lines?: number, plain: boolean = true): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    let output = session.buffer;

    if (plain) {
      output = stripAnsiCodes(output);
    }

    if (lines && lines > 0) {
      const allLines = output.split('\n');
      output = allLines.slice(-lines).join('\n');
    }

    return output;
  }
}
