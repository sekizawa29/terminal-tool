import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync } from 'fs';
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
  const { cols = 80, rows = 24, cwd } = req.body || {};
  const sessionId = ptyManager.create(cols, rows, cwd);
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

// Serve static files in production
const clientDist = resolve(__dirname, '../client');
if (existsSync(clientDist)) {
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

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Terminal Board server listening on http://127.0.0.1:${PORT}`);
});
