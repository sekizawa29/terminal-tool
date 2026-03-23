import { useCallback, useEffect, useRef, useState } from 'react';
import Canvas from './components/Canvas.js';
import Sidebar from './components/Sidebar.js';
import ExplorerContent from './components/ExplorerContent.js';
import { useCanvas } from './hooks/useCanvas.js';
import { useTerminalStore } from './hooks/useTerminalStore.js';
import type { TerminalWindow } from './types.js';

let terminalCounter = 0;

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/token');
  const data = await res.json();
  return data.token;
}

async function createTerminalSession(cols = 80, rows = 24, cwd?: string, shell?: string): Promise<string> {
  const res = await fetch('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows, cwd, shell }),
  });
  const data = await res.json();
  return data.sessionId;
}

async function fetchActiveSessions(): Promise<string[]> {
  const res = await fetch('/api/terminals');
  const data = await res.json();
  return data.sessions;
}

const PANEL_WIDTH = 290;

export default function App() {
  const canvas = useCanvas();
  const { setToken, addTerminal, loadLayout } = useTerminalStore();
  const token = useTerminalStore((s) => s.token);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [explorerRoot, setExplorerRoot] = useState('~');
  const [sessionsExpanded, setSessionsExpanded] = useState(false);

  // Fetch token on mount (with StrictMode guard)
  useEffect(() => {
    let cancelled = false;
    fetchToken().then((t) => {
      if (!cancelled) setToken(t);
    });
    return () => { cancelled = true; };
  }, [setToken]);

  const addNewTerminal = useCallback(async () => {
    if (!token) return;

    const sessionId = await createTerminalSession();
    const { offsetX, offsetY, scale } = canvas.transform;

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
  }, [token, canvas.transform, addTerminal]);

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

    const sessionId = await createTerminalSession(80, 24, cwd || undefined);
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

    setTimeout(async () => {
      const tokenVal = useTerminalStore.getState().token;
      if (!tokenVal) return;
      await fetch(`/api/terminals/${sessionId}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'claude\n' }),
      });
    }, 500);
  }, [token, addTerminal]);

  const codexTerminal = useCallback(async (cwd: string, nearX: number, nearY: number) => {
    if (!token) return;

    const sessionId = await createTerminalSession(80, 24, cwd || undefined);
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

    setTimeout(async () => {
      const tokenVal = useTerminalStore.getState().token;
      if (!tokenVal) return;
      await fetch(`/api/terminals/${sessionId}/write`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: 'codex\n' }),
      });
    }, 500);
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

  const toggleExplorer = useCallback(() => {
    setExplorerOpen((prev) => !prev);
  }, []);

  const addMemoPanel = useCallback(() => {
    const { offsetX, offsetY, scale } = canvas.transform;
    const centerX = (window.innerWidth / 2 - offsetX) / scale;
    const centerY = (window.innerHeight / 2 - offsetY) / scale;

    const width = 320;
    const height = 220;

    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId: '',
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
    const { offsetX, offsetY, scale } = canvas.transform;
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

  const addBrowserPanel = useCallback((url?: string) => {
    const { offsetX, offsetY, scale } = canvas.transform;
    const centerX = (window.innerWidth / 2 - offsetX) / scale;
    const centerY = (window.innerHeight / 2 - offsetY) / scale;

    const width = 800;
    const height = 550;

    const initialUrl = url || 'about:blank';
    const host = initialUrl === 'about:blank' ? 'Browser' : initialUrl.replace(/^https?:\/\//, '').split('/')[0];

    const tw: TerminalWindow = {
      id: crypto.randomUUID(),
      sessionId: '', // no server session for browser panels
      type: 'browser',
      url: initialUrl,
      x: centerX - width / 2,
      y: centerY - height / 2,
      width,
      height,
      zIndex: 0,
      title: host,
    };

    addTerminal(tw);
    useTerminalStore.getState().saveLayout();
  }, [canvas.transform, addTerminal]);

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
            sessionId: '',
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
          useTerminalStore.getState().addLink(sourceId, targetId);
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
            left: 12,
            top: sessionsExpanded ? 58 + 177 : 58,
            bottom: 12,
            transition: 'top 200ms var(--ease-out)',
            width: PANEL_WIDTH,
            zIndex: 9999,
            background: 'transparent',
            border: 'none',
            borderRadius: 10,
            boxShadow: 'none',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            animation: 'scaleIn 0.2s var(--ease-out) both',
          }}
        >
          {/* Explorer header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 34,
              padding: '0 10px',
              borderBottom: '1px solid rgba(255, 255, 255, 0.03)',
              flexShrink: 0,
              gap: 7,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.45, flexShrink: 0 }}>
              <path d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293L8.414 4.414A1 1 0 009.121 4.7H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
            </svg>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--text-tertiary)', letterSpacing: '0.04em', textTransform: 'uppercase', flex: 1 }}>
              Explorer
            </span>
            <button
              onClick={toggleExplorer}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 20,
                height: 20,
                background: 'none',
                border: 'none',
                color: 'var(--text-tertiary)',
                cursor: 'pointer',
                borderRadius: 4,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
              title="Close Explorer"
            >
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
          {/* Explorer content */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ExplorerContent
              rootPath={explorerRoot}
              isActive={true}
              onOpenFile={(filePath, fileName) => openFileEditor(filePath, fileName)}
              onNavigate={(newRoot) => setExplorerRoot(newRoot)}
            />
          </div>
        </div>
      )}

      {/* Canvas */}
      <div style={{ position: 'fixed', inset: 0 }}>
        <Canvas
          transform={canvas.transform}
          startPan={canvas.startPan}
          updatePan={canvas.updatePan}
          endPan={canvas.endPan}
          zoom={canvas.zoom}
          getIsSpaceDown={canvas.getIsSpaceDown}
          getIsPanning={canvas.getIsPanning}
          setSpaceDown={canvas.setSpaceDown}
          onOpenFile={openFileEditor}
        />
      </div>
      <Sidebar
        transform={canvas.transform}
        onAddTerminal={addNewTerminal}
        onAddBrowser={addBrowserPanel}
        onToggleExplorer={toggleExplorer}
        explorerOpen={explorerOpen}
        onAddMemo={addMemoPanel}
        onDuplicateTerminal={duplicateTerminal}
        onClaudeTerminal={claudeTerminal}
        onCodexTerminal={codexTerminal}
        onPowershellTerminal={powershellTerminal}
        onFocusTerminal={canvas.focusOn}
        onZoomToFit={handleZoomToFit}
        onAutoLayout={handleAutoLayout}
        onExpandChange={setSessionsExpanded}
      />
      <div className="noise-overlay" />
    </>
  );
}
