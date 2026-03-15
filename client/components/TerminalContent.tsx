import { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalContentProps {
  sessionId: string;
  token: string;
  isActive: boolean;
  onZoom?: (deltaY: number, clientX: number, clientY: number) => void;
  onExit?: () => void;
}

export default function TerminalContent({
  sessionId,
  token,
  isActive,
  onZoom,
  onExit,
}: TerminalContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const prevSizeRef = useRef({ cols: 0, rows: 0 });
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Fit on container resize
  const doFit = useCallback(() => {
    if (!fitAddonRef.current || !termRef.current) return;
    requestAnimationFrame(() => {
      try {
        fitAddonRef.current!.fit();
        const { cols, rows } = termRef.current!;
        if (cols !== prevSizeRef.current.cols || rows !== prevSizeRef.current.rows) {
          prevSizeRef.current = { cols, rows };
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('\x00' + JSON.stringify({ type: 'resize', cols, rows }));
          }
        }
      } catch {
        // fit can throw if element is not visible
      }
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      theme: {
        background: '#1a1b26',
        foreground: '#c0caf5',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    term.open(container);

    // Auto-copy on selection (like typical Linux terminal)
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
      }
    });

    // Right-click → paste
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(text);
        }
      }).catch(() => {});
    });

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      // Ctrl+V / Cmd+V → paste
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        return false;
      }
      return true;
    });

    // DOM renderer (no WebGL) — crisp subpixel text rendering

    fitAddon.fit();
    prevSizeRef.current = { cols: term.cols, rows: term.rows };

    // Wheel event handling: Ctrl+wheel → zoom, normal → scroll
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        onZoom?.(e.deltaY, e.clientX, e.clientY);
        return false;
      }
      return true;
    });

    // WebSocket connection
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${location.host}/ws?sessionId=${sessionId}&token=${tokenRef.current}`
    );
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial size
      ws.send('\x00' + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.onmessage = (event) => {
      const data = event.data as string;
      // Control message
      if (data.charCodeAt(0) === 0) {
        try {
          const msg = JSON.parse(data.slice(1));
          if (msg.type === 'exit') {
            onExit?.();
          }
        } catch {
          // ignore
        }
        return;
      }
      term.write(data);
    };

    ws.onclose = () => {
      term.write('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n');
    };

    // Terminal input → WebSocket
    const onDataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const onBinaryDisposable = term.onBinary((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        const buf = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          buf[i] = data.charCodeAt(i) & 0xff;
        }
        ws.send(buf);
      }
    });

    // ResizeObserver for container
    const resizeObserver = new ResizeObserver(() => {
      doFit();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus management
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.focus();
    }
  }, [isActive]);

  // Drag & drop files → upload to CWD → paste path
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Get terminal's CWD
    let cwd = '';
    try {
      const res = await fetch('/api/terminals/status');
      const data = await res.json();
      const status = data.statuses.find((s: { sessionId: string }) => s.sessionId === sessionId);
      cwd = status?.cwd || '';
    } catch {}

    if (!cwd) return;

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const paths: string[] = [];
    for (const file of files) {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve) => {
        reader.onload = () => {
          const result = reader.result as string;
          resolve(result.split(',')[1] || '');
        };
        reader.readAsDataURL(file);
      });

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, data: base64, cwd }),
        });
        const data = await res.json();
        if (data.path) paths.push(data.path);
      } catch {}
    }

    if (paths.length > 0) {
      // Paste escaped paths into terminal
      const escaped = paths.map(p => p.includes(' ') ? `'${p}'` : p).join(' ');
      ws.send(escaped);
    }
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        outline: dragOver ? '2px solid #7aa2f7' : 'none',
        outlineOffset: -2,
      }}
    />
  );
}
