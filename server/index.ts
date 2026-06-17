import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes, timingSafeEqual } from 'crypto';
import { resolve, dirname, join, extname, basename, sep } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, renameSync, unlinkSync, rmSync, realpathSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { PtyManager, DispatchOverflowError, elideMiddle, type ElideResult, type NotificationEntry } from './pty-manager.js';
import { captureRegionPng, canCaptureScreen, wslPathToWindows, ScreenshotError } from './screenshot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);
const SOCKET_PATH = join(tmpdir(), `tboard-${PORT}.sock`);

const app = express();
app.use(express.json({ limit: '50mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Resolve bin directory for tt CLI
const binDir = resolve(__dirname, '../bin');
const binDirResolved = existsSync(binDir) ? binDir : resolve(__dirname, '../../bin');

const ptyManager = new PtyManager(PORT, binDirResolved, SOCKET_PATH);

// ── Token efficiency (Phase 8) ────────────────────────────────────────
// Default byte budgets for read-time middle-elision (8.2 / 8.1). These bound
// how much a single read drops into MAIN's context; full data stays on disk.
const READ_MAX_BYTES_DEFAULT = 32768;   // rendered / capture reads
const REPORT_MAX_BYTES_DEFAULT = 65536; // task report (usually a small summary)
const REPORT_HARD_LIMIT_BYTES = 10 * 1024 * 1024; // 10MB report fetch ceiling

/** Parse a `maxBytes` query value. Missing → fallback. `0` → unlimited (0). */
function parseMaxBytes(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = parseInt(String(raw), 10);
  if (isNaN(n) || n < 0) return fallback;
  return n; // 0 means unlimited (elideMiddle treats <=0 as passthrough)
}

// In-memory read accounting (8.4). Reset on restart; not persisted.
type ReadApi = 'rendered' | 'capture' | 'report' | 'manifest' | 'buffer';
interface ReadStats { calls: number; bytesReturned: number; bytesElided: number }
const readStatsSince = new Date().toISOString();
const readStatsTotals = new Map<ReadApi, ReadStats>();
const readStatsSessions = new Map<string, Map<ReadApi, ReadStats>>();
const READ_STATS_MAX_SESSIONS = 500;

function bumpStats(map: Map<ReadApi, ReadStats>, api: ReadApi, bytesReturned: number, bytesElided: number): void {
  let s = map.get(api);
  if (!s) { s = { calls: 0, bytesReturned: 0, bytesElided: 0 }; map.set(api, s); }
  s.calls++;
  s.bytesReturned += bytesReturned;
  s.bytesElided += bytesElided;
}

/**
 * Record a read for stats. Exception-safe: a metrics failure must never break
 * an API response (8.4). `el` carries the elided text + omitted byte count.
 */
function recordRead(api: ReadApi, sessionId: string | null, el: ElideResult): void {
  try {
    const bytesReturned = Buffer.byteLength(el.text);
    bumpStats(readStatsTotals, api, bytesReturned, el.omittedBytes);
    if (sessionId) {
      let sm = readStatsSessions.get(sessionId);
      if (!sm) {
        // Bound memory: evict the oldest-inserted session entry (Map preserves insertion order).
        if (readStatsSessions.size >= READ_STATS_MAX_SESSIONS) {
          const oldest = readStatsSessions.keys().next().value;
          if (oldest !== undefined) readStatsSessions.delete(oldest);
        }
        sm = new Map();
        readStatsSessions.set(sessionId, sm);
      }
      bumpStats(sm, api, bytesReturned, el.omittedBytes);
    }
  } catch { /* metrics are best-effort */ }
}

// Resolve session ID from full ID, short prefix, or name
function resolveSession(idOrName: string): string | null {
  return ptyManager.resolveSession(idOrName);
}

function getFileInfo(filePath: string) {
  const st = statSync(filePath);
  return {
    path: filePath,
    name: basename(filePath),
    size: st.size,
    modified: st.mtime.toISOString(),
    mtimeMs: st.mtimeMs,
    extension: extname(filePath).slice(1).toLowerCase(),
  };
}

function isDescendantPath(parentPath: string, childPath: string): boolean {
  const normalizedParent = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
  return childPath === parentPath || childPath.startsWith(normalizedParent);
}

// ── File API path containment ─────────────────────────────────────────
// Every filesystem endpoint must stay within an allowlist of roots so a caller
// (even an authenticated one) cannot read /etc/passwd or write ~/.zshrc outside
// the intended sandbox. Defaults to the home dir and the OS tmp dir; extend via
// TBOARD_ALLOWED_ROOTS (colon-separated) e.g. to expose /mnt/c on WSL.
const ALLOWED_ROOTS: string[] = (process.env.TBOARD_ALLOWED_ROOTS
  ? process.env.TBOARD_ALLOWED_ROOTS.split(':')
  : [homedir(), tmpdir()]
).filter(Boolean).map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });

class PathNotAllowedError extends Error {
  constructor(p: string) {
    super(`path not allowed: ${p}`);
    this.name = 'PathNotAllowedError';
  }
}

// Expand a leading ~ to the home directory, then absolutize.
function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

// Resolve `p` to an absolute path and assert it lives under an allowed root.
// Symlink-safe: it realpaths the nearest existing ancestor so a symlink that
// escapes the sandbox is rejected even if its own path string looks contained.
function assertAllowedPath(p: string): string {
  const abs = expandPath(p);
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    real = probe;
  }
  // Re-append the part of `abs` past the existing ancestor so the comparison
  // uses the real (symlink-resolved) prefix plus the not-yet-created tail.
  const tail = abs.slice(probe.length);
  const candidate = real + tail;
  const ok = ALLOWED_ROOTS.some((root) => candidate === root || candidate.startsWith(root + sep));
  if (!ok) throw new PathNotAllowedError(abs);
  return abs;
}

// Map an error thrown during a file op to a response. PathNotAllowedError → 403.
function sendFileError(res: import('express').Response, err: unknown, status = 400): void {
  if (err instanceof PathNotAllowedError) {
    res.status(403).json({ error: 'path not allowed' });
    return;
  }
  res.status(status).json({ error: String(err) });
}

// ── Persistent directory store (recent + pinned) ──────────────────────
// Recent: auto-maintained, capped at MAX_RECENT_DIRS, MRU-first.
// Pinned: user-managed, no cap, insertion-order. The two lists are independent;
// a path can appear in pinned without being in recent.
const DIRS_STATE_DIR = process.env.TBOARD_STATE_DIR
  || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'tboard');
const DIRS_STATE_FILE = join(DIRS_STATE_DIR, 'dirs.json');
const MAX_RECENT_DIRS = 5;

interface DirsState {
  recent: string[];
  pinned: string[];
}

let dirsState: DirsState = { recent: [], pinned: [] };

