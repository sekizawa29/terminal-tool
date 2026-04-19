import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { resolve, dirname, join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, writeFileSync, readdirSync, readFileSync, statSync, renameSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { PtyManager, type NotificationEntry } from './pty-manager.js';

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

  // Ensure output directory for the sub-agent
  const outputDir = ptyManager.ensureOutputDir(sourceId, targetId);

  // Inject agent collaboration context into both terminals
  const sourceName = ptyManager.getName(sourceId) || sourceId.slice(0, 8);
  const targetName = ptyManager.getName(targetId) || targetId.slice(0, 8);

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

  res.json({ ok: true });
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
  ptyManager.pasteAndSubmit(resolved, paste, { retryNeedle: paste });

  res.json({ ok: true, sessionId: resolved, message, taskId });
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

  // Legacy IPC: create pending turn + marker so `/api/ipc/response` can
  // extract the response via echo-grep. No task registration here.
  const turnId = ptyManager.createPendingTurn(resolved, message, sourceSessionId || undefined);
  const marker = `[ipc:${turnId.slice(0, 8)}]`;
  const markedMessage = `${message} ${marker}`;
  ptyManager.pasteAndSubmit(resolved, markedMessage, { retryNeedle: markedMessage });

  res.json({ ok: true, sessionId: resolved, message, turnId, marker });
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
    res.json({ taskId: req.params.taskId, manifest: JSON.parse(raw) });
  } catch {
    res.status(500).json({ error: 'Manifest exists but is not valid JSON' });
  }
});

// Read the report file declared on task.reportFile.
app.get('/api/tasks/by-id/:taskId/report', (req, res) => {
  const content = ptyManager.readTaskReport(req.params.taskId);
  if (content === null) {
    res.status(404).json({ error: `No report for task: ${req.params.taskId}` });
    return;
  }
  const task = ptyManager.findTaskById(req.params.taskId);
  res.json({ taskId: req.params.taskId, filename: task?.reportFile || null, content });
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

  const task = ptyManager.findLatestTask(sourceResolved, targetResolved);
  if (!task) {
    res.status(404).json({ error: 'No task found between these sessions', code: 'no-task' });
    return;
  }

  const result = await ptyManager.readCapture(task.taskId, clean);
  if (!result) {
    res.status(404).json({ error: 'Capture file not found', code: 'capture-missing' });
    return;
  }
  res.json({ taskId: task.taskId, output: result.output, status: result.status, truncated: result.truncated, command: task.command });
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
  const output = sinceSend
    ? ptyManager.getRenderedBufferSinceSend(resolved, clean)
    : ptyManager.getRenderedBuffer(resolved, lines || undefined, clean);
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Terminal Board server listening on http://127.0.0.1:${PORT}`);
});
