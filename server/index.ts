import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { resolve, dirname, join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, readdirSync, readFileSync, statSync, renameSync } from 'fs';
import { PtyManager } from './pty-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001', 10);

const app = express();
app.use(express.json({ limit: '50mb' }));

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Resolve bin directory for tt CLI
const binDir = resolve(__dirname, '../bin');
const binDirResolved = existsSync(binDir) ? binDir : resolve(__dirname, '../../bin');

const ptyManager = new PtyManager(PORT, binDirResolved);

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
    extension: extname(filePath).slice(1).toLowerCase(),
  };
}

function isDescendantPath(parentPath: string, childPath: string): boolean {
  const normalizedParent = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
  return childPath === parentPath || childPath.startsWith(normalizedParent);
}

// Auth token store (simple in-memory)
const validTokens = new Set<string>();

// Token endpoint
app.get('/api/token', (_req, res) => {
  const token = randomBytes(32).toString('hex');
  validTokens.add(token);
  res.json({ token });
});

// Create terminal
app.post('/api/terminals', (req, res) => {
  const { cols = 80, rows = 24, cwd, shell } = req.body || {};
  const sessionId = ptyManager.create(cols, rows, cwd, shell);
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
  const { data } = req.body || {};
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
  ptyManager.setName(resolved, name);
  res.json({ ok: true, sessionId: resolved, name });
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
    const filePath = join(cwd, sanitized);
    const buf = Buffer.from(data, 'base64');
    writeFileSync(filePath, buf);
    res.json({ path: filePath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Links: Peer routing registry ─────────────────────────────────────

// Register a link (bidirectional)
app.post('/api/links', (req, res) => {
  const { sourceId, targetId } = req.body || {};
  if (!sourceId || !targetId) {
    res.status(400).json({ error: 'sourceId and targetId are required' });
    return;
  }
  ptyManager.addLink(sourceId, targetId);

  // Inject agent collaboration context into both terminals
  const sourceName = ptyManager.getName(sourceId) || sourceId.slice(0, 8);
  const targetName = ptyManager.getName(targetId) || targetId.slice(0, 8);

  const mainContext = [
    `[tboard] You are now the MAIN agent, linked to sub-agent "${targetName}".`,
    `  - Send instructions:     tt peer ipc "your message"`,
    `  - For long tasks:        tt peer send "task" then tt peer last --wait`,
    `  - Sub will notify you with "DONE: ..." when finished.`,
    `  - After notification, run tt peer last to check what sub actually did.`,
    ``
  ].join('\n');

  const subContext = [
    `[tboard] Terminal link established with "${sourceName}".`,
    `  Available commands:`,
    `  - tt peer ipc "message"       Send a message to the linked terminal`,
    `  - tt peer last --wait         Wait for response from linked terminal`,
    `  - When you finish a task, report back: tt peer ipc "DONE: [summary + changed files]"`,
    ``
  ].join('\n');

  ptyManager.write(sourceId, mainContext + '\r');
  ptyManager.write(targetId, subContext + '\r');

  res.json({ ok: true });
});

// Remove a link
app.delete('/api/links', (req, res) => {
  const { sourceId, targetId } = req.body || {};
  if (!sourceId || !targetId) {
    res.status(400).json({ error: 'sourceId and targetId are required' });
    return;
  }
  ptyManager.removeLink(sourceId, targetId);
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

// ── IPC: Agent-to-agent communication ────────────────────────────────

// Send a message to another terminal's PTY (auto-appends CR for Enter)
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

  // Create pending history turn
  const turnId = ptyManager.createPendingTurn(resolved, message, sourceSessionId || undefined);

  // Wrap in bracketed paste to prevent multi-line messages from being split,
  // then send CR after a delay to submit
  ptyManager.write(resolved, `\x1b[200~${message}\x1b[201~`);
  setTimeout(() => ptyManager.write(resolved, '\r'), 150);

  res.json({ ok: true, sessionId: resolved, message, turnId });
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

  const result = ptyManager.getIpcResponse(resolved, message);
  if (!result) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  // Idempotently finalize the turn when processing is done and we have output
  if (turnId && !result.isProcessing && result.output) {
    ptyManager.finalizeTurn(resolved, turnId, result.output);
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

// Get rendered terminal content (via headless xterm, no animation artifacts)
app.get('/api/terminals/:sessionId/rendered', (req, res) => {
  const resolved = resolveSession(req.params.sessionId);
  if (!resolved) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const lines = parseInt(req.query.lines as string) || 0;
  const clean = req.query.clean !== 'false';
  const output = ptyManager.getRenderedBuffer(resolved, lines || undefined, clean);
  if (output === null) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const status = ptyManager.getSessionStatus(resolved);
  res.json({
    output,
    sessionId: resolved,
    isProcessing: status?.isProcessing ?? false,
    foregroundProcess: status?.foregroundProcess ?? 'unknown',
  });
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

// ── Files: Directory listing & file reading ───────────────────────────

// Overwrite an existing text file
app.post('/api/files/write', (req, res) => {
  const { path: filePath, content } = req.body || {};
  if (typeof filePath !== 'string' || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content must be strings' });
    return;
  }
  try {
    const resolved = resolve(filePath);
    const st = statSync(resolved);
    if (st.isDirectory()) {
      res.status(400).json({ error: 'Cannot write to a directory' });
      return;
    }

    writeFileSync(resolved, content, 'utf-8');
    res.json({ ok: true, ...getFileInfo(resolved) });
  } catch (err) {
    res.status(400).json({ error: String(err) });
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
    const resolvedSource = resolve(sourcePath);
    const resolvedTargetDir = resolve(targetDir);
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
    res.status(400).json({ error: String(err) });
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
    const resolvedTargetDir = resolve(targetDir);
    const st = statSync(resolvedTargetDir);
    if (!st.isDirectory()) {
      res.status(400).json({ error: 'targetDir must be a directory' });
      return;
    }

    const sanitized = filename.replace(/[/\\]/g, '_');
    const destinationPath = join(resolvedTargetDir, sanitized);
    if (existsSync(destinationPath)) {
      res.status(409).json({ error: 'Target already exists' });
      return;
    }

    const buf = Buffer.from(data, 'base64');
    writeFileSync(destinationPath, buf);
    res.json({ ok: true, ...getFileInfo(destinationPath) });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// List directory contents
app.get('/api/files', (req, res) => {
  const dirPath = (req.query.path as string) || process.env.HOME || '/';
  try {
    const resolved = resolve(dirPath);
    const entries = readdirSync(resolved, { withFileTypes: true });
    const files = entries
      .filter((e) => !e.name.startsWith('.')) // hide dotfiles by default
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
    res.json({ path: resolved, files });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// List directory including hidden files
app.get('/api/files/all', (req, res) => {
  const dirPath = (req.query.path as string) || process.env.HOME || '/';
  try {
    const resolved = resolve(dirPath);
    const entries = readdirSync(resolved, { withFileTypes: true });
    const files = entries
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
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({ path: resolved, files });
  } catch (err) {
    res.status(400).json({ error: String(err) });
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
    const resolved = resolve(filePath);
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
    });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

// Serve raw file (for images, binary files)
const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

app.get('/api/files/raw', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  try {
    const resolved = resolve(filePath);
    const st = statSync(resolved);
    if (st.size > 10 * 1024 * 1024) {
      res.status(413).json({ error: 'File too large (max 10MB)' });
      return;
    }
    const ext = extname(resolved).slice(1).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.send(readFileSync(resolved));
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.get('/api/files/download', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path query param required' });
    return;
  }
  try {
    const resolved = resolve(filePath);
    const st = statSync(resolved);
    if (st.isDirectory()) {
      res.status(400).json({ error: 'Cannot download a directory' });
      return;
    }
    res.download(resolved, basename(resolved));
  } catch (err) {
    res.status(400).json({ error: String(err) });
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

  // Token check
  if (!token || !validTokens.has(token)) {
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

// Cleanup
const cleanup = () => {
  console.log('Shutting down, killing all PTY sessions...');
  ptyManager.killAll();
  server.close();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', () => ptyManager.killAll());

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal Board server listening on http://127.0.0.1:${PORT}`);
});