function loadDirsState(): DirsState {
  try {
    const raw = readFileSync(DIRS_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const recent = Array.isArray(parsed.recent)
      ? parsed.recent.filter((s: unknown): s is string => typeof s === 'string').slice(0, MAX_RECENT_DIRS)
      : [];
    const pinned = Array.isArray(parsed.pinned)
      ? parsed.pinned.filter((s: unknown): s is string => typeof s === 'string')
      : [];
    return { recent, pinned };
  } catch {
    return { recent: [], pinned: [] };
  }
}

function saveDirsState(): void {
  try {
    mkdirSync(DIRS_STATE_DIR, { recursive: true });
    writeFileSync(DIRS_STATE_FILE, JSON.stringify(dirsState, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[tboard] Failed to persist dirs state: ${err}`);
  }
}

dirsState = loadDirsState();

// ── Memo persistence (same state dir as dirs.json) ────────────────────
// Memos are agent-visible scratch notes, keyed by the memo window's pseudo id.
const MEMOS_FILE = join(DIRS_STATE_DIR, 'memos.json');

interface Memo {
  id: string;
  title: string;
  text: string;
  updatedAt: number;
}

function loadMemos(): Memo[] {
  try {
    const parsed = JSON.parse(readFileSync(MEMOS_FILE, 'utf-8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((m: unknown): m is Memo =>
        !!m && typeof m === 'object' && typeof (m as Memo).id === 'string')
      .map((m: Memo) => ({
        id: m.id,
        title: typeof m.title === 'string' ? m.title : '',
        text: typeof m.text === 'string' ? m.text : '',
        updatedAt: typeof m.updatedAt === 'number' ? m.updatedAt : 0,
      }));
  } catch {
    return [];
  }
}

let memos: Memo[] = loadMemos();

function saveMemos(): void {
  try {
    mkdirSync(DIRS_STATE_DIR, { recursive: true });
    writeFileSync(MEMOS_FILE, JSON.stringify(memos, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[tboard] Failed to persist memos: ${err}`);
  }
}

// Single server token, generated once at startup. Browser clients fetch it from
// GET /api/token and send it back as the x-tboard-token header on every /api call
// (and as ?token= for raw/download URLs that cannot set headers).
const serverToken = randomBytes(32).toString('hex');

// Matches localhost / 127.0.0.1 (optionally with a port) for the Host header.
const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1)(:\d+)?$/;

// Timing-safe equality against the single server token.
function isServerToken(token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(serverToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Endpoints whose credentials may arrive as a ?token= query param, because the
// browser cannot attach headers to <img src>, <a href> or DownloadURL drags.
const QUERY_TOKEN_PATHS = new Set(['/files/raw', '/files/download']);

// Authentication gate for every /api/* route. Registered before any route so it
// runs first. Accepts: requests over the Unix socket (no remoteAddress; trusted
// via filesystem permissions), the server token, or any live session token.
app.use('/api', (req, res, next) => {
  // GET /api/token is public; it is protected by its own Host-header check.
  if (req.method === 'GET' && req.path === '/token') {
    next();
    return;
  }
  // Unix socket requests have no remoteAddress. These come from bin/tt, which is
  // already protected by the socket file's permissions.
  if (req.socket.remoteAddress === undefined) {
    next();
    return;
  }
  let token = req.get('x-tboard-token') || undefined;
  // Allow ?token= for the header-less browser fetch paths (images, downloads).
  if (!token && req.method === 'GET' && QUERY_TOKEN_PATHS.has(req.path)) {
    const q = req.query.token;
    if (typeof q === 'string') token = q;
  }
  if (isServerToken(token) || ptyManager.isValidSessionToken(token)) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
});

// Token endpoint. Guarded by a Host-header check to defeat DNS rebinding: a
// malicious page that resolves an attacker domain to 127.0.0.1 would still send
// its own Host, which will not match loopback, so the token is never handed out.
app.get('/api/token', (req, res) => {
  const host = req.headers.host || '';
  if (!LOOPBACK_HOST_RE.test(host)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  // Never cache the token. serverToken is regenerated on every server start, so
  // a cached response (e.g. an app-mode window reopened against a restarted
  // backend) would hand back a stale token and every /api + /ws call would 401.
  res.set('Cache-Control', 'no-store');
  res.json({ token: serverToken });
});

// ── Recent + pinned directories (persisted to ~/.local/state/tboard/dirs.json) ──

app.get('/api/dirs', (_req, res) => {
  res.json(dirsState);
});

app.post('/api/dirs/recent', (req, res) => {
  const { cwd } = req.body || {};
  if (typeof cwd !== 'string' || cwd.length === 0) {
    res.status(400).json({ error: 'cwd must be a non-empty string' });
    return;
  }
  if (dirsState.recent[0] !== cwd) {
    dirsState.recent = [cwd, ...dirsState.recent.filter((d) => d !== cwd)].slice(0, MAX_RECENT_DIRS);
    saveDirsState();
  }
  res.json(dirsState);
});

app.post('/api/dirs/pinned', (req, res) => {
  const { cwd } = req.body || {};
  if (typeof cwd !== 'string' || cwd.length === 0) {
    res.status(400).json({ error: 'cwd must be a non-empty string' });
    return;
  }
  if (!dirsState.pinned.includes(cwd)) {
    dirsState.pinned = [...dirsState.pinned, cwd];
    saveDirsState();
  }
  res.json(dirsState);
});

app.delete('/api/dirs/pinned', (req, res) => {
  const { cwd } = req.body || {};
  if (typeof cwd !== 'string' || cwd.length === 0) {
    res.status(400).json({ error: 'cwd must be a non-empty string' });
    return;
  }
  const next = dirsState.pinned.filter((d) => d !== cwd);
  if (next.length !== dirsState.pinned.length) {
    dirsState.pinned = next;
    saveDirsState();
  }
  res.json(dirsState);
});

// ── Memos ─────────────────────────────────────────────────────────────
app.get('/api/memos', (_req, res) => {
  res.json(memos);
});

app.put('/api/memos/:id', (req, res) => {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const { text, title } = req.body || {};
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'text must be a string' });
    return;
  }
  const updatedAt = Date.now();
  const existing = memos.find((m) => m.id === id);
  if (existing) {
    existing.text = text;
    if (typeof title === 'string') existing.title = title;
    existing.updatedAt = updatedAt;
  } else {
    memos.push({ id, title: typeof title === 'string' ? title : '', text, updatedAt });
  }
  saveMemos();
  res.json(memos.find((m) => m.id === id));
});

app.delete('/api/memos/:id', (req, res) => {
  const id = req.params.id;
  const next = memos.filter((m) => m.id !== id);
  if (next.length !== memos.length) {
    memos = next;
    saveMemos();
  }
  res.json({ ok: true });
});

// Create terminal
app.post('/api/terminals', (req, res) => {
  const { cols = 80, rows = 24, cwd, shell, initialCommand } = req.body || {};
  const sessionId = ptyManager.create(
    cols, rows, cwd, shell,
    typeof initialCommand === 'string' ? initialCommand : undefined
  );
  const pid = ptyManager.getPid(sessionId);
  res.json({ sessionId, pid });
});

// List active sessions (for reconnection after reload)
app.get('/api/terminals', (_req, res) => {
  const sessions = ptyManager.listSessions();
  res.json({ sessions });
});

// Terminal statuses (CWD, foreground process, running state)
app.get('/api/terminals/status', (_req, res) => {
  const statuses = ptyManager.getAllStatuses();
  res.json({ statuses });
});

// Write to a terminal's PTY (supports short ID / name resolution)
app.post('/api/terminals/:sessionId/write', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { data, sourceSessionId } = req.body || {};
  // Enforce link relationship for CLI callers (tt send --raw).
  // Note: sourceSessionId is optional — callers without it (e.g. raw HTTP) bypass this check.
  // Full API auth is out of scope; this prevents cross-session misrouting from tboard sessions.
  if (sourceSessionId) {
    const resolvedSource = resolveSession(sourceSessionId);
    if (!resolvedSource || !ptyManager.arePeers(resolvedSource, resolved)) {
      res.status(403).json({ error: 'Not linked: write requires a peer relationship' });
      return;
    }
  }
  if (typeof data === 'string') {
    ptyManager.write(resolved, data);
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'data must be a string' });
  }
});

// Read terminal output buffer
app.get('/api/terminals/:sessionId/buffer', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const lines = parseInt(req.query.lines as string) || 100;
  const plain = req.query.plain !== 'false';
  const output = ptyManager.getBuffer(resolved, lines, plain);
  // `--buffer` is an explicit raw escape hatch; no elision, but still metered (8.4).
  recordRead('buffer', resolved, { text: output ?? '', elided: false, omittedLines: 0, omittedBytes: 0 });
  res.json({ output, sessionId: resolved });
});

// Set terminal name
app.put('/api/terminals/:sessionId/name', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const { name } = req.body || {};
  if (typeof name !== 'string') {
    res.status(400).json({ error: 'name must be a string' });
    return;
  }
  // setName disambiguates collisions; echo the name actually assigned so the
  // client can reflect e.g. "foo" -> "foo-2" in the title.
  const assignedName = ptyManager.setName(resolved, name);
  res.json({ ok: true, sessionId: resolved, name: assignedName ?? name });
});

// Upload file to terminal's CWD → return path
app.post('/api/upload', (req, res) => {
  const { filename, data, cwd } = req.body || {};
  if (!filename || !data || !cwd) {
    res.status(400).json({ error: 'filename, data, cwd required' });
    return;
  }
  try {
    const sanitized = filename.replace(/[/\\]/g, '_');
    const filePath = assertAllowedPath(join(cwd, sanitized));
    const buf = Buffer.from(data, 'base64');
    writeFileSync(filePath, buf);
    res.json({ path: filePath });
  } catch (err) {
    sendFileError(res, err, 500);
  }
});

// Capability probe: surface whether the host can launch the region-snip UI.
app.get('/api/screenshot/capabilities', (_req, res) => {
  res.json({ supported: canCaptureScreen() });
});

// Per-session guard: at most one capture in flight per terminal. Prevents the
// double-click race where two PS children fight over the Windows clipboard.
const inflightCaptures = new Set<string>();

