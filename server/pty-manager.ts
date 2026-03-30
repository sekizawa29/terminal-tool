import * as pty from 'node-pty';
import { randomBytes } from 'crypto';
import { readFileSync, readlinkSync } from 'fs';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { platform } from 'os';
import { basename } from 'path';
import type { WebSocket } from 'ws';
import type { ExitMessage, ResizeMessage } from './types.js';

// @xterm/headless is CJS — use createRequire for ESM compat
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless');

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

/**
 * Strip agent TUI chrome from rendered terminal text.
 * With @xterm/headless handling animation rendering correctly,
 * this only needs to remove static TUI elements (prompts, separators, status lines).
 */
function stripAgentNoise(text: string): string {
  const lines = text.split('\n');
  const cleaned: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Blank line — keep at most one consecutive
    if (!trimmed) {
      if (cleaned.length > 0 && cleaned[cleaned.length - 1] !== '') {
        cleaned.push('');
      }
      continue;
    }

    // Status bar: "esc to interrupt", "auto mode unavailable", timer, tips
    if (/esctointerrupt/i.test(trimmed) || /auto\s*mode\s*(temporarily\s*)?unavailable/i.test(trimmed)) continue;
    if (/^esc\s+to\s+interrupt/i.test(trimmed)) continue;
    if (/^Tip:/i.test(trimmed)) continue;
    if (/^Press\s+Ctrl/i.test(trimmed)) continue;
    if (/^\(\d+s\s*·\s*timeout\b/.test(trimmed)) continue;

    // Spinner/loading: "✶ Nebulizing…", "*Tomfoolering…", "✢thinking with high effort"
    if (/^[✶✻✽✢✹✷✸✺✼✾✿❀●○⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*·]+\s*[A-Za-z]+.*/.test(trimmed)) continue;
    if (/^[A-Z][a-z]+ing…?\s*$/.test(trimmed)) continue;
    // "thinking with high effort", "(thinking with high effort)"
    if (/^\(?thinking\s+with\s+(high|medium|low)\s+effort\)?$/i.test(trimmed)) continue;

    // Horizontal separators
    if (/^[─━═]{5,}$/.test(trimmed)) continue;

    // Prompt chrome
    if (/^❯/.test(trimmed)) continue;
    if (/\?\s+(for shortcuts|for help)/i.test(trimmed)) continue;
    if (/^●\s*(high|medium|low)\s*·\s*\//.test(trimmed)) continue;

    // Single decorative symbol
    if (trimmed.length === 1 && /[✶✻✽✢✹✷✸✺✼✾✿❀●○·*⎿⎡⎤⎣⎦╭╮╰╯│]/.test(trimmed)) continue;

    // Tool-call chrome: "● ToolName(args)" → "[ToolName] args"
    const toolCallMatch = trimmed.match(/^●\s*(\w+)\((.+)\)\s*$/);
    if (toolCallMatch) {
      cleaned.push(`[${toolCallMatch[1]}] ${toolCallMatch[2]}`);
      continue;
    }
    // "●content" (bare result)
    const bareResult = trimmed.match(/^●\s*(.+)$/);
    if (bareResult && !bareResult[1].includes('(')) {
      cleaned.push(bareResult[1]);
      continue;
    }
    // "⎿  result" decorator
    const resultPrefix = trimmed.match(/^⎿\s+(.+)$/);
    if (resultPrefix) {
      cleaned.push(resultPrefix[1]);
      continue;
    }

    // Status badges & hook output
    if (/^\(ctrl\+[a-z] to \w+\)$/i.test(trimmed)) continue;
    if (/^Running…$/.test(trimmed)) continue;
    if (/\(running \w+ hook\)/i.test(trimmed)) continue;
    if (/^…\s*\+\d+ lines/.test(trimmed)) continue;
    // Cooked/timer summaries
    if (/^[✶✻✽✢✹✷✸✺✼✾✿❀●○·*]\s*Cooked\s+for\b/i.test(trimmed)) continue;

    cleaned.push(line);
  }

  let result = cleaned.join('\n');
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/** Resolve a Windows-native home directory for Windows shells running under WSL interop. */
let _windowsHomeDirCache: string | undefined;
function getWindowsHomeDir(): string {
  if (_windowsHomeDirCache !== undefined) return _windowsHomeDirCache;
  try {
    const raw = execSync("cmd.exe /c \"echo %USERPROFILE%\" 2>/dev/null", { timeout: 3000 })
      .toString().trim().replace(/\r/g, '');
    if (raw && raw.includes('\\')) {
      const m = raw.match(/^([A-Za-z]):\\(.*)/);
      if (m) {
        _windowsHomeDirCache = `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
        return _windowsHomeDirCache;
      }
    }
  } catch { /* WSL interop not available */ }
  _windowsHomeDirCache = '/mnt/c';
  return _windowsHomeDirCache;
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
  shellType: 'linux' | 'windows'; // whether this is a WSL/Linux or Windows shell
}

/** Shells that are Windows executables (run via WSL interop) */
const WINDOWS_SHELLS = new Set(['powershell.exe', 'pwsh.exe', 'cmd.exe', 'powershell', 'pwsh']);

function isWindowsShell(shell: string): boolean {
  const base = basename(shell).toLowerCase();
  return WINDOWS_SHELLS.has(base);
}

const BACKPRESSURE_THRESHOLD = 1024 * 1024; // 1MB
const SCROLLBACK_BUFFER_LIMIT = 200 * 1024; // 200KB of output history

// IPC history limits
const IPC_HISTORY_MAX_ENTRIES = 50;
const IPC_HISTORY_MAX_BYTES = 512 * 1024;
const IPC_RESPONSE_MAX_BYTES = 32 * 1024;

export interface IpcHistoryEntry {
  turnId: string;
  prompt: string;
  response: string;
  sourceSessionId?: string;
  startedAt: number;
  completedAt?: number;
  status: 'pending' | 'complete';
  truncated?: boolean;
}

export interface NotificationEntry {
  notificationId: string;
  sourceSessionId: string;
  sourceName: string;
  message: string;
  timestamp: number;
  seq: number;            // monotonic sequence for ordering
  status: 'queued' | 'injected';
}

const NOTIFICATION_MAX_ENTRIES = 50;
const NOTIFICATION_MAX_MSG_BYTES = 4 * 1024; // 4KB per message

interface PtySession {
  pty: pty.IPty;
  ws: WebSocket | null;
  alive: boolean;
  buffer: string; // buffered output while detached
  lastOutputAt: number;    // timestamp of last PTY output
  outputBurstStart: number; // when current continuous output burst started
  lastInputAt: number;     // timestamp of last user input via WebSocket
  shellName: string; // normalized base name of shell (e.g. 'bash', 'zsh', 'cmd', 'powershell')
  shellType: 'linux' | 'windows'; // whether this is a WSL/Linux or Windows shell
  name?: string; // user-assigned label
  onDataDisposable: pty.IDisposable | null;
  onExitDisposable: pty.IDisposable | null;
  headlessTerm: InstanceType<typeof HeadlessTerminal>; // for IPC: renders PTY output properly
  pendingIpcCount: number;   // number of in-flight IPC turns targeting this session
  lastIpcSentAt: number;     // timestamp of most recent IPC send to this session
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();
  private nameIndex = new Map<string, string>(); // name → sessionId
  private links = new Map<string, Set<string>>(); // sessionId → Set<linkedSessionIds>
  private ipcHistory = new Map<string, IpcHistoryEntry[]>();
  private notificationQueues = new Map<string, NotificationEntry[]>();
  private notificationSeq = 0; // global monotonic counter
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
    const winShell = isWindowsShell(resolvedShell);
    const home = winShell ? getWindowsHomeDir() : getHomeDir();

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

    // Headless terminal for IPC: properly renders cursor movements, overwrites, etc.
    const headlessTerm = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });

    const session: PtySession = {
      pty: p,
      ws: null,
      alive: true,
      buffer: '',
      lastOutputAt: 0,
      outputBurstStart: 0,
      lastInputAt: 0,
      shellName,
      shellType: isWindowsShell(resolvedShell) ? 'windows' : 'linux',
      onDataDisposable: null,
      onExitDisposable: null,
      headlessTerm,
      pendingIpcCount: 0,
      lastIpcSentAt: 0,
    };

    // Always buffer all output (for replay on reconnect)
    session.onDataDisposable = p.onData((data: string) => {
      const now = Date.now();
      // Detect new output burst (gap > 500ms since last output)
      if (now - session.lastOutputAt > 500) {
        session.outputBurstStart = now;
      }
      session.lastOutputAt = now;

      // Always append to rolling buffer
      session.buffer += data;
      if (session.buffer.length > SCROLLBACK_BUFFER_LIMIT) {
        session.buffer = session.buffer.slice(-SCROLLBACK_BUFFER_LIMIT);
      }

      // Feed into headless terminal for proper rendering
      session.headlessTerm.write(data);

      // Schedule notification flush (debounced, detects processing→idle transition)
      this.scheduleNotificationFlush(sessionId);

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
      if (session.name) {
        this.nameIndex.delete(session.name);
      }
      this.cleanupLinks(sessionId);
      this.cleanupHistory(sessionId);
      session.headlessTerm.dispose();
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
      session.lastInputAt = Date.now();
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
      const c = Math.max(1, cols);
      const r = Math.max(1, rows);
      session.pty.resize(c, r);
      session.headlessTerm.resize(c, r);
    }
  }

  write(sessionId: string, data: string | Buffer): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastInputAt = Date.now();
      session.pty.write(typeof data === 'string' ? data : data.toString());
    }
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.name) {
        this.nameIndex.delete(session.name);
      }
      this.cleanupLinks(sessionId);
      this.cleanupHistory(sessionId);
      session.onDataDisposable?.dispose();
      session.onExitDisposable?.dispose();
      session.headlessTerm.dispose();
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

    if (session.shellType === 'windows') {
      // Windows shell via WSL interop: /proc won't reflect Windows process state
      // Use pty.process for foreground detection; CWD not reliably obtainable
      const currentProcess = normalizeProcessName(session.pty.process || '');
      if (currentProcess && currentProcess !== session.shellName) {
        foregroundProcess = currentProcess;
        isRunning = true;
      }
    } else if (currentPlatform === 'linux') {
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

    // ── isProcessing detection ──────────────────────────────────────
    const now = Date.now();
    const hasRecentOutput = now - session.lastOutputAt < 2000;
    const isSustainedBurst = session.lastOutputAt - session.outputBurstStart > 800;

    // Baseline: output-based heuristic (unchanged for non-IPC use)
    let isProcessing = isRunning && hasRecentOutput && isSustainedBurst;

    // Enhanced detection during active IPC turns
    if (session.pendingIpcCount > 0) {
      const hasOutputSinceSend = session.lastOutputAt > session.lastIpcSentAt;
      const hasPrompt = this.hasPromptAtEnd(sessionId);

      if (hasPrompt && !hasRecentOutput && hasOutputSinceSend) {
        // Prompt visible, output stopped, output occurred after send → done
        isProcessing = false;
      } else if (!hasPrompt && isRunning) {
        // No prompt yet → still processing (even if output paused >2s)
        isProcessing = true;
      } else if (!hasOutputSinceSend) {
        // No output since IPC send → hasn't started yet
        isProcessing = true;
      }
    }

    return { sessionId, pid, cwd, cwdShort, foregroundProcess, isRunning, isProcessing, name: session.name, shellType: session.shellType };
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

  /** Get current buffer length (raw) for offset tracking */
  getBufferLength(sessionId: string): number {
    return this.sessions.get(sessionId)?.buffer.length ?? 0;
  }

  /** Read all rendered lines from headless terminal */
  private getRenderedLines(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    const buf = session.headlessTerm.buffer.active;
    const totalLines = buf.baseY + buf.cursorY + 1;
    const lines: string[] = [];
    for (let y = 0; y < totalLines; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  /**
   * Check if an idle prompt (❯ with no trailing command) is visible
   * near the bottom of the rendered terminal screen.
   * Scans from the bottom, skipping blank and status-bar lines.
   */
  private hasPromptAtEnd(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const buf = session.headlessTerm.buffer.active;
    const totalLines = buf.baseY + buf.cursorY + 1;

    // Scan up to 10 lines from the bottom (covers status bars, separators)
    const scanStart = Math.max(0, totalLines - 10);
    for (let y = totalLines - 1; y >= scanStart; y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true).trim();
      if (!text) continue; // skip blank
      if (/^[─━═]{5,}$/.test(text)) continue; // skip separator
      if (/esc\s+to\s+interrupt/i.test(text)) continue; // skip status bar
      if (/^Tip:/i.test(text)) continue; // skip tips
      if (/^Press\s+Ctrl/i.test(text)) continue; // skip ctrl hints
      if (/^\(ctrl\+[a-z] to \w+\)$/i.test(text)) continue; // skip ctrl badges
      if (/\?\s+(for shortcuts|for help)/i.test(text)) continue; // skip help hints
      if (/^●\s*(high|medium|low)\s*·\s*\//i.test(text)) continue; // skip model/status badge
      if (/auto\s*mode/i.test(text)) continue; // skip auto mode status
      // Idle prompt: ❯ alone or ❯ followed only by whitespace
      if (/^❯\s*$/.test(text)) return true;
      // If we hit a non-prompt, non-skippable line, stop
      return false;
    }
    return false;
  }

  /**
   * Extract the IPC response for a given sent message.
   * Uses marker-based matching (preferred) with legacy prefix fallback.
   */
  getIpcResponse(sessionId: string, sentMessage: string, marker?: string): { output: string; isProcessing: boolean } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const status = this.getSessionStatus(sessionId);
    const isProcessing = status?.isProcessing ?? false;

    const lines = this.getRenderedLines(sessionId);
    let echoLine = -1;

    // Primary: marker-based match on prompt echo lines only
    // (avoids false hits if agent quotes the marker in its response)
    if (marker) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('❯') && trimmed.includes(marker)) {
          echoLine = i;
          break;
        }
      }
    }

    // Fallback: legacy prefix match (for backward compatibility)
    if (echoLine < 0) {
      const needle = sentMessage.slice(0, 60);
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('❯') && trimmed.includes(needle)) {
          echoLine = i;
          break;
        }
      }
    }

    if (echoLine < 0) {
      // Echo not found — fall back to last response if agent is done
      if (!isProcessing) {
        const last = this.getLastResponse(sessionId);
        if (last && last.output && last.prompt) {
          const promptNeedle = sentMessage.slice(0, 40);
          if (last.prompt.includes(promptNeedle)) {
            return { output: last.output, isProcessing: false };
          }
        }
      }
      return { output: '', isProcessing };
    }

    // Extract response lines: everything after echo until status bar / next prompt
    const responseLines: string[] = [];
    for (let i = echoLine + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^[─━═]{5,}$/.test(trimmed)) break;
      if (/^❯/.test(trimmed)) break;
      responseLines.push(lines[i]);
    }

    let output = stripAgentNoise(responseLines.join('\n'));
    return { output, isProcessing };
  }

  /**
   * Get the last agent response — finds the most recent ❯ prompt
   * and extracts everything between it and the status bar.
   */
  getLastResponse(sessionId: string): { prompt: string; output: string; isProcessing: boolean } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const status = this.getSessionStatus(sessionId);
    const isProcessing = status?.isProcessing ?? false;
    const lines = this.getRenderedLines(sessionId);

    // Find the last ❯ prompt line
    let promptLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (/^❯\s+\S/.test(trimmed)) {
        promptLine = i;
        break;
      }
    }

    if (promptLine < 0) {
      return { prompt: '', output: '', isProcessing };
    }

    const prompt = lines[promptLine].trim().replace(/^❯\s*/, '').trim();

    const responseLines: string[] = [];
    for (let i = promptLine + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (/^[─━═]{5,}$/.test(trimmed)) break;
      if (/^❯/.test(trimmed)) break;
      responseLines.push(lines[i]);
    }

    const output = stripAgentNoise(responseLines.join('\n'));
    return { prompt, output, isProcessing };
  }

  /**
   * Get rendered terminal screen content (via headless terminal).
   * Returns properly rendered text, free of animation artifacts.
   */
  getRenderedBuffer(sessionId: string, lastLines?: number, clean: boolean = true): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    let lines = this.getRenderedLines(sessionId);

    if (lastLines && lastLines > 0) {
      lines = lines.slice(-lastLines);
    }

    let output = lines.join('\n');
    if (clean) {
      output = stripAgentNoise(output);
    }
    return output;
  }

  // ── Link registry (peer routing) ──────────────────────────────────

  addLink(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    if (!this.links.has(sourceId)) this.links.set(sourceId, new Set());
    if (!this.links.has(targetId)) this.links.set(targetId, new Set());
    this.links.get(sourceId)!.add(targetId);
    this.links.get(targetId)!.add(sourceId);
  }

  removeLink(sourceId: string, targetId: string): void {
    this.links.get(sourceId)?.delete(targetId);
    this.links.get(targetId)?.delete(sourceId);
  }

  getPeers(sessionId: string): { sessionId: string; shortId: string; name?: string }[] {
    const peerIds = this.links.get(sessionId);
    if (!peerIds) return [];
    const peers: { sessionId: string; shortId: string; name?: string }[] = [];
    for (const peerId of peerIds) {
      if (this.sessions.has(peerId)) {
        peers.push({
          sessionId: peerId,
          shortId: peerId.slice(0, 8),
          name: this.sessions.get(peerId)?.name,
        });
      }
    }
    return peers;
  }

  getAllLinks(): { sourceId: string; targetId: string }[] {
    const seen = new Set<string>();
    const result: { sourceId: string; targetId: string }[] = [];
    for (const [sourceId, targets] of this.links) {
      for (const targetId of targets) {
        const key = [sourceId, targetId].sort().join(':');
        if (!seen.has(key)) {
          seen.add(key);
          result.push({ sourceId, targetId });
        }
      }
    }
    return result;
  }

  private cleanupLinks(sessionId: string): void {
    const peers = this.links.get(sessionId);
    if (peers) {
      for (const peerId of peers) {
        this.links.get(peerId)?.delete(sessionId);
      }
      this.links.delete(sessionId);
    }
  }

  /** Legacy: get buffer content since offset (for non-IPC use) */
  getBufferSince(sessionId: string, offset: number, clean: boolean = true): { output: string; offset: number } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const rawOutput = session.buffer.slice(offset);
    const newOffset = session.buffer.length;
    let output = stripAnsiCodes(rawOutput);
    if (clean) {
      output = stripAgentNoise(output);
    }

    return { output, offset: newOffset };
  }

  // ── IPC History ────────────────────────────────────────────────────

  /** Create a pending turn entry. Returns the generated turnId. */
  createPendingTurn(targetSessionId: string, prompt: string, sourceSessionId?: string): string {
    const turnId = randomBytes(8).toString('hex');
    if (!this.ipcHistory.has(targetSessionId)) {
      this.ipcHistory.set(targetSessionId, []);
    }
    const entries = this.ipcHistory.get(targetSessionId)!;
    entries.push({
      turnId,
      prompt,
      response: '',
      sourceSessionId,
      startedAt: Date.now(),
      status: 'pending',
    });
    this.enforceHistoryLimits(targetSessionId);

    // Track in-flight IPC for enhanced isProcessing detection
    const session = this.sessions.get(targetSessionId);
    if (session) {
      session.pendingIpcCount++;
      // Use earliest pending turn's timestamp (safe for concurrent IPCs)
      if (session.lastIpcSentAt === 0) {
        session.lastIpcSentAt = Date.now();
      }
    }

    return turnId;
  }

  /** Idempotently finalize a pending turn with the response. Returns true if updated. */
  finalizeTurn(targetSessionId: string, turnId: string, response: string): boolean {
    const entries = this.ipcHistory.get(targetSessionId);
    if (!entries) return false;
    const entry = entries.find(e => e.turnId === turnId);
    if (!entry || entry.status === 'complete') return false;

    let truncated = false;
    let finalResponse = response;
    if (Buffer.byteLength(finalResponse, 'utf-8') > IPC_RESPONSE_MAX_BYTES) {
      // Truncate to fit within limit
      const buf = Buffer.from(finalResponse, 'utf-8');
      finalResponse = buf.subarray(0, IPC_RESPONSE_MAX_BYTES).toString('utf-8');
      truncated = true;
    }

    entry.response = finalResponse;
    entry.completedAt = Date.now();
    entry.status = 'complete';
    if (truncated) entry.truncated = true;

    // Decrement in-flight IPC counter
    const session = this.sessions.get(targetSessionId);
    if (session && session.pendingIpcCount > 0) {
      session.pendingIpcCount--;
      // Reset timestamp when no more pending turns
      if (session.pendingIpcCount === 0) {
        session.lastIpcSentAt = 0;
      }
    }

    this.enforceHistoryLimits(targetSessionId);
    return true;
  }

  /** Get IPC history entries for a session. */
  getIpcHistory(sessionId: string): IpcHistoryEntry[] {
    return this.ipcHistory.get(sessionId) || [];
  }

  /** Expire stale pending turns (no finalize within 10 minutes). */
  expireStaleTurns(sessionId: string): void {
    const entries = this.ipcHistory.get(sessionId);
    if (!entries) return;
    const session = this.sessions.get(sessionId);
    const now = Date.now();
    const STALE_TIMEOUT = 10 * 60 * 1000; // 10 minutes

    for (const entry of entries) {
      if (entry.status === 'pending' && now - entry.startedAt > STALE_TIMEOUT) {
        entry.status = 'complete';
        entry.response = '(timed out)';
        entry.completedAt = now;
        if (session && session.pendingIpcCount > 0) {
          session.pendingIpcCount--;
          if (session.pendingIpcCount === 0) {
            session.lastIpcSentAt = 0;
          }
        }
      }
    }
  }

  /** Enforce FIFO limits: max entries and max total bytes. */
  private enforceHistoryLimits(sessionId: string): void {
    const entries = this.ipcHistory.get(sessionId);
    if (!entries) return;
    const session = this.sessions.get(sessionId);

    // Entry count limit
    while (entries.length > IPC_HISTORY_MAX_ENTRIES) {
      const removed = entries.shift()!;
      if (removed.status === 'pending' && session && session.pendingIpcCount > 0) {
        session.pendingIpcCount--;
        if (session.pendingIpcCount === 0) session.lastIpcSentAt = 0;
      }
    }

    // Size limit
    let totalBytes = 0;
    for (const e of entries) {
      totalBytes += Buffer.byteLength(e.prompt, 'utf-8') + Buffer.byteLength(e.response, 'utf-8');
    }
    while (totalBytes > IPC_HISTORY_MAX_BYTES && entries.length > 0) {
      const removed = entries.shift()!;
      if (removed.status === 'pending' && session && session.pendingIpcCount > 0) {
        session.pendingIpcCount--;
        if (session.pendingIpcCount === 0) session.lastIpcSentAt = 0;
      }
      totalBytes -= Buffer.byteLength(removed.prompt, 'utf-8') + Buffer.byteLength(removed.response, 'utf-8');
    }
  }

  /** Remove all IPC history for a session. */
  private cleanupHistory(sessionId: string): void {
    this.ipcHistory.delete(sessionId);
    this.notificationQueues.delete(sessionId);
  }

  // ── Notification Queue ─────────────────────────────────────────────

  /** Enqueue a notification for a target session. Returns notificationId. */
  enqueueNotification(targetSessionId: string, sourceSessionId: string, message: string): string {
    const notificationId = randomBytes(8).toString('hex');
    const sourceName = this.sessions.get(sourceSessionId)?.name || sourceSessionId.slice(0, 8);

    // Truncate message to limit
    let truncatedMsg = message;
    if (Buffer.byteLength(truncatedMsg, 'utf-8') > NOTIFICATION_MAX_MSG_BYTES) {
      const buf = Buffer.from(truncatedMsg, 'utf-8');
      truncatedMsg = buf.subarray(0, NOTIFICATION_MAX_MSG_BYTES).toString('utf-8');
    }

    if (!this.notificationQueues.has(targetSessionId)) {
      this.notificationQueues.set(targetSessionId, []);
    }
    const queue = this.notificationQueues.get(targetSessionId)!;
    queue.push({
      notificationId,
      sourceSessionId,
      sourceName,
      message: truncatedMsg,
      timestamp: Date.now(),
      seq: ++this.notificationSeq,
      status: 'queued',
    });

    // Enforce max entries
    while (queue.length > NOTIFICATION_MAX_ENTRIES) {
      queue.shift();
    }

    // Try immediate flush if target is idle
    this.tryFlushNotifications(targetSessionId);

    return notificationId;
  }

  /** Flush queued notifications to PTY if session is idle. */
  tryFlushNotifications(sessionId: string): void {
    const queue = this.notificationQueues.get(sessionId);
    if (!queue) return;

    const queued = queue.filter(n => n.status === 'queued');
    if (queued.length === 0) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Only auto-flush if agent is idle AND no recent human input (within 3s)
    const status = this.getSessionStatus(sessionId);
    if (status?.isProcessing) return;
    const now = Date.now();
    if (now - session.lastInputAt < 3000) return;

    // Inject a single summary line (safe, fixed format — no raw user content)
    const count = queued.length;
    const summary = count === 1
      ? `[tboard] 1 notification from "${queued[0].sourceName}". Run: tt notifications`
      : `[tboard] ${count} notifications pending. Run: tt notifications`;

    this.write(sessionId, `\x1b[200~${summary}\x1b[201~\r`);

    // Mark as injected
    for (const n of queued) {
      n.status = 'injected';
    }
  }

  /**
   * Schedule a debounced notification flush for a session.
   * Called from PTY onData to detect isProcessing true→false transitions.
   */
  private notificationFlushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  scheduleNotificationFlush(sessionId: string): void {
    // Only bother if there are queued notifications
    const queue = this.notificationQueues.get(sessionId);
    if (!queue || !queue.some(n => n.status === 'queued')) return;

    // Debounce: wait 3s after last output before attempting flush
    const existing = this.notificationFlushTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    this.notificationFlushTimers.set(sessionId, setTimeout(() => {
      this.notificationFlushTimers.delete(sessionId);
      this.tryFlushNotifications(sessionId);
    }, 3000));
  }

  /** Get all notifications for a session (for tt notifications command). */
  getNotifications(sessionId: string): NotificationEntry[] {
    return this.notificationQueues.get(sessionId) || [];
  }

  /** Clear delivered notifications for a session. */
  clearNotifications(sessionId: string): void {
    this.notificationQueues.delete(sessionId);
  }
}
