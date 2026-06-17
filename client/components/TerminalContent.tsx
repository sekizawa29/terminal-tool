import { useEffect, useRef, useCallback, useState } from 'react';
import { apiFetch } from '../api.js';
import { Terminal } from '@xterm/xterm';
import { SearchAddon } from '@xterm/addon-search';
import { CJK_UNICODE_VERSION, makeCjkWideProvider } from '../utils/cjkWidth.js';
import '@xterm/xterm/css/xterm.css';

// Highlight colors for in-window search (requires allowProposedApi).
const SEARCH_DECORATIONS = {
  matchBackground: '#3d59a1',
  matchBorder: '#7aa2f7',
  matchOverviewRuler: '#7aa2f7',
  activeMatchBackground: '#e0af68',
  activeMatchBorder: '#e0af68',
  activeMatchColorOverviewRuler: '#e0af68',
};

type ConnectionState = 'connected' | 'reconnecting' | 'closed';

interface TerminalContentProps {
  sessionId: string;
  token: string;
  isActive: boolean;
  getScale: () => number;
  onZoom?: (deltaY: number, clientX: number, clientY: number) => void;
  onExit?: () => void;
  onConnectionChange?: (state: ConnectionState) => void;
  onSessionDead?: () => void;
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
}

// Reconnect backoff schedule (ms), capped at 15s. Index = attempt number.
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000];

// Warn at most once if the xterm private-API mouse patch can't be applied.
let mousePatchWarned = false;

const RIGHT_EDGE_GUTTER_PX = 2;

function applyRightEdgeGutter(term: Terminal): void {
  const xtermEl = term.element;
  if (!xtermEl) return;

  xtermEl.style.paddingRight = `${RIGHT_EDGE_GUTTER_PX}px`;
}

function fitTerminalTightly(term: Terminal): void {
  applyRightEdgeGutter(term);

  const xtermEl = term.element;
  const parent = xtermEl?.parentElement;
  const cell = (term as any)._core?._renderService?.dimensions?.css?.cell;
  if (!xtermEl || !parent || !cell?.width || !cell?.height) return;

  const parentStyle = window.getComputedStyle(parent);
  const elementStyle = window.getComputedStyle(xtermEl);
  const parentWidth = Math.max(0, parseInt(parentStyle.getPropertyValue('width'), 10));
  const parentHeight = Math.max(0, parseInt(parentStyle.getPropertyValue('height'), 10));
  const paddingX =
    parseInt(elementStyle.getPropertyValue('padding-left'), 10) +
    parseInt(elementStyle.getPropertyValue('padding-right'), 10);
  const paddingY =
    parseInt(elementStyle.getPropertyValue('padding-top'), 10) +
    parseInt(elementStyle.getPropertyValue('padding-bottom'), 10);

  // Do not reserve xterm's default scrollbar width. tboard keeps terminal
  // scrollbars hidden, so subtracting that phantom 14px creates a visible gap.
  const cols = Math.max(2, Math.floor((parentWidth - paddingX) / cell.width));
  const rows = Math.max(1, Math.floor((parentHeight - paddingY) / cell.height));
  if (term.cols === cols && term.rows === rows) return;

  (term as any)._core?._renderService?.clear?.();
  term.resize(cols, rows);
}