// Capture a screen region via the native Windows snip UI, save the PNG into
// the terminal's CWD, and paste the resulting path into the terminal's PTY.
app.post('/api/terminals/:sessionId/screenshot', async (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  if (!canCaptureScreen()) {
    res.status(501).json({ error: 'Screen capture not supported on this platform' });
    return;
  }
  if (inflightCaptures.has(resolved)) {
    res.status(409).json({ error: 'Capture already in progress for this terminal', code: 'BUSY' });
    return;
  }
  inflightCaptures.add(resolved);

  try {
    const png = await captureRegionPng();

    // Re-check session liveness — user may have closed the terminal mid-capture.
    const status = ptyManager.getSessionStatus(resolved);
    if (!status) {
      res.status(410).json({ error: 'Session closed during capture', code: 'GONE' });
      return;
    }
    const isWindowsShell = status.shellType === 'windows';
    const linuxCwd = status.cwd;

    // Save location: terminal's CWD when known (WSL/Linux/macOS). For a
    // Windows-shell terminal (CWD not reliably obtainable), fall back to
    // the system tmpdir.
    const saveDir = !isWindowsShell && linuxCwd && existsSync(linuxCwd) ? linuxCwd : tmpdir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
    const filename = `screenshot-${ts}.png`;
    const savedPath = join(saveDir, filename);
    writeFileSync(savedPath, png);

    // Paste path into the terminal. Windows-shell terminals need a Windows path;
    // everyone else gets the POSIX path. POSIX is always single-quoted with
    // embedded quotes escaped so any shell metacharacter in the cwd is safe.
    let pasted: string;
    if (isWindowsShell) {
      const winPath = wslPathToWindows(savedPath) || savedPath;
      pasted = /\s/.test(winPath) ? `"${winPath}"` : winPath;
    } else {
      pasted = `'${savedPath.replace(/'/g, "'\\''")}'`;
    }
    // Bracketed paste only (no Enter), deferred until the prompt is idle so it
    // never corrupts a running agent's input line.
    ptyManager.pasteNoSubmit(resolved, pasted);

    res.json({ ok: true, path: savedPath, pastedAs: pasted });
  } catch (err) {
    if (err instanceof ScreenshotError) {
      const statusCode =
        err.code === 'CANCELED' ? 499 :
        err.code === 'TIMEOUT' ? 408 :
        err.code === 'UNSUPPORTED' ? 501 :
        err.code === 'LAUNCH_FAILED' ? 503 :
        500;
      res.status(statusCode).json({ error: err.message, code: err.code });
    } else {
      res.status(500).json({ error: String(err) });
    }
  } finally {
    inflightCaptures.delete(resolved);
  }
});

// ── Links: Peer routing registry ─────────────────────────────────────

// Pairs the user recently removed, so a quick re-link is recognized as a
// reconnection (after a dropped connection) rather than a brand-new link.
const recentlyUnlinked = new Map<string, number>(); // "idA|idB" → unlinkedAt(ms)
const RECONNECT_WINDOW_MS = 30 * 60 * 1000;
const linkPairKey = (a: string, b: string) => [a, b].sort().join('|');

// Register a link (bidirectional)
app.post('/api/links', (req, res) => {
  const { sourceId: rawSourceId, targetId: rawTargetId } = req.body || {};
  if (!rawSourceId || !rawTargetId) {
    res.status(400).json({ error: 'sourceId and targetId are required' });
    return;
  }
  // Resolve to canonical session IDs (accepts full ID, short prefix, or name) so
  // this endpoint uses the same identity rules as every other route — otherwise
  // linkPairKey / arePeers / addLink could key off a name while peers were keyed
  // off the full ID.
  const sourceId = resolveSession(rawSourceId);
  const targetId = resolveSession(rawTargetId);
  if (!sourceId || !targetId) {
    res.status(404).json({ error: 'session not found' });
    return;
  }
  const { autoName } = req.body || {};

  // Idempotent: if the server still has these two linked (a reload re-registering
  // an existing link, or PTYs that survived a WebSocket drop), do nothing — no
  // context re-injection, no rename, no reconnect notice.
  if (ptyManager.arePeers(sourceId, targetId)) {
    res.json({ ok: true, alreadyLinked: true });
    return;
  }

  // Detect a reconnection: the user removed the link moments ago and is re-drawing
  // it. The agents still hold their collaboration context in scrollback.
  const pairKey = linkPairKey(sourceId, targetId);
  const unlinkedAt = recentlyUnlinked.get(pairKey);
  const recentlyDropped = unlinkedAt !== undefined && Date.now() - unlinkedAt < RECONNECT_WINDOW_MS;
  recentlyUnlinked.delete(pairKey);

  ptyManager.addLink(sourceId, targetId);

  // Auto-name the SUB server-side (only when asked and it has no name yet) so a
  // reload restoring the link never overwrites a user's custom name.
  let assignedName: string | undefined;
  if (autoName && !ptyManager.getName(targetId)) {
    assignedName = ptyManager.setName(targetId, `sub-${ptyManager.getSubCount(sourceId)}`);
  }

  const sourceName = ptyManager.getName(sourceId) || sourceId.slice(0, 8);
  const targetName = ptyManager.getName(targetId) || targetId.slice(0, 8);

  // Reconnection: tell BOTH agents the connection dropped and is back (fact only,
  // no action instruction) and skip the verbose new-link protocol dump.
  if (recentlyDropped) {
    const submitDelay = 500;
    const notices: [string, string][] = [
      [sourceId, `[tboard] SYSTEM (automated notice, not user input): The connection to "${targetName}" was lost and has been re-established (reconnected).`],
      [targetId, `[tboard] SYSTEM (automated notice, not user input): The connection to "${sourceName}" was lost and has been re-established (reconnected).`],
    ];
    for (const [id, msg] of notices) {
      ptyManager.write(id, msg);
      setTimeout(() => ptyManager.write(id, '\r'), submitDelay);
    }
    res.json({ ok: true, reconnected: true });
    return;
  }

  // Ensure output directory for the sub-agent
  const outputDir = ptyManager.ensureOutputDir(sourceId, targetId);

  // Inject agent collaboration context into both terminals

  // Phase 4a: MAIN-side link paste is now intentionally brief. MAIN is typically
  // the orchestrator — a capable agent that can discover commands via `tt help`
  // or MCP `tools/list`. Flooding its PTY with a 20-line protocol dump every
  // link creation was buffer spam. SUB-side context below remains verbose since
  // SUB is more often a task-focused agent that benefits from the inline brief.
  const mainContext = [
    `[tboard] You are MAIN, linked to sub-agent "${targetName}".`,
    `Dispatch: tt peer send "task" → returns task_id. Close: SUB runs \`tt task complete <id>\`.`,
    `Read results: tt tasks | tt task show <id> | tt task report <id> | tt task manifest <id>.`,
    `MCP: enable \`tt mcp-stdio\` in your agent's .mcp.json for tool-based access.`,
    ``
  ].join('\n');

  const subContext = [
    `[tboard] SYSTEM NOTIFICATION -- This is an automated message from the terminal board, not user input.`,
    `Terminal link established with "${sourceName}".`,
    ``,
    `  COMPLETION PROTOCOL (mandatory):`,
    `    Every delegated task paste begins with an inline prefix on the first line:`,
    `      [tboard task_id=<id>] <task content...>`,
    `    When you finish the task you MUST run:`,
    `      tt task complete <task_id> --summary "one-line" --changed "f1,f2" --unresolved "none" [--report <file>]`,
    `    Use --changed none / --unresolved none when there are no items.`,
    `    Use --failed if the task could not be completed (still sets task state, so MAIN unblocks).`,
    `    If you did not capture the task_id, recover it with: tt task current`,
    ``,
    `  REPORTING (for substantial tasks — implementation, review, analysis, bug fix):`,
    `    Token discipline: MAIN reads your report, NOT your full transcript. Keep MAIN's`,
    `    context small with a 3-layer structure:`,
    `      1. manifest (summary/changed/unresolved on tt task complete) — machine-readable, tiny.`,
    `      2. report.md — an EXECUTIVE SUMMARY (~2KB max): conclusion, counts, severity, next action.`,
    `      3. Bulk artifacts (full review, test logs, diffs) → SEPARATE files in the task dir;`,
    `         reference them from report.md by name + 1-line note (e.g. "details: review.md (12 findings: P0x1 P1x4)").`,
    `    Do NOT paste long output into the terminal — write it to a file instead.`,
    `    Each task gets its OWN output directory. Obtain the path with:`,
    `      tt task dir <task_id>           Prints the absolute path to this task's output dir`,
    `    Write your report file inside that directory:`,
    `      Implementation/bug fix → report.md (Summary, Changed Files, Key Decisions, Build Status, Open Issues)`,
    `      Code review            → review.md (Verdict: PASS/FAIL, Critical items, Warnings)`,
    `    Pass --report <filename> (BARE filename, NOT a path) to tt task complete:`,
    `      tt task complete <id> --summary "..." --report report.md --changed "f1,f2" --unresolved none`,
    `    The server resolves <filename> under the task dir. MAIN reads it via \`tt task report <id>\`.`,
    `    Skip reports for simple tasks (confirmations, single-file fixes, questions).`,
    ``,
    `    Legacy peer-scoped dir (${outputDir}) still exists for debug/backwards-compat,`,
    `    but do NOT write reports there — reports for completed tasks belong in the task dir.`,
    ``,
    `  UI notifications (informational — do NOT close tasks):`,
    `    tt peer notify "<message>"     Delivers a UI bubble to MAIN. Does not change task state.`,
    `    A \`DONE:\` prefix is no longer parsed — run \`tt task complete <task_id>\` to close the task.`,
    ``,
    `  Other commands:`,
    `    tt peer send "message"       Send a message to the linked terminal`,
    `    tt peer notify "message"     Send a UI notification to the linked terminal`,
    ``
  ].join('\n');

  // Send prompt text first, then submit with a delayed Enter
  // so Claude Code doesn't swallow the \r inside a pasted block.
  const submitDelay = 500;
  for (const [id, ctx] of [[sourceId, mainContext], [targetId, subContext]] as const) {
    ptyManager.write(id, ctx);
    setTimeout(() => ptyManager.write(id, '\r'), submitDelay);
  }

  res.json({ ok: true, assignedName });
});

