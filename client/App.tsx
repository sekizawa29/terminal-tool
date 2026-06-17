import { useCallback, useEffect, useRef, useState } from 'react';
import Canvas from './components/Canvas.js';
import Sidebar from './components/Sidebar.js';
import ExplorerContent from './components/ExplorerContent.js';
import EdgeBadges from './components/EdgeBadges.js';
import { useCanvas } from './hooks/useCanvas.js';
import { useTerminalStore } from './hooks/useTerminalStore.js';
import { useSettings } from './hooks/useSettings.js';
import { useSessionPolling } from './hooks/useSessionPolling.js';
import { apiFetch, setApiToken } from './api.js';
import type { TerminalWindow } from './types.js';

let terminalCounter = 0;

async function fetchToken(): Promise<string> {
  // no-store: the server regenerates its token on every restart, so a cached
  // /api/token (e.g. an app-mode window reopened against a restarted backend)
  // would return a stale token and every subsequent /api + /ws call would 401.
  const res = await fetch('/api/token', { cache: 'no-store' });
  const data = await res.json();
  return data.token;
}

async function createTerminalSession(
  cols = 80, rows = 24, cwd?: string, shell?: string, initialCommand?: string
): Promise<string> {
  const res = await apiFetch('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows, cwd, shell, initialCommand }),
  });
  const data = await res.json();
  return data.sessionId;
}

async function fetchActiveSessions(): Promise<string[]> {
  const res = await apiFetch('/api/terminals');
  const data = await res.json();
  return data.sessions;
}

const PANEL_WIDTH = 320;
const TOOLBAR_BOTTOM = 14 + 44; // top + (42 row + 1+1 borders)
const PANEL_GAP = 16;
const SESSION_ROW = 36;
const SESSION_LIST_PAD = 9;
const SESSION_LIST_MAX = 248 + SESSION_LIST_PAD;