export default function TerminalContent({
  sessionId,
  token,
  isActive,
  getScale,
  onZoom,
  onExit,
  onConnectionChange,
  onSessionDead,
  searchOpen = false,
  onSearchOpenChange,
}: TerminalContentProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const onSearchOpenChangeRef = useRef(onSearchOpenChange);
  onSearchOpenChangeRef.current = onSearchOpenChange;
  const wsRef = useRef<WebSocket | null>(null);
  const prevSizeRef = useRef({ cols: 0, rows: 0 });
  const tokenRef = useRef(token);
  tokenRef.current = token;
  // Read the live zoom at mouse-event time so the window never re-renders on zoom.
  const getScaleRef = useRef(getScale);
  getScaleRef.current = getScale;
  const onConnChangeRef = useRef(onConnectionChange);
  onConnChangeRef.current = onConnectionChange;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onSessionDeadRef = useRef(onSessionDead);
  onSessionDeadRef.current = onSessionDead;

  const sendPaste = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !text) return;

    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const payload = normalized.includes('\n')
      ? `\x1b[200~${normalized}\x1b[201~`
      : normalized;
    ws.send(payload);
  }, []);

  // Fit on container resize
  const doFit = useCallback(() => {
    if (!termRef.current) return;
    requestAnimationFrame(() => {
      try {
        fitTerminalTightly(termRef.current!);
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
      // Latin glyphs come from the mono fonts; the CJK fonts trailing the chain
      // only kick in for characters the mono fonts lack (Japanese, full-width
      // forms), so they render with proper full-width metrics instead of a
      // cramped proportional system fallback.
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, 'Symbols Nerd Font Mono', 'Noto Sans Mono CJK JP', 'Osaka-Mono', 'Yu Gothic', 'Meiryo', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Noto Sans CJK JP', 'MS Gothic', monospace",
      // NOTE: do NOT set `letterSpacing`. xterm's DOM renderer computes
      // cell.width = char.width + Math.round(letterSpacing), so any value >= 0.5
      // rounds to a 1-device-px gap added to *every* cell. That gap breaks the
      // continuity of box-drawing chars (─ │ ┌ …) — Claude Code's input-box
      // borders and separator rules then render as broken/dashed "hyphen" lines.
      // It also only applies to committed rows, not the IME composition overlay,
      // so composing Japanese looks cramped relative to the committed text.
      // CJK width is handled by the font chain above + the Unicode width
      // provider below, which is the correct mechanism — no tracking needed.
      theme: {
        background: '#000000',
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

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    termRef.current = term;
    searchAddonRef.current = searchAddon;

    // Promote ambiguous-width content chars (①, Ⅲ, ½ …) to 2 cells so their
    // full-width glyphs stop overlapping the next character. Delegates all other
    // widths to xterm's built-in UnicodeV6 provider, reached via the same
    // private-core access pattern as the mouse patch below; if the internal shape
    // ever changes we simply skip it and fall back to default widths.
    try {
      const us = (term as any)._core?.unicodeService;
      const base = us?._providers?.['6'] ?? us?._activeProvider;
      if (us && base && typeof base.wcwidth === 'function') {
        term.unicode.register(makeCjkWideProvider(base));
        term.unicode.activeVersion = CJK_UNICODE_VERSION;
      }
    } catch {
      // keep default Unicode widths
    }

    term.open(container);

    // Right-edge gutter. The board renders terminals under a CSS transform:
    // scale() (the zoom feature — see the mouse-coords patch below). Keep only
    // a tiny paint guard here; fitTerminalTightly computes cols without xterm's
    // phantom scrollbar reserve, so a large gutter would become visible slack.
    applyRightEdgeGutter(term);

    // Handle OSC 52 — terminal apps (e.g. Claude Code) use this to write to
    // the system clipboard.  Format: \x1b]52;Pc;Pd\x07
    // Pc = selection target (ignored), Pd = base64-encoded text or "?" (query)
    // When OSC 52 fires, set a flag so the next right-click is treated as
    // "copy done" (skip paste) to match the select → right-click → copy flow.
    let osc52Pending = false;
    term.parser.registerOscHandler(52, (data: string) => {
      const idx = data.indexOf(';');
      if (idx === -1) return true;
      const payload = data.slice(idx + 1);
      if (payload === '?') return true;
      try {
        const bin = atob(payload);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const text = new TextDecoder().decode(bytes);
        navigator.clipboard.writeText(text).catch(() => {});
        osc52Pending = true;
      } catch { /* invalid base64 */ }
      return true;
    });

    // Fix mouse coordinate offset caused by CSS transform: scale() on ancestor.
    // xterm.js computes cell width via OffscreenCanvas (unscaled), but mouse
    // coordinates from getBoundingClientRect are in screen space (scaled).
    //
    // NOTE: this reaches into xterm's private _core._mouseService. If you bump
    // @xterm/xterm (pinned in package.json), re-verify this patch still applies —
    // the guard below degrades to "selection offset when zoom != 100%" rather
    // than crashing if the internal shape changes.
    const core = (term as any)._core;
    const ms = core?._mouseService;
    if (ms && typeof ms.getCoords === 'function' && typeof ms.getMouseReportCoords === 'function') {
      const origGetCoords = ms.getCoords.bind(ms);
      ms.getCoords = function(event: any, element: HTMLElement, colCount: number, rowCount: number, isSelection?: boolean) {
        const s = getScaleRef.current();
        if (s !== 1) {
          const rect = element.getBoundingClientRect();
          event = {
            clientX: rect.left + (event.clientX - rect.left) / s,
            clientY: rect.top + (event.clientY - rect.top) / s,
          };
        }
        return origGetCoords(event, element, colCount, rowCount, isSelection);
      };
      const origGetMouseReportCoords = ms.getMouseReportCoords.bind(ms);
      ms.getMouseReportCoords = function(event: any, element: HTMLElement) {
        const s = getScaleRef.current();
        if (s !== 1) {
          const rect = element.getBoundingClientRect();
          event = {
            ...event,
            clientX: rect.left + (event.clientX - rect.left) / s,
            clientY: rect.top + (event.clientY - rect.top) / s,
          };
        }
        return origGetMouseReportCoords(event, element);
      };
    } else if (!mousePatchWarned) {
      mousePatchWarned = true;
      console.warn(
        '[tboard] xterm _mouseService.getCoords patch could not be applied; ' +
        'text selection may be offset when zoom != 100%. Check the xterm version.'
      );
    }

    // Re-measure after fonts load to ensure correct character dimensions.
    // Explicitly request the Nerd Font (icons in status lines) so it's fetched
    // before re-fit — @font-face fonts load lazily and would otherwise render
    // as tofu (□) on first paint.
    Promise.all([
      document.fonts.load("14px 'Symbols Nerd Font Mono'").catch(() => {}),
      document.fonts.ready,
    ]).then(() => doFit());

    // Right-click: copy selection if any, otherwise paste.
    // OSC 52 already copies to clipboard, so the first right-click after
    // an OSC 52 write is treated as "copy" (no paste). Next right-click pastes.
    const onContextMenu = (e: Event) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        osc52Pending = false;
      } else if (osc52Pending) {
        // OSC 52 already copied — consume the flag, don't paste
        osc52Pending = false;
      } else {
        navigator.clipboard.readText().then((text) => {
          sendPaste(text);
        }).catch(() => {});
      }
    };
    container.addEventListener('contextmenu', onContextMenu);

    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain') || '';
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      sendPaste(text);
    };
    container.addEventListener('paste', onPaste);

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      // Cmd/Ctrl+F → open the in-window search (allowed: not a navigation shortcut)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        onSearchOpenChangeRef.current?.(true);
        return false;
      }
      // Ctrl+V / Cmd+V → paste
      if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        return false;
      }
      // Block browser shortcuts that conflict with terminal Ctrl sequences
      // r=reverse-i-search, w=delete word, n=next history, p=previous history,
      // t=transpose chars, k=kill line, u=kill to start, y=yank, g=cancel
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        const blocked = ['r', 'w', 'n', 'p', 't', 'k', 'u', 'y', 'g'];
        if (blocked.includes(e.key.toLowerCase())) {
          e.preventDefault();
          return true; // let xterm handle the keystroke
        }
      }
      return true;
    });

    // DOM renderer (no WebGL) — crisp subpixel text rendering

    fitTerminalTightly(term);
    prevSizeRef.current = { cols: term.cols, rows: term.rows };

    // Wheel event handling: Ctrl+wheel → zoom, normal → scroll
    term.attachCustomWheelEventHandler((e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        onZoom?.(e.deltaY, e.clientX, e.clientY);
        return false;
      }
      return true;
    });

    // ── WebSocket connection with auto-reconnect ──────────────────────
    // The server keeps the pty alive across socket drops (sleep, backend
    // restart) and replays scrollback on re-attach, so we transparently
    // reconnect with exponential backoff instead of leaving a dead terminal.
    let unmounted = false;
    let exited = false;
    let hasConnected = false;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';

    const notify = (state: ConnectionState) => onConnChangeRef.current?.(state);

    const connect = () => {
      const ws = new WebSocket(
        `${protocol}//${location.host}/ws?sessionId=${sessionId}&token=${tokenRef.current}`
      );
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttempt = 0;
        notify('connected');
        // On a *re*connection the server is about to replay scrollback. Clear the
        // screen here (open fires before any message) so the replay doesn't
        // double-draw — but only now that the socket actually attached, so a
        // failed reconnect never wipes the still-visible local history.
        if (hasConnected) term.reset();
        hasConnected = true;
        // Send current size so the pty matches the (possibly resized) viewport.
        ws.send('\x00' + JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (event) => {
        const data = event.data as string;
        // Control message
        if (data.charCodeAt(0) === 0) {
          try {
            const msg = JSON.parse(data.slice(1));
            if (msg.type === 'exit') {
              exited = true;
              onExitRef.current?.();
            }
          } catch {
            // ignore
          }
          return;
        }
        term.write(data);
      };

      ws.onclose = (event) => {
        // Terminal states we never recover from: intentional unmount, a clean
        // shell exit, or a server rejection (bad token / origin / gone session).
        const fatal = unmounted || exited
          || event.code === 4001 || event.code === 4003 || event.code === 4004;
        if (fatal) {
          if (!unmounted && !exited) {
            // 4004 = the session no longer exists; drop to a dead placeholder so
            // the window (and its layout) survives a server restart.
            if (event.code === 4004) {
              onSessionDeadRef.current?.();
              return;
            }
            term.write('\r\n\x1b[90m[Connection closed]\x1b[0m\r\n');
            notify('closed');
          }
          return;
        }
        // Otherwise retry with backoff. The screen is cleared in onopen once the
        // new socket attaches (not here), so a reconnect that ultimately fails
        // leaves the existing scrollback visible instead of a blank screen.
        notify('reconnecting');
        const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
        reconnectAttempt++;
        reconnectTimer = setTimeout(() => {
          if (unmounted) return;
          connect();
        }, delay);
      };
    };

    connect();

    // Terminal input → WebSocket (read wsRef so it survives reconnects)
    const onDataDisposable = term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    const onBinaryDisposable = term.onBinary((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        const buf = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i++) {
          buf[i] = data.charCodeAt(i) & 0xff;
        }
        ws.send(buf);
      }
    });

    // ResizeObserver for container — trailing-debounced so a manual drag-resize
    // (a burst of size changes) refits once at the end instead of sending a
    // SIGWINCH/redraw storm to the TUI on every mousemove.
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (fitTimer) clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { fitTimer = null; doFit(); }, 100);
    });
    resizeObserver.observe(container);

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (fitTimer) clearTimeout(fitTimer);
      container.removeEventListener('contextmenu', onContextMenu);
      container.removeEventListener('paste', onPaste);
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      onBinaryDisposable.dispose();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
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
      const res = await apiFetch('/api/terminals/status');
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
        const res = await apiFetch('/api/upload', {
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
      sendPaste(escaped);
    }
  }, [sendPaste, sessionId]);

  const runSearch = useCallback((forward: boolean) => {
    const addon = searchAddonRef.current;
    if (!addon || !searchTerm) return;
    const opts = { caseSensitive: false, decorations: SEARCH_DECORATIONS };
    if (forward) addon.findNext(searchTerm, opts);
    else addon.findPrevious(searchTerm, opts);
  }, [searchTerm]);

  const closeSearch = useCallback(() => {
    onSearchOpenChange?.(false);
  }, [onSearchOpenChange]);

  // Focus the field on open; clear highlights and refocus the terminal on close.
  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    } else {
      searchAddonRef.current?.clearDecorations();
      if (isActive) termRef.current?.focus();
    }
  }, [searchOpen, isActive]);

  // Re-highlight as the query changes while the bar is open.
  useEffect(() => {
    if (!searchOpen) return;
    const addon = searchAddonRef.current;
    if (!addon) return;
    if (searchTerm) {
      addon.findNext(searchTerm, { caseSensitive: false, decorations: SEARCH_DECORATIONS });
    } else {
      addon.clearDecorations();
    }
  }, [searchTerm, searchOpen]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {searchOpen && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 6px',
            borderRadius: 7,
            background: 'rgba(26, 27, 38, 0.95)',
            border: '1px solid rgba(122, 162, 247, 0.25)',
            boxShadow: '0 4px 14px -4px rgba(0,0,0,0.6)',
          }}
        >
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="検索"
            spellCheck={false}
            style={{
              width: 130,
              height: 22,
              padding: '0 7px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 5,
              color: 'var(--text-secondary)',
              fontSize: 11.5,
              outline: 'none',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(!e.shiftKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button type="button" title="前へ (Shift+Enter)" onClick={() => runSearch(false)} style={searchBtnStyle}>↑</button>
          <button type="button" title="次へ (Enter)" onClick={() => runSearch(true)} style={searchBtnStyle}>↓</button>
          <button type="button" title="閉じる (Esc)" onClick={closeSearch} style={searchBtnStyle}>✕</button>
        </div>
      )}
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
    </div>
  );
}

const searchBtnStyle: React.CSSProperties = {
  width: 22,
  height: 22,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 'none',
  borderRadius: 5,
  color: 'var(--text-tertiary)',
  cursor: 'pointer',
  fontSize: 12,
};