// Reconnect: link a new session as a replacement for a disconnected peer
app.post('/api/links/reconnect', (req, res) => {
  const { sourceId, newTargetId, asName } = req.body || {};
  if (!sourceId || !newTargetId || !asName) {
    res.status(400).json({ error: 'sourceId, newTargetId, and asName are required' });
    return;
  }

  const resolvedSource = resolveSession(sourceId);
  const resolvedTarget = resolveSession(newTargetId);
  if (!resolvedSource) {
    res.status(404).json({ error: `Source session not found: ${sourceId}` });
    return;
  }

  if (!resolvedTarget) {
    res.status(404).json({ error: `Target session not found: ${newTargetId}` });
    return;
  }

  // Find the disconnected peer entry
  const disconnected = ptyManager.findDisconnectedPeer(resolvedSource, asName);

  // Set name on new target
  ptyManager.setName(resolvedTarget, asName);

  // Create the link
  ptyManager.addLink(resolvedSource, resolvedTarget);

  // Ensure output directory for the reconnected sub-agent
  const reconOutputDir = ptyManager.ensureOutputDir(resolvedSource, resolvedTarget);

  // Clear disconnected peer entry if found
  if (disconnected) {
    ptyManager.clearRecentDisconnect(resolvedSource, disconnected.sessionId);
  }

  // Notify MAIN about reconnection
  const shortId = resolvedTarget.slice(0, 8);
  ptyManager.enqueueNotification(resolvedSource, resolvedTarget, `SYSTEM: Peer "${asName}" reconnected (new session: ${shortId})`);

  // Inject sub context into new terminal
  const sourceName = ptyManager.getName(resolvedSource) || resolvedSource.slice(0, 8);
  const subContext = [
    `[tboard] SYSTEM NOTIFICATION -- This is an automated message from the terminal board, not user input.`,
    `Terminal link established with "${sourceName}" (reconnected as "${asName}").`,
    ``,
    `  COMPLETION PROTOCOL (mandatory):`,
    `    Every delegated task paste begins with an inline prefix on the first line:`,
    `      [tboard task_id=<id>] <task content...>`,
    `    When you finish the task you MUST run:`,
    `      tt task complete <task_id> --summary "one-line" --changed "f1,f2" --unresolved "none" [--report <file>]`,
    `    Use --changed none / --unresolved none when there are no items.`,
    `    Use --failed if the task could not be completed (still sets task state, so MAIN unblocks).`,
    `    If you did not capture the task_id, recover it with: tt task current`,
    ``,
    `  REPORTING (for substantial tasks — implementation, review, analysis, bug fix):`,
    `    Token discipline: MAIN reads your report, NOT your transcript. 3 layers:`,
    `      1. manifest (summary/changed/unresolved) — tiny. 2. report.md — exec summary (~2KB).`,
    `      3. bulk artifacts (full review/logs/diffs) → separate files in the task dir, referenced from report.md.`,
    `    Do NOT paste long output into the terminal — write it to a file.`,
    `    Each task gets its OWN output directory. Obtain the path with:`,
    `      tt task dir <task_id>           Prints the absolute path to this task's output dir`,
    `    Write your report file inside that directory:`,
    `      Implementation/bug fix → report.md (Summary, Changed Files, Key Decisions, Build Status, Open Issues)`,
    `      Code review            → review.md (Verdict: PASS/FAIL, Critical items, Warnings)`,
    `    Pass --report <filename> (BARE filename) to tt task complete; MAIN reads with \`tt task report <id>\`.`,
    `    Skip reports for simple tasks (confirmations, single-file fixes, questions).`,
    ``,
    `    Legacy peer-scoped dir (${reconOutputDir}) still exists but do NOT use it for task reports.`,
    ``,
    `  UI notifications (informational — do NOT close tasks):`,
    `    tt peer notify "<message>"     Delivers a UI bubble to MAIN. Does not change task state.`,
    `    A \`DONE:\` prefix is no longer parsed — run \`tt task complete <task_id>\` to close the task.`,
    ``,
    `  Other commands:`,
    `    tt peer send "message"       Send a message to the linked terminal`,
    `    tt peer notify "message"     Send a UI notification to the linked terminal`,
    ``
  ].join('\n');

  const submitDelay = 500;
  ptyManager.write(resolvedTarget, subContext);
  setTimeout(() => ptyManager.write(resolvedTarget, '\r'), submitDelay);

  res.json({ ok: true, name: asName, sessionId: resolvedTarget });
});

// Remove a link
app.delete('/api/links', (req, res) => {
  const { sourceId, targetId } = req.body || {};
  if (!sourceId || !targetId) {
    res.status(400).json({ error: 'sourceId and targetId are required' });
    return;
  }
  // Notify both terminals that the link has been removed
  const sourceName = ptyManager.getName(sourceId) || sourceId.slice(0, 8);
  const targetName = ptyManager.getName(targetId) || targetId.slice(0, 8);
  ptyManager.write(sourceId, `[tboard system] Link with "${targetName}" disconnected. Peer commands are no longer available.\r`);
  ptyManager.write(targetId, `[tboard system] Link with "${sourceName}" disconnected. Peer commands are no longer available.\r`);

  ptyManager.removeLink(sourceId, targetId);

  // Remember this pair briefly so an immediate re-link reads as a reconnection.
  const now = Date.now();
  for (const [k, t] of recentlyUnlinked) {
    if (now - t >= RECONNECT_WINDOW_MS) recentlyUnlinked.delete(k);
  }
  recentlyUnlinked.set(linkPairKey(sourceId, targetId), now);

  res.json({ ok: true });
});

// Get peers for a session
app.get('/api/links/peers/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const peers = ptyManager.getPeers(resolved);
  res.json({ peers, sessionId: resolved });
});

// Get all links (for client restore)
app.get('/api/links', (_req, res) => {
  const links = ptyManager.getAllLinks();
  res.json({ links });
});

// ── Task send (Phase 2a) ─────────────────────────────────────────────
// Primary dispatch path: task_id prefix only, no legacy IPC marker,
// no pendingTurn/ipcHistory side effects. Use this for every agent-to-agent
// task hand-off. `/api/ipc/send` below is now kept only for the deprecated
// `tt ipc` round-trip flow.
app.post('/api/tasks/send', (req, res) => {
  const { target, message, sourceSessionId } = req.body || {};
  if (!target || typeof message !== 'string') {
    res.status(400).json({ error: 'target and message (string) are required' });
    return;
  }
  const resolved = resolveSession(target);
  if (!resolved) {
    res.status(404).json({ error: `Target session not found: ${target}` });
    return;
  }

  if (sourceSessionId) {
    const resolvedSource = resolveSession(sourceSessionId);
    if (!resolvedSource || !ptyManager.arePeers(resolvedSource, resolved)) {
      res.status(403).json({ error: 'Not linked: task send requires a peer relationship' });
      return;
    }
  }

  // Reject before registering a task if the target is busy and its outbox is
  // full — otherwise registerTask would leave a ghost pending task that never
  // dispatches. (No await between here and dispatchToAgent, so this is exact.)
  if (ptyManager.dispatchWouldOverflow(resolved)) {
    res.status(429).json({ error: 'target is busy and its dispatch queue is full; retry later' });
    return;
  }

  let taskId: string | undefined;
  if (sourceSessionId && ptyManager.isMainToSub(sourceSessionId, resolved)) {
    taskId = ptyManager.registerTask(sourceSessionId, resolved, message);
  }

  // Paste carries ONLY the task_id prefix — no `[ipc:xxxx]` marker and no
  // IPC pending-turn bookkeeping. The SUB closes the task with
  // `tt task complete <task_id>`, and readers use task-scoped capture / report
  // rather than echo-grep on the rendered buffer.
  const taskPrefix = taskId ? `[tboard task_id=${taskId}] ` : '';
  const paste = `${taskPrefix}${message}`;
  try {
    const delivery = ptyManager.dispatchToAgent(resolved, paste, {
      retryNeedle: paste,
      kind: 'task',
      id: taskId,
      onResult: taskId ? (state) => ptyManager.setTaskDelivery(taskId, state) : undefined,
    });
    res.json({ ok: true, sessionId: resolved, message, taskId, delivery });
  } catch (err) {
    if (err instanceof DispatchOverflowError) {
      res.status(429).json({ error: 'target is busy and its dispatch queue is full; retry later' });
      return;
    }
    res.status(500).json({ error: String(err) });
  }
});