export default function App() {
  const canvas = useCanvas();
  // Poll session status once for the whole app (statuses + recent dirs land in
  // the store); mounting it here keeps it alive regardless of the sidebar.
  useSessionPolling(canvas);
  // Individual selectors (stable action refs) instead of subscribing to the
  // whole store, so App + Sidebar don't re-render on every drag / 2s poll.
  const setToken = useTerminalStore((s) => s.setToken);
  const addTerminal = useTerminalStore((s) => s.addTerminal);
  const loadLayout = useTerminalStore((s) => s.loadLayout);
  const token = useTerminalStore((s) => s.token);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerRoot, setExplorerRoot] = useState('~');
  const [sessionsExpanded, setSessionsExpanded] = useState(false);
  const terminalCount = useTerminalStore((s) => s.terminals.size);
  const attentionCount = useTerminalStore((s) => s.attention.size);
  const sessionListHeight = Math.min(terminalCount * SESSION_ROW + SESSION_LIST_PAD, SESSION_LIST_MAX);
  const explorerTop = TOOLBAR_BOTTOM + (sessionsExpanded ? sessionListHeight : 0) + PANEL_GAP;

  // Reflect total offscreen-attention count in the tab title.
  useEffect(() => {
    const base = 'tboard';
    document.title = attentionCount > 0 ? `(${attentionCount}) ${base}` : base;
  }, [attentionCount]);

  // Fetch token on mount (with StrictMode guard)
  useEffect(() => {
    let cancelled = false;
    fetchToken().then((t) => {
      if (!cancelled) {
        setApiToken(t);
        setToken(t);
      }
    });
    return () => { cancelled = true; };
  }, [setToken]);

  const addNewTerminal = useCallback(async () => {
    if (!token) return;

    const sessionId = await createTerminalSession();
    const { offsetX, offsetY, scale } = canvas.getTransform();

    // Place at viewport center
    const centerX = (window.innerWidth / 2 - offsetX) / scale;
    const centerY = (window.innerHeight / 2 - offsetY) / scale;

    const width = 700;
    const height = 450;

    terminalCounter++;
    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId,
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      zIndex: 0,
      title: `Terminal ${terminalCounter}`,
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [token, canvas, addTerminal]);

  const duplicateTerminal = useCallback(async (cwd: string, nearX: number, nearY: number) => {
    if (!token) return;

    const sessionId = await createTerminalSession(80, 24, cwd);
    const width = 700;
    const height = 450;

    terminalCounter++;
    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId,
      x: nearX,
      y: nearY,
      width,
      height,
      zIndex: 0,
      title: `Terminal ${terminalCounter}`,
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [token, addTerminal]);

  const claudeTerminal = useCallback(async (cwd: string, nearX: number, nearY: number) => {
    if (!token) return;

    // The server injects `claude` once the shell is at an idle prompt (7.4),
    // which is robust to slow shell init instead of a fixed client-side delay.
    const sessionId = await createTerminalSession(80, 24, cwd || undefined, undefined, 'claude');
    const width = 700;
    const height = 450;

    terminalCounter++;
    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId,
      x: nearX,
      y: nearY,
      width,
      height,
      zIndex: 0,
      title: `Terminal ${terminalCounter}`,
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [token, addTerminal]);

  const codexTerminal = useCallback(async (cwd: string, nearX: number, nearY: number) => {
    if (!token) return;

    // Server-side prompt-aware injection (7.4), as with claudeTerminal.
    const sessionId = await createTerminalSession(80, 24, cwd || undefined, undefined, 'codex');
    const width = 700;
    const height = 450;

    terminalCounter++;
    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId,
      x: nearX,
      y: nearY,
      width,
      height,
      zIndex: 0,
      title: `Terminal ${terminalCounter}`,
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [token, addTerminal]);

  const powershellTerminal = useCallback(async (nearX: number, nearY: number) => {
    if (!token) return;

    const sessionId = await createTerminalSession(80, 24, undefined, 'powershell.exe');
    const width = 700;
    const height = 450;

    terminalCounter++;
    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId,
      x: nearX,
      y: nearY,
      width,
      height,
      zIndex: 0,
      title: `PowerShell ${terminalCounter}`,
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [token, addTerminal]);

  // Spawn a terminal/claude/codex rooted at cwd at a given world position.
  const spawnAt = useCallback(
    (kind: 'terminal' | 'claude' | 'codex', cwd: string, nearX: number, nearY: number) => {
      if (kind === 'claude') claudeTerminal(cwd, nearX, nearY);
      else if (kind === 'codex') codexTerminal(cwd, nearX, nearY);
      else duplicateTerminal(cwd, nearX, nearY);
    },
    [claudeTerminal, codexTerminal, duplicateTerminal]
  );

  // From the fixed explorer panel (no host window): drop the new window near the
  // current viewport center in world space.
  const spawnHereCentered = useCallback(
    (kind: 'terminal' | 'claude' | 'codex', cwd: string) => {
      const t = canvas.getTransform();
      const nx = (window.innerWidth / 2 - t.offsetX) / t.scale - 350;
      const ny = (window.innerHeight / 2 - t.offsetY) / t.scale - 225;
      spawnAt(kind, cwd, nx, ny);
    },
    [canvas, spawnAt]
  );

  const toggleExplorer = useCallback(() => {
    setExplorerOpen((prev) => !prev);
  }, []);

  const addMemoPanel = useCallback(() => {
    const { offsetX, offsetY, scale } = canvas.getTransform();
    const centerX = (window.innerWidth / 2 - offsetX) / scale;
    const centerY = (window.innerHeight / 2 - offsetY) / scale;

    const width = 320;
    const height = 220;

    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      // Stable pseudo-id used as the memo's server-side key (survives reloads).
      sessionId: `memo-${crypto.randomUUID()}`,
      type: 'memo',
      memoText: '',
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      zIndex: 0,
      title: 'Memo',
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [canvas, addTerminal]);

  const addBrowserPanel = useCallback(() => {
    const { offsetX, offsetY, scale } = canvas.getTransform();
    const centerX = (window.innerWidth / 2 - offsetX) / scale;
    const centerY = (window.innerHeight / 2 - offsetY) / scale;
    const width = 760;
    const height = 520;
    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId: '',
      type: 'browser',
      url: 'http://localhost:3000',
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      zIndex: 0,
      title: 'Browser',
    };
    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [canvas, addTerminal]);

  const openFileEditor = useCallback((filePath: string, fileName: string, nearX?: number, nearY?: number) => {
    // Check if this file is already open
    const existing = Array.from(useTerminalStore.getState().terminals.values()).find(
      (t) => t.type === 'editor' && t.filePath === filePath
    );
    if (existing) {
      useTerminalStore.getState().bringToFront(existing.id);
      useTerminalStore.getState().setActive(existing.id);
      canvas.focusOn(existing.x, existing.y, existing.width, existing.height);
      return;
    }

    const width = 650;
    const height = 500;

    // Place at viewport center if no position given (e.g. from fixed explorer)
    const { offsetX, offsetY, scale } = canvas.getTransform();
    const cx = nearX ?? (window.innerWidth / 2 - offsetX) / scale;
    const cy = nearY ?? (window.innerHeight / 2 - offsetY) / scale;

    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId: '',
      type: 'editor',
      filePath,
      x: cx,
      y: cy,
      width,
      height,
      zIndex: 0,
      title: fileName,
    };

    addTerminal(tw);
    canvas.focusOn(tw.x, tw.y, tw.width, tw.height);
    useTerminalStore.getState().saveLayout();
  }, [addTerminal, canvas]);

  // Restore sessions on mount (with StrictMode guard)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!token || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      const savedLayouts = loadLayout();
      const activeSessions = await fetchActiveSessions();
      const activeSet = new Set(activeSessions);

      let reconnected = 0;
      for (const layout of savedLayouts) {
        // Restore browser panels (no server session needed)
        if (layout.type === 'browser') {
          const tw: TerminalWindow = {
            id: crypto.randomUUID(),
            sessionId: '',
            type: 'browser',
            url: layout.url,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            zIndex: 0,
            title: layout.title || 'Browser',
          };
          addTerminal(tw);
          reconnected++;
          continue;
        }
        // Restore explorer panels
        if (layout.type === 'explorer') {
          const tw: TerminalWindow = {
            id: crypto.randomUUID(),
            sessionId: '',
            type: 'explorer',
            explorerRoot: layout.explorerRoot,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            zIndex: 0,
            title: layout.title || 'Explorer',
          };
          addTerminal(tw);
          reconnected++;
          continue;
        }
        // Restore memo panels
        if (layout.type === 'memo') {
          const tw: TerminalWindow = {
            id: crypto.randomUUID(),
            // Preserve the stable memo id (fallback for pre-6.6 layouts).
            sessionId: layout.sessionId || `memo-${crypto.randomUUID()}`,
            type: 'memo',
            memoText: layout.memoText ?? '',
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            zIndex: 0,
            title: layout.title || 'Memo',
          };
          addTerminal(tw);
          reconnected++;
          continue;
        }
        // Restore editor panels
        if (layout.type === 'editor') {
          const tw: TerminalWindow = {
            id: crypto.randomUUID(),
            sessionId: '',
            type: 'editor',
            filePath: layout.filePath,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            zIndex: 0,
            title: layout.title || 'Editor',
          };
          addTerminal(tw);
          reconnected++;
          continue;
        }
        if (layout.sessionId && activeSet.has(layout.sessionId)) {
          terminalCounter++;
          const tw: TerminalWindow = {
            id: crypto.randomUUID(),
            sessionId: layout.sessionId,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            zIndex: 0,
            title: layout.title || `Terminal ${terminalCounter}`,
          };
          addTerminal(tw);
          reconnected++;
        } else if (layout.sessionId && (!layout.type || layout.type === 'terminal')) {
          // Session is gone (server restart / killed) — keep the window as a
          // dead placeholder so its position survives and can be reopened.
          terminalCounter++;
          const tw: TerminalWindow = {
            id: crypto.randomUUID(),
            sessionId: layout.sessionId,
            type: 'terminal',
            dead: true,
            cwd: layout.cwd,
            x: layout.x,
            y: layout.y,
            width: layout.width,
            height: layout.height,
            zIndex: 0,
            title: layout.title || `Terminal ${terminalCounter}`,
          };
          addTerminal(tw);
          reconnected++;
        }
      }

      if (reconnected === 0) {
        const sessionId = await createTerminalSession();
        terminalCounter++;
        const tw: TerminalWindow = {
          id: crypto.randomUUID(),
          sessionId,
          x: 50,
          y: 50,
          width: 700,
          height: 450,
          zIndex: 0,
          title: `Terminal ${terminalCounter}`,
        };
        addTerminal(tw);
      }

      useTerminalStore.getState().saveLayout();

      // Restore links
      const savedLinks = useTerminalStore.getState().loadLinks();
      const restoredTerminals = useTerminalStore.getState().terminals;
      for (const sl of savedLinks) {
        let sourceId: string | null = null;
        let targetId: string | null = null;
        for (const [id, tw] of restoredTerminals) {
          if (tw.sessionId === sl.sourceSessionId) sourceId = id;
          if (tw.sessionId === sl.targetSessionId) targetId = id;
        }
        if (sourceId && targetId) {
          useTerminalStore.getState().restoreLink(sourceId, targetId);
        }
      }
    })();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleZoomToFit = useCallback(() => {
    const terminals = useTerminalStore.getState().terminals;
    canvas.zoomToFit(terminals);
  }, [canvas]);

  const handleAutoLayout = useCallback(() => {
    const { terminals, updateTerminal, saveLayout } = useTerminalStore.getState();
    const n = terminals.size;
    if (n === 0) return;

    const cols = Math.ceil(Math.sqrt(n));
    const gap = 30;
    const items = Array.from(terminals.values());

    // Compute max width per column and max height per row
    const colWidths = new Array<number>(cols).fill(0);
    const rows = Math.ceil(n / cols);
    const rowHeights = new Array<number>(rows).fill(0);

    for (let i = 0; i < items.length; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      colWidths[c] = Math.max(colWidths[c], items[i].width);
      rowHeights[r] = Math.max(rowHeights[r], items[i].height);
    }

    // Cumulative offsets for each column/row
    const colX = [0];
    for (let c = 1; c < cols; c++) {
      colX[c] = colX[c - 1] + colWidths[c - 1] + gap;
    }
    const rowY = [0];
    for (let r = 1; r < rows; r++) {
      rowY[r] = rowY[r - 1] + rowHeights[r - 1] + gap;
    }

    for (let i = 0; i < items.length; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      updateTerminal(items[i].id, { x: colX[c], y: rowY[r] });
    }
    saveLayout();
    canvas.zoomToFit(useTerminalStore.getState().terminals);
  }, [canvas]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'N') {
        e.preventDefault();
        addNewTerminal();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [addNewTerminal]);

  // ⌘H / Ctrl+H — toggle move(pan) vs select(copy) mode for terminal drags.
  // Capture + stop so it never reaches the focused terminal. Note: on macOS
  // browsers ⌘H is "Hide window" and may be swallowed by the OS before the page
  // sees it; if so, the toolbar button still toggles and we can rebind the key.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        e.stopPropagation();
        useSettings.getState().togglePanOverTerminals();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Save layout on unload
  useEffect(() => {
    const handler = () => {
      useTerminalStore.getState().saveLayout();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return (
    <>
      {/* Fixed explorer panel — aligned with toolbar, rounded, floating */}
      {explorerOpen && (
        <div
          style={{
            position: 'fixed',
            left: 14,
            top: explorerTop,
            bottom: 14,
            transition: 'top 200ms var(--ease-out)',
            width: PANEL_WIDTH,
            zIndex: 9999,
            background: '#1f2138',
            border: '1px solid rgba(122, 162, 247, 0.10)',
            borderRadius: 12,
            boxShadow: [
              '0 1px 0 rgba(255, 255, 255, 0.04) inset',
              '0 1px 2px rgba(0, 0, 0, 0.4)',
              '0 8px 20px -8px rgba(0, 0, 0, 0.5)',
            ].join(', '),
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'scaleIn 0.2s var(--ease-out) both',
          }}
        >
          {/* Explorer content */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ExplorerContent
              rootPath={explorerRoot}
              isActive={true}
              onOpenFile={(filePath, fileName) => openFileEditor(filePath, fileName)}
              onNavigate={(newRoot) => setExplorerRoot(newRoot)}
              onSpawnHere={spawnHereCentered}
            />
          </div>
        </div>
      )}

      {/* Canvas */}
      <div style={{ position: 'fixed', inset: 0 }}>
        <Canvas
          controller={canvas}
          onOpenFile={openFileEditor}
          onSpawnHere={spawnAt}
        />
      </div>
      <Sidebar
        controller={canvas}
        onAddTerminal={addNewTerminal}
        onToggleExplorer={toggleExplorer}
        explorerOpen={explorerOpen}
        onAddMemo={addMemoPanel}
        onAddBrowser={addBrowserPanel}
        onDuplicateTerminal={duplicateTerminal}
        onClaudeTerminal={claudeTerminal}
        onCodexTerminal={codexTerminal}
        onPowershellTerminal={powershellTerminal}
        onFocusTerminal={canvas.focusOn}
        onZoomToFit={handleZoomToFit}
        onAutoLayout={handleAutoLayout}
        onExpandChange={setSessionsExpanded}
      />
      <EdgeBadges controller={canvas} />
      <div className="noise-overlay" />
    </>
  );
}
