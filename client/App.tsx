import { useCallback, useEffect, useRef } from 'react';
import Canvas from './components/Canvas.js';
import Sidebar from './components/Sidebar.js';
import { useCanvas } from './hooks/useCanvas.js';
import { useTerminalStore } from './hooks/useTerminalStore.js';
import type { TerminalWindow } from './types.js';

let terminalCounter = 0;

async function fetchToken(): Promise<string> {
  const res = await fetch('/api/token');
  const data = await res.json();
  return data.token;
}

async function createTerminalSession(cols = 80, rows = 24, cwd?: string): Promise<string> {
  const res = await fetch('/api/terminals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows, cwd }),
  });
  const data = await res.json();
  return data.sessionId;
}

async function fetchActiveSessions(): Promise<string[]> {
  const res = await fetch('/api/terminals');
  const data = await res.json();
  return data.sessions;
}

export default function App() {
  const canvas = useCanvas();
  const { setToken, addTerminal, loadLayout } = useTerminalStore();
  const token = useTerminalStore((s) => s.token);

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
    canvas.focusOn(tw.x, tw.y, tw.width, tw.height);
    useTerminalStore.getState().saveLayout();
  }, [token, addTerminal, canvas]);

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
    canvas.focusOn(tw.x, tw.y, tw.width, tw.height);
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
  }, [token, addTerminal, canvas]);

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
    canvas.focusOn(tw.x, tw.y, tw.width, tw.height);
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
  }, [token, addTerminal, canvas]);

  const addBrowserPanel = useCallback((url?: string) => {
    const { offsetX, offsetY, scale } = canvas.transform;
    const centerX = (window.innerWidth / 2 - offsetX) / scale;
    const centerY = (window.innerHeight / 2 - offsetY) / scale;

    const width = 800;
    const height = 550;

    const initialUrl = url || 'https://www.google.com/webhp?igu=1';
    const host = initialUrl.replace(/^https?:\/\//, '').split('/')[0];

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

    // Use max dimensions so no panels overlap
    let maxW = 0, maxH = 0;
    for (const tw of terminals.values()) {
      if (tw.width > maxW) maxW = tw.width;
      if (tw.height > maxH) maxH = tw.height;
    }

    let i = 0;
    for (const tw of terminals.values()) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      updateTerminal(tw.id, {
        x: col * (maxW + gap),
        y: row * (maxH + gap),
      });
      i++;
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
      <Canvas
        transform={canvas.transform}
        startPan={canvas.startPan}
        updatePan={canvas.updatePan}
        endPan={canvas.endPan}
        zoom={canvas.zoom}
        getIsSpaceDown={canvas.getIsSpaceDown}
        getIsPanning={canvas.getIsPanning}
        setSpaceDown={canvas.setSpaceDown}
      />
      <Sidebar
        transform={canvas.transform}
        onAddTerminal={addNewTerminal}
        onAddBrowser={addBrowserPanel}
        onDuplicateTerminal={duplicateTerminal}
        onClaudeTerminal={claudeTerminal}
        onCodexTerminal={codexTerminal}
        onFocusTerminal={canvas.focusOn}
        onZoomToFit={handleZoomToFit}
        onAutoLayout={handleAutoLayout}
      />
      <div className="noise-overlay" />
    </>
  );
}