// ── IPC: Agent-to-agent communication (deprecated, kept for `tt ipc`) ─
// Only `tt ipc` / `tt peer ipc` should hit this endpoint now. It still
// appends the legacy marker and creates a pending turn so rendered-buffer
// echo matching works. It does NOT register a task — task dispatch goes
// through POST /api/tasks/send above.
app.post('/api/ipc/send', (req, res) => {
  const { target, message, sourceSessionId } = req.body || {};
  if (!target || typeof message !== 'string') {
    res.status(400).json({ error: 'target and message (string) are required' });
    return;
  }
  const resolved = resolveSession(target);
  if (!resolved) {
    res.status(404).json({ error: `Target session not found: ${target}` });
    return;
  }

  if (sourceSessionId) {
    const resolvedSource = resolveSession(sourceSessionId);
    if (!resolvedSource || !ptyManager.arePeers(resolvedSource, resolved)) {
      res.status(403).json({ error: 'Not linked: IPC send requires a peer relationship' });
      return;
    }
  }

  // Reject before creating a pending turn if the target's outbox is full, so we
  // don't leave a ghost pending turn that never dispatches.
  if (ptyManager.dispatchWouldOverflow(resolved)) {
    res.status(429).json({ error: 'target is busy and its dispatch queue is full; retry later' });
    return;
  }

  // Legacy IPC: create pending turn + marker so `/api/ipc/response` can
  // extract the response via echo-grep. No task registration here.
  const turnId = ptyManager.createPendingTurn(resolved, message, sourceSessionId || undefined);
  const marker = `[ipc:${turnId.slice(0, 8)}]`;
  const markedMessage = `${message} ${marker}`;
  try {
    const delivery = ptyManager.dispatchToAgent(resolved, markedMessage, {
      retryNeedle: markedMessage,
      kind: 'ipc',
      id: turnId,
    });
    res.json({ ok: true, sessionId: resolved, message, turnId, marker, delivery });
  } catch (err) {
    if (err instanceof DispatchOverflowError) {
      res.status(429).json({ error: 'target is busy and its dispatch queue is full; retry later' });
      return;
    }
    res.status(500).json({ error: String(err) });
  }
});

// Poll for IPC response — extracts rendered response by matching the sent message's echo
app.get('/api/ipc/response/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const message = req.query.message as string;
  const turnId = req.query.turnId as string;
  if (!message) {
    res.status(400).json({ error: 'message query param required (the sent message to match)' });
    return;
  }

  // Expire stale pending turns on each poll
  ptyManager.expireStaleTurns(resolved);

  // Check if this turn was timed out
  if (turnId) {
    const history = ptyManager.getIpcHistory(resolved);
    const turn = history.find(e => e.turnId === turnId);
    if (turn && turn.status === 'complete' && turn.response === '(timed out)') {
      res.json({
        output: '',
        isProcessing: false,
        timedOut: true,
        foregroundProcess: 'unknown',
      });
      return;
    }
  }

  // Reconstruct marker from turnId (must match format used in /api/ipc/send)
  const marker = turnId ? `[ipc:${turnId.slice(0, 8)}]` : undefined;
  const result = ptyManager.getIpcResponse(resolved, message, marker);
  if (!result) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Idempotently finalize the turn when processing is done and we have output,
  // or when the turn is complete with an empty response (prevents pendingIpcCount leaks)
  if (turnId) {
    if (!result.isProcessing && result.output) {
      ptyManager.finalizeTurn(resolved, turnId, result.output);
    } else if (ptyManager.isIpcTurnComplete(resolved, turnId)) {
      ptyManager.finalizeTurn(resolved, turnId, result.output || '');
    }
  }

  const status = ptyManager.getSessionStatus(resolved);
  res.json({
    output: result.output,
    isProcessing: result.isProcessing,
    foregroundProcess: status?.foregroundProcess ?? 'unknown',
  });
});

// Get the last agent response (most recent ❯ prompt → response)
app.get('/api/ipc/last/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const result = ptyManager.getLastResponse(resolved);
  if (!result) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const status = ptyManager.getSessionStatus(resolved);
  res.json({
    prompt: result.prompt,
    output: result.output,
    isProcessing: result.isProcessing,
    foregroundProcess: status?.foregroundProcess ?? 'unknown',
  });
});

// Get IPC conversation history for a session
app.get('/api/ipc/history/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const entries = ptyManager.getIpcHistory(resolved);
  res.json({ sessionId: resolved, entries });
});

// ── Notifications: fire-and-forget delivery with server-side queuing ──

// Send a notification (non-blocking, enqueued for delivery)
app.post('/api/notifications/send', (req, res) => {
  const { target, message, sourceSessionId } = req.body || {};
  if (!target || typeof message !== 'string') {
    res.status(400).json({ error: 'target and message (string) are required' });
    return;
  }
  const resolved = resolveSession(target);
  if (!resolved) {
    res.status(404).json({ error: `Target session not found: ${target}` });
    return;
  }

  // Enforce link relationship when source is specified
  if (sourceSessionId) {
    const resolvedSource = resolveSession(sourceSessionId);
    if (!resolvedSource || !ptyManager.arePeers(resolvedSource, resolved)) {
      res.status(403).json({ error: 'Not linked: notification requires a peer relationship' });
      return;
    }
  }

  const source = sourceSessionId || 'unknown';
  const notificationId = ptyManager.enqueueNotification(resolved, source, message);

  // Notifications are UI-only as of Phase 0. A legacy `DONE:` prefix no longer
  // closes tasks — the sender must call `POST /api/tasks/:taskId/complete` (or
  // `tt task complete <task_id>`) for task state to change. This closes two
  // holes that could not be fixed while keeping the notification shortcut:
  //   * auth bypass: notifications had no token check, so any local process
  //     could spoof sourceSessionId and close tasks via DONE:.
  //   * stale race: a late DONE: from a prior task could close the next task
  //     registered to the same SUB, because the legacy path has no task_id.

  res.json({ ok: true, notificationId, sessionId: resolved });
});

// Structured task completion — SUB calls this to close a specific task by ID.
// This is the primary completion path; `DONE:` notification parsing above is legacy.
app.post('/api/tasks/:taskId/complete', (req, res) => {
  const { taskId } = req.params;
  const { sourceSessionId, status, summary, reportFile, changed, unresolved, result } = req.body || {};

  const task = ptyManager.findTaskById(taskId);
  if (!task) {
    res.status(404).json({ error: `Task not found: ${taskId}` });
    return;
  }

  // Enforce auth: caller must prove session identity with the capability token
  // (X-Tboard-Token header) issued to that pty at creation. This binds the HTTP
  // call to a specific session rather than trusting a self-declared sourceSessionId.
  // Scope: within the declared threat model (processes inside tboard pty sessions
  // are trusted; same-user processes outside are NOT a hardened boundary since they
  // can read /proc/<pid>/environ). See token generation comment in pty-manager.ts.
  if (!sourceSessionId) {
    res.status(401).json({ error: 'sourceSessionId is required' });
    return;
  }
  const resolvedCaller = resolveSession(sourceSessionId);
  if (!resolvedCaller) {
    res.status(401).json({ error: 'Unknown sourceSessionId' });
    return;
  }
  const headerToken = req.headers['x-tboard-token'];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  if (!ptyManager.verifySessionToken(resolvedCaller, token)) {
    res.status(401).json({ error: 'Invalid or missing X-Tboard-Token for sourceSessionId' });
    return;
  }
  if (resolvedCaller !== task.targetSessionId && resolvedCaller !== task.sourceSessionId) {
    res.status(403).json({ error: 'Not authorized to complete this task' });
    return;
  }

  // If reportFile is provided, sanitize: basename only (no paths), reject traversal.
  // The file is resolved relative to the task output dir by the server, so the client
  // just passes a bare filename like "report.md".
  let validatedReport: string | undefined;
  if (typeof reportFile === 'string' && reportFile.length > 0) {
    if (reportFile.includes('/') || reportFile.includes('\\') || reportFile.includes('..')) {
      res.status(400).json({ error: 'reportFile must be a bare filename, no paths' });
      return;
    }
    validatedReport = reportFile;
  }

  const outcome = ptyManager.completeTaskById(taskId, {
    status: status === 'failed' ? 'failed' : 'done',
    summary: typeof summary === 'string' ? summary : undefined,
    reportFile: validatedReport,
    changed: Array.isArray(changed) ? changed.map(String) : undefined,
    unresolved: Array.isArray(unresolved) ? unresolved.map(String) : undefined,
    result: typeof result === 'string' ? result : undefined,
  });

  if (!outcome.ok) {
    res.status(409).json({ error: outcome.error });
    return;
  }
  res.json({ ok: true, task: outcome.task });
});

// ── Task-scoped artifact reads (Phase 1) ───────────────────────────
// These endpoints are keyed on task_id (not sessionId) so they can address
// a specific task's dir/manifest/report without LIFO heuristics.

// Task detail by task_id (single endpoint replacing bin/tt's session-scan).
app.get('/api/tasks/by-id/:taskId', (req, res) => {
  const task = ptyManager.findTaskById(req.params.taskId);
  if (!task) {
    res.status(404).json({ error: `Task not found: ${req.params.taskId}` });
    return;
  }
  res.json({ task, dir: ptyManager.getTaskOutputDir(task.taskId) });
});

// Path of the per-task output directory — SUB uses this to know where to write
// its report, and MAIN uses it to resolve report/manifest paths.
app.get('/api/tasks/by-id/:taskId/dir', (req, res) => {
  const dir = ptyManager.getTaskOutputDir(req.params.taskId);
  if (!dir) {
    res.status(404).json({ error: `Task not found or dir unresolvable: ${req.params.taskId}` });
    return;
  }
  res.json({ taskId: req.params.taskId, dir });
});

// Read manifest.json. Present only after `tt task complete`.
app.get('/api/tasks/by-id/:taskId/manifest', (req, res) => {
  const raw = ptyManager.readTaskManifest(req.params.taskId);
  if (raw === null) {
    res.status(404).json({ error: `No manifest for task: ${req.params.taskId}` });
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const task = ptyManager.findTaskById(req.params.taskId);
    recordRead('manifest', task?.targetSessionId ?? null, { text: raw, elided: false, omittedLines: 0, omittedBytes: 0 });
    res.json({ taskId: req.params.taskId, manifest: parsed });
  } catch {
    res.status(500).json({ error: 'Manifest exists but is not valid JSON' });
  }
});

// Read the report file declared on task.reportFile.
// Token efficiency (8.1): hard 10MB ceiling (checked via stat before read) plus
// read-time middle-elision (default 65536 bytes, maxBytes=0 disables). The file
// on disk is never modified.
app.get('/api/tasks/by-id/:taskId/report', (req, res) => {
  const stat = ptyManager.statTaskReport(req.params.taskId);
  if (stat && stat.size > REPORT_HARD_LIMIT_BYTES) {
    res.status(413).json({
      error: `Report too large (${stat.size} bytes, limit ${REPORT_HARD_LIMIT_BYTES}). Read it directly from disk.`,
      size: stat.size,
      limit: REPORT_HARD_LIMIT_BYTES,
      path: stat.path,
    });
    return;
  }
  const content = ptyManager.readTaskReport(req.params.taskId);
  if (content === null) {
    res.status(404).json({ error: `No report for task: ${req.params.taskId}` });
    return;
  }
  const task = ptyManager.findTaskById(req.params.taskId);
  const maxBytes = parseMaxBytes(req.query.maxBytes, REPORT_MAX_BYTES_DEFAULT);
  const el = elideMiddle(content, maxBytes);
  recordRead('report', task?.targetSessionId ?? null, el);
  res.json({ taskId: req.params.taskId, filename: task?.reportFile || null, content: el.text, elided: el.elided, omittedLines: el.omittedLines, omittedBytes: el.omittedBytes });
});

// List files in the task's output dir.
app.get('/api/tasks/by-id/:taskId/files', (req, res) => {
  const files = ptyManager.listTaskOutputFiles(req.params.taskId);
  if (files === null) {
    res.status(404).json({ error: `No output dir for task: ${req.params.taskId}` });
    return;
  }
  res.json({ taskId: req.params.taskId, files, dir: ptyManager.getTaskOutputDir(req.params.taskId) });
});

// Get notifications for a session (supports ?since=<seq> for unread-only)
app.get('/api/notifications/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const sinceParam = req.query.since as string | undefined;
  const sinceSeq = sinceParam !== undefined ? parseInt(sinceParam, 10) : undefined;
  const notifications = ptyManager.getNotifications(resolved, sinceSeq);
  const lastReadSeq = ptyManager.getLastReadSeq(resolved);
  const totalCount = ptyManager.getNotifications(resolved).length;
  res.json({ sessionId: resolved, notifications, lastReadSeq, totalCount });
});

// Long-poll for new notifications. Returns immediately when the queue has
// entries with seq > sinceSeq; otherwise holds the response until a new
// enqueue (via task complete or `tt notify`) wakes the waiter, or until the
// timeout fires. One-shot semantics — clients re-issue with a refreshed
// sinceSeq to keep listening. This is the primitive that MCP `_wait` and
// CLI `--wait` wrap (the same mechanism for every consumer).
//
// Threat model: this endpoint inherits the existing notification API's
// posture (no token check). The data exposed is limited to notifications
// already addressed to the session, so an unauthorized reader sees the same
// surface as `/api/notifications/:sessionId`. We additionally cap concurrent
// waiters per session (handled by the manager) so a misbehaving caller can't
// hold unbounded fds.
const NOTIFICATION_WAIT_DEFAULT_MS = 25_000;
const NOTIFICATION_WAIT_MAX_MS = 60_000;
app.get('/api/notifications/:sessionId/wait', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const sinceParam = req.query.sinceSeq as string | undefined;
  const sinceSeq = sinceParam !== undefined ? parseInt(sinceParam, 10) : 0;
  const timeoutParam = req.query.timeout as string | undefined;
  let timeoutMs = timeoutParam !== undefined ? parseInt(timeoutParam, 10) : NOTIFICATION_WAIT_DEFAULT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = NOTIFICATION_WAIT_DEFAULT_MS;
  if (timeoutMs > NOTIFICATION_WAIT_MAX_MS) timeoutMs = NOTIFICATION_WAIT_MAX_MS;

  const respondWith = (notifications: NotificationEntry[]) => {
    if (res.writableEnded) return;
    const lastReadSeq = ptyManager.getLastReadSeq(resolved);
    const totalCount = ptyManager.getNotifications(resolved).length;
    res.json({ sessionId: resolved, notifications, lastReadSeq, totalCount, timedOut: notifications.length === 0 });
  };

  // Critical ordering: register the waiter BEFORE checking the queue. If we
  // checked first and registered second, an enqueue landing in that gap
  // would wake nothing — the waiter wasn't registered yet — and the request
  // would block until full timeout despite items being available.
  let settled = false;
  let dispose: (() => void) | null = null;
  const finish = (notifications: NotificationEntry[]) => {
    if (settled) return;
    settled = true;
    if (dispose) { dispose(); dispose = null; }
    if (timer) { clearTimeout(timer); }
    respondWith(notifications);
  };
  const onWake = () => {
    const fresh = ptyManager.getNotifications(resolved, sinceSeq);
    if (fresh.length > 0) finish(fresh);
  };
  const timer = setTimeout(() => finish([]), timeoutMs);
  const reg = ptyManager.registerNotificationWaiter(resolved, onWake);
  if (reg.ok) {
    dispose = reg.dispose;
  } else {
    // Per-session waiter cap exceeded; degrade to the fast path so callers
    // still make progress instead of blocking unanchored.
    finish(ptyManager.getNotifications(resolved, sinceSeq));
    return;
  }

  // Now safe to drain anything already pending: the waiter is in place, so
  // an enqueue racing with this check will be caught by onWake's re-read.
  const initial = ptyManager.getNotifications(resolved, sinceSeq);
  if (initial.length > 0) {
    finish(initial);
    return;
  }

  req.on('close', () => {
    if (settled) return;
    settled = true;
    if (dispose) { dispose(); dispose = null; }
    clearTimeout(timer);
  });
});

// Mark notifications as read for a session
app.post('/api/notifications/:sessionId/read', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  ptyManager.markNotificationsRead(resolved);
  const lastReadSeq = ptyManager.getLastReadSeq(resolved);
  res.json({ ok: true, lastReadSeq });
});

// Clear notifications for a session
app.delete('/api/notifications/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  ptyManager.clearNotifications(resolved);
  res.json({ ok: true });
});

// Get delegated tasks for a session (where this session is MAIN)
app.get('/api/tasks/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const tasks = ptyManager.getTasks(resolved);

  // Enrich with live processing status for display. Terminal statuses (done, failed)
  // pass through unchanged; only `pending` can upgrade to `working` when the SUB PTY
  // is actively producing output.
  const enriched = tasks.map(t => {
    let displayStatus: string = t.status;
    if (t.status === 'pending') {
      const targetStatus = ptyManager.getSessionStatus(t.targetSessionId);
      if (targetStatus?.isProcessing) {
        displayStatus = 'working';
      }
    }
    return { ...t, displayStatus };
  });

  const summary = ptyManager.getTaskSummary(resolved);
  res.json({ sessionId: resolved, tasks: enriched, summary });
});

// Metadata of the latest task between MAIN (source) and SUB (target), without
// requiring a capture file. Used by `tt read --wait` (8.1) to decide whether to
// return the report-first view (manifest + report.md) before falling back to
// the raw capture. Returns 404 code=no-task when there is no task to anchor on.
app.get('/api/tasks/latest/:sourceSessionId/:targetSessionId', (req, res) => {
  const sourceResolved = resolveSession(req.params.sourceSessionId);
  const targetResolved = resolveSession(req.params.targetSessionId);
  if (!sourceResolved || !targetResolved) {
    res.status(404).json({ error: 'Session not found', code: 'session-not-found' });
    return;
  }
  const task = ptyManager.findLatestTask(sourceResolved, targetResolved);
  if (!task) {
    res.status(404).json({ error: 'No task found between these sessions', code: 'no-task' });
    return;
  }
  const hasManifest = ptyManager.readTaskManifest(task.taskId) !== null;
  const hasReport = ptyManager.statTaskReport(task.taskId) !== null;
  res.json({ task, hasManifest, hasReport });
});

// Read full task capture from disk (latest task between MAIN and SUB)
app.get('/api/captures/latest/:sourceSessionId/:targetSessionId', async (req, res) => {
  // 404 responses include a typed `code` so clients (notably bin/tt's
  // `--since-send` / `--full`) can distinguish "no task exists" (legitimate
  // fallback to rendered buffer) from "session resolution failed" or
  // "capture file missing" (real errors that must be surfaced).
  const sourceResolved = resolveSession(req.params.sourceSessionId);
  const targetResolved = resolveSession(req.params.targetSessionId);
  if (!sourceResolved || !targetResolved) {
    res.status(404).json({ error: 'Session not found', code: 'session-not-found' });
    return;
  }
  const clean = req.query.clean !== 'false';
  const maxBytes = parseMaxBytes(req.query.maxBytes, READ_MAX_BYTES_DEFAULT);

  const task = ptyManager.findLatestTask(sourceResolved, targetResolved);
  if (!task) {
    res.status(404).json({ error: 'No task found between these sessions', code: 'no-task' });
    return;
  }

  const result = await ptyManager.readCapture(task.taskId, clean, maxBytes);
  if (!result) {
    res.status(404).json({ error: 'Capture file not found', code: 'capture-missing' });
    return;
  }
  recordRead('capture', targetResolved, { text: result.output, elided: result.elided, omittedLines: result.omittedLines, omittedBytes: result.omittedBytes });
  res.json({ taskId: task.taskId, output: result.output, status: result.status, truncated: result.truncated, elided: result.elided, omittedLines: result.omittedLines, omittedBytes: result.omittedBytes, command: task.command });
});

// Get rendered terminal content (via headless xterm, no animation artifacts)
app.get('/api/terminals/:sessionId/rendered', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const lines = parseInt(req.query.lines as string) || 0;
  const clean = req.query.clean !== 'false';
  const sinceSend = req.query.sinceSend === 'true';
  const rawOutput = sinceSend
    ? ptyManager.getRenderedBufferSinceSend(resolved, clean)
    : ptyManager.getRenderedBuffer(resolved, lines || undefined, clean);
  if (rawOutput === null) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  // Token-efficiency (8.2): elide the middle of large reads. Read-time only;
  // the stored rendered buffer is untouched. Default 32KB, maxBytes=0 disables.
  const maxBytes = parseMaxBytes(req.query.maxBytes, READ_MAX_BYTES_DEFAULT);
  const el = elideMiddle(rawOutput, maxBytes);
  recordRead('rendered', resolved, el);
  const status = ptyManager.getSessionStatus(resolved);
  res.json({
    output: el.text,
    elided: el.elided,
    omittedLines: el.omittedLines,
    omittedBytes: el.omittedBytes,
    sessionId: resolved,
    isProcessing: status?.isProcessing ?? false,
    foregroundProcess: status?.foregroundProcess ?? 'unknown',
  });
});

// Read accounting (8.4): per-API and per-session byte/elision totals since the
// server started. In-memory, not persisted; resets on restart. Lets MAIN see
// where read tokens are going (and how much 8.2/8.3 saved) to decide what to
// tighten next. Not on the WS hot path — HTTP read APIs only.
app.get('/api/stats/reads', (_req, res) => {
  const totals: Record<string, ReadStats> = {};
  for (const [api, s] of readStatsTotals) totals[api] = { ...s };
  const sessions: Record<string, Record<string, ReadStats>> = {};
  for (const [sid, m] of readStatsSessions) {
    const byApi: Record<string, ReadStats> = {};
    for (const [api, s] of m) byApi[api] = { ...s };
    sessions[sid] = byApi;
  }
  res.json({ since: readStatsSince, totals, sessions });
});

// Case-insensitive substring search across every live session's rendered
// buffer. Capped at 20 matches per session and 200 overall.
app.get('/api/search', (req, res) => {
  const q = ((req.query.q as string) || '').trim();
  if (!q) {
    res.json({ results: [] });
    return;
  }
  const needle = q.toLowerCase();
  const results: { sessionId: string; name: string; lineText: string; lineIndex: number }[] = [];
  let total = 0;
  for (const st of ptyManager.getAllStatuses()) {
    if (total >= 200) break;
    const buffer = ptyManager.getRenderedBuffer(st.sessionId, undefined, true);
    if (!buffer) continue;
    const lines = buffer.split('\n');
    let perSession = 0;
    for (let i = 0; i < lines.length && perSession < 20 && total < 200; i++) {
      if (!lines[i].toLowerCase().includes(needle)) continue;
      results.push({
        sessionId: st.sessionId,
        name: st.name || st.cwdShort || st.sessionId,
        lineText: lines[i].trim().slice(0, 200),
        lineIndex: i,
      });
      perSession++;
      total++;
    }
  }
  res.json({ results });
});

// Kill a specific terminal (supports short ID / name resolution)
app.delete('/api/terminals/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (resolved) {
    ptyManager.kill(resolved);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// ── Peer output directory ────────────────────────────────────────────

// List files in a session's output directory
app.get('/api/output/:sessionId', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const files = ptyManager.listOutputFiles(resolved);
  if (files === null) {
    res.json({ files: [], outputDir: ptyManager.getOutputDir(resolved) || null });
    return;
  }
  res.json({ files, outputDir: ptyManager.getOutputDir(resolved) });
});

// Read a file from a session's output directory
app.get('/api/output/:sessionId/:filename', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const content = ptyManager.readOutputFile(resolved, req.params.filename);
  if (content === null) {
    res.status(404).json({ error: 'File not found or access denied' });
    return;
  }
  res.json({ content, filename: req.params.filename });
});

// ── Files: Directory listing & file reading ───────────────────────────

// Overwrite an existing text file
app.post('/api/files/write', (req, res) => {
  const { path: filePath, content, expectedMtimeMs, force } = req.body || {};
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content must be strings' });
    return;
  }
  try {
    const resolved = assertAllowedPath(filePath);
    const st = statSync(resolved);
    if (st.isDirectory()) {
      res.status(400).json({ error: 'Cannot write to a directory' });
      return;
    }

    // Optimistic concurrency: if the caller tells us the mtime it last saw and
    // the file changed on disk since (e.g. an agent edited it), reject unless
    // the caller explicitly forces the overwrite.
    if (!force && typeof expectedMtimeMs === 'number' && st.mtimeMs !== expectedMtimeMs) {
      res.status(409).json({ error: 'conflict', currentMtimeMs: st.mtimeMs });
      return;
    }

    writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, ...getFileInfo(resolved) });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Lightweight stat endpoint for the editor's external-change polling.
app.get('/api/files/stat', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  try {
    const resolved = assertAllowedPath(filePath);
    if (!existsSync(resolved)) {
      res.json({ exists: false, mtimeMs: 0, size: 0 });
      return;
    }
    const st = statSync(resolved);
    res.json({ exists: true, mtimeMs: st.mtimeMs, size: st.size });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Probe whether a remote URL permits being framed (X-Frame-Options /
// CSP frame-ancestors). Used by the browser window to warn before embedding a
// page that will render blank. SSRF guard: http/https only.
app.get('/api/probe-frame', async (req, res) => {
  const url = req.query.url as string;
  if (!url) {
    res.status(400).json({ error: 'url query param required' });
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: 'invalid url' });
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'only http/https allowed' });
    return;
  }

  const frameableFromHeaders = (headers: Headers): boolean => {
    const xfo = (headers.get('x-frame-options') || '').toLowerCase();
    if (xfo.includes('deny') || xfo.includes('sameorigin')) return false;
    const csp = headers.get('content-security-policy') || '';
    const m = csp.match(/frame-ancestors([^;]*)/i);
    if (m) {
      const directive = m[1].toLowerCase();
      if (directive.includes("'none'")) return false;
      // Anything other than a wildcard is an allowlist we are unlikely to be on.
      if (!directive.includes('*')) return false;
    }
    return true;
  };

  const probe = async (method: 'HEAD' | 'GET') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await fetch(parsed.href, { method, redirect: 'follow', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    let response: Response;
    try {
      response = await probe('HEAD');
    } catch {
      response = await probe('GET');
    }
    res.json({ frameable: frameableFromHeaders(response.headers), status: response.status });
  } catch {
    res.json({ frameable: false, status: 0 });
  }
});

// Move a file or directory into another directory
app.post('/api/files/move', (req, res) => {
  const { sourcePath, targetDir } = req.body || {};
  if (typeof sourcePath !== 'string' || typeof targetDir !== 'string') {
    res.status(400).json({ error: 'sourcePath and targetDir must be strings' });
    return;
  }
  try {
    const resolvedSource = assertAllowedPath(sourcePath);
    const resolvedTargetDir = assertAllowedPath(targetDir);
    const sourceStat = statSync(resolvedSource);
    const targetStat = statSync(resolvedTargetDir);
    if (!targetStat.isDirectory()) {
      res.status(400).json({ error: 'Target must be a directory' });
      return;
    }

    const destinationPath = join(resolvedTargetDir, basename(resolvedSource));
    if (destinationPath === resolvedSource) {
      res.status(400).json({ error: 'Source is already in that directory' });
      return;
    }
    if (sourceStat.isDirectory() && isDescendantPath(resolvedSource, resolvedTargetDir)) {
      res.status(400).json({ error: 'Cannot move a directory into itself' });
      return;
    }
    if (existsSync(destinationPath)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }

    renameSync(resolvedSource, destinationPath);
    res.json({ ok: true, path: destinationPath, name: basename(destinationPath) });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Upload a file into a directory for explorer drag-and-drop
app.post('/api/files/upload', (req, res) => {
  const { filename, data, targetDir } = req.body || {};
  if (typeof filename !== 'string' || typeof data !== 'string' || typeof targetDir !== 'string') {
    res.status(400).json({ error: 'filename, data, targetDir required' });
    return;
  }
  try {
    const resolvedTargetDir = assertAllowedPath(targetDir);
    const st = statSync(resolvedTargetDir);
    if (!st.isDirectory()) {
      res.status(400).json({ error: 'targetDir must be a directory' });
      return;
    }

    const sanitized = filename.replace(/[/\\]/g, '_');
    const destinationPath = join(resolvedTargetDir, sanitized);
    assertAllowedPath(destinationPath);
    if (existsSync(destinationPath)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }

    const buf = Buffer.from(data, 'base64');
    writeFileSync(destinationPath, buf);
    res.json({ ok: true, ...getFileInfo(destinationPath) });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Create a new directory.
app.post('/api/files/mkdir', (req, res) => {
  const { path: dirPath } = req.body || {};
  if (typeof dirPath !== 'string') {
    res.status(400).json({ error: 'path must be a string' });
    return;
  }
  try {
    const resolved = assertAllowedPath(dirPath);
    if (existsSync(resolved)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }
    mkdirSync(resolved);
    res.json({ ok: true, path: resolved, name: basename(resolved) });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Create a new empty file (fails if it already exists).
app.post('/api/files/create', (req, res) => {
  const { path: filePath } = req.body || {};
  if (typeof filePath !== 'string') {
    res.status(400).json({ error: 'path must be a string' });
    return;
  }
  try {
    const resolved = assertAllowedPath(filePath);
    if (existsSync(resolved)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }
    writeFileSync(resolved, '', { flag: 'wx' });
    res.json({ ok: true, ...getFileInfo(resolved) });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Rename a file or directory in place (new basename in the same parent).
app.post('/api/files/rename', (req, res) => {
  const { path: targetPath, newName } = req.body || {};
  if (typeof targetPath !== 'string' || typeof newName !== 'string' || !newName.trim()) {
    res.status(400).json({ error: 'path and newName required' });
    return;
  }
  if (/[/\\]/.test(newName)) {
    res.status(400).json({ error: 'newName must not contain path separators' });
    return;
  }
  try {
    const resolved = assertAllowedPath(targetPath);
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const destination = join(dirname(resolved), newName);
    assertAllowedPath(destination);
    if (existsSync(destination)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }
    renameSync(resolved, destination);
    res.json({ ok: true, path: destination, name: basename(destination) });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Delete a file or (with recursive:true) a directory.
app.post('/api/files/delete', (req, res) => {
  const { path: targetPath, recursive } = req.body || {};
  if (typeof targetPath !== 'string') {
    res.status(400).json({ error: 'path must be a string' });
    return;
  }
  try {
    const resolved = assertAllowedPath(targetPath);
    if (!existsSync(resolved)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (statSync(resolved).isDirectory() && recursive !== true) {
      res.status(400).json({ error: 'Directory delete requires recursive: true' });
      return;
    }
    rmSync(resolved, { recursive: recursive === true, force: false });
    res.json({ ok: true, path: resolved });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Build the listing payload for a directory. includeHidden controls whether
// dotfiles are returned; otherwise identical for both list endpoints.
function listDirectoryPayload(dirPath: string, includeHidden: boolean) {
  const resolved = assertAllowedPath(dirPath);
  const entries = readdirSync(resolved, { withFileTypes: true });
  const files = entries
    .filter((e) => includeHidden || !e.name.startsWith('.'))
    .map((e) => {
      const fullPath = join(resolved, e.name);
      let size = 0;
      let modified = '';
      try {
        const st = statSync(fullPath);
        size = st.size;
        modified = st.mtime.toISOString();
      } catch { /* permission denied */ }
      return {
        name: e.name,
        path: fullPath,
        isDirectory: e.isDirectory(),
        size,
        modified,
        extension: e.isDirectory() ? '' : extname(e.name).slice(1),
      };
    })
    .sort((a, b) => {
      // directories first, then alphabetical
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { path: resolved, files };
}

// List directory contents (dotfiles hidden by default)
app.get('/api/files', (req, res) => {
  const dirPath = (req.query.path as string) || process.env.HOME || '/';
  try {
    res.json(listDirectoryPayload(dirPath, false));
  } catch (err) {
    sendFileError(res, err);
  }
});

// List directory including hidden files
app.get('/api/files/all', (req, res) => {
  const dirPath = (req.query.path as string) || process.env.HOME || '/';
  try {
    res.json(listDirectoryPayload(dirPath, true));
  } catch (err) {
    sendFileError(res, err);
  }
});

// MIME types for binary serving
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon',
};

// Read file contents (JSON for text, raw binary for images when mode=raw)
app.get('/api/files/read', (req, res) => {
  const filePath = req.query.path as string;
  const mode = req.query.mode as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  try {
    const resolved = assertAllowedPath(filePath);
    const st = statSync(resolved);
    const ext = extname(resolved).slice(1).toLowerCase();

    // Raw mode: serve binary with correct MIME type (for images)
    if (mode === 'raw') {
      if (st.size > 10 * 1024 * 1024) {
        res.status(413).json({ error: 'File too large (max 10MB)' });
        return;
      }
      const mime = IMAGE_MIME[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.send(readFileSync(resolved));
      return;
    }

    // Text mode: JSON response
    if (st.size > 2 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 2MB)' });
      return;
    }
    const content = readFileSync(resolved, 'utf-8');
    res.json({
      path: resolved,
      name: basename(resolved),
      content,
      extension: ext,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  } catch (err) {
    sendFileError(res, err);
  }
});

// Serve raw file (for images, binary files)
app.get('/api/files/raw', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  try {
    const resolved = assertAllowedPath(filePath);
    const st = statSync(resolved);
    if (st.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 10MB)' });
      return;
    }
    const ext = extname(resolved).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.send(readFileSync(resolved));
  } catch (err) {
    sendFileError(res, err);
  }
});

app.get('/api/files/download', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  try {
    const resolved = assertAllowedPath(filePath);
    const st = statSync(resolved);
    if (st.isDirectory()) {
      res.status(400).json({ error: 'Cannot download a directory' });
      return;
    }
    res.download(resolved, basename(resolved));
  } catch (err) {
    sendFileError(res, err);
  }
});

// Serve static files in production
const clientDist = resolve(__dirname, '../client');
if (existsSync(resolve(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(resolve(clientDist, 'index.html'));
  });
}

// WebSocket upgrade handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const token = url.searchParams.get('token');

  // Origin check
  const origin = req.headers.origin;
  if (origin && !origin.match(/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/)) {
    ws.close(4003, 'Invalid origin');
    return;
  }

  // Token check: accept the server token or any live session's capability token.
  if (!token || !(token === serverToken || ptyManager.isValidSessionToken(token))) {
    ws.close(4001, 'Invalid token');
    return;
  }

  // Session check
  if (!sessionId || !ptyManager.has(sessionId)) {
    ws.close(4004, 'Session not found');
    return;
  }

  try {
    ptyManager.attach(sessionId, ws);
  } catch (err) {
    ws.close(4000, String(err));
  }
});

// Unix socket server for CLI (sandbox-safe IPC)
const cliServer = createServer(app);
// Clean up stale socket file from previous run
try { unlinkSync(SOCKET_PATH); } catch {}
cliServer.listen(SOCKET_PATH, () => {
  console.log(`CLI socket listening on ${SOCKET_PATH}`);
});

// Cleanup
const cleanup = () => {
  console.log('Shutting down, killing all PTY sessions...');
  ptyManager.killAll();
  server.close();
  cliServer.close();
  try { unlinkSync(SOCKET_PATH); } catch {}
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => {
  ptyManager.killAll();
  try { unlinkSync(SOCKET_PATH); } catch {}
});

ptyManager.initCaptures();
ptyManager.sweepOldOutputDirs();
ptyManager.startStaleTurnSweep();

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nERROR: port ${PORT} is already in use, so the terminal backend cannot start.\n` +
      `The UI may still load, but opening terminals will fail.\n` +
      `Free the port (e.g. \`lsof -nP -iTCP:${PORT} -sTCP:LISTEN\` then kill the PID) and retry.\n`
    );
  } else {
    console.error('Server failed to start:', err);
  }
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Terminal Board server listening on http://127.0.0.1:${PORT}`);
});
