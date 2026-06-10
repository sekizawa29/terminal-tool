import { useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import type { CanvasController } from '../hooks/useCanvas.js';
import { isAgentProcess } from '../utils/agents.js';

const WIDTH = 220;
const HEADER_H = 22;
const BODY_H = 138;
const PAD = 10;
const COLLAPSE_KEY = 'terminal-board-minimap-collapsed';

interface MapBox {
  minX: number;
  minY: number;
  spanX: number;
  spanY: number;
  scale: number;
  offX: number;
  offY: number;
}

// Right-bottom overview of the whole board: every window plus the current
// viewport, drawn to scale. Click/drag to recenter the canvas there.
export default function Minimap({ controller }: { controller: CanvasController }) {
  const terminals = useTerminalStore((s) => s.terminals);
  const statuses = useTerminalStore((s) => s.sessionStatuses);
  const attention = useTerminalStore((s) => s.attention);
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [, forceTick] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);
  const draggingRef = useRef(false);

  // Track pan/zoom (rAF-throttled) so the viewport rect follows.
  useEffect(() => {
    if (collapsed) return;
    let raf = 0;
    const onChange = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        forceTick((v) => v + 1);
      });
    };
    const unsub = controller.subscribe(onChange);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsub();
    };
  }, [controller, collapsed]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch { /* storage unavailable */ }
      return next;
    });
  };

  const t = controller.getTransform();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  // Viewport in world coordinates.
  const view = {
    x: -t.offsetX / t.scale,
    y: -t.offsetY / t.scale,
    w: vpW / t.scale,
    h: vpH / t.scale,
  };

  // Bounding box over every window and the viewport.
  let minX = view.x;
  let minY = view.y;
  let maxX = view.x + view.w;
  let maxY = view.y + view.h;
  for (const tw of terminals.values()) {
    minX = Math.min(minX, tw.x);
    minY = Math.min(minY, tw.y);
    maxX = Math.max(maxX, tw.x + tw.width);
    maxY = Math.max(maxY, tw.y + tw.height);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const innerW = WIDTH - PAD * 2;
  const innerH = BODY_H - PAD * 2;
  const scale = Math.min(innerW / spanX, innerH / spanY);
  const offX = PAD + (innerW - spanX * scale) / 2;
  const offY = PAD + (innerH - spanY * scale) / 2;
  const box: MapBox = { minX, minY, spanX, spanY, scale, offX, offY };

  const toMap = (wx: number, wy: number) => ({
    x: box.offX + (wx - box.minX) * box.scale,
    y: box.offY + (wy - box.minY) * box.scale,
  });

  const recenterFromEvent = (e: { clientX: number; clientY: number }) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = box.minX + (mx - box.offX) / box.scale;
    const worldY = box.minY + (my - box.offY) / box.scale;
    controller.focusOn(worldX, worldY, 0, 0);
  };
  // Keep the persistent drag listener pointed at the latest closure (current
  // box/scale/offset), so a drag after the bounds change maps correctly.
  const recenterRef = useRef(recenterFromEvent);
  recenterRef.current = recenterFromEvent;

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (draggingRef.current) recenterRef.current(e);
    };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const colorFor = (id: string, sessionId: string): string => {
    if (id === activeId) return 'var(--accent-blue)';
    if (attention.has(id)) return 'var(--accent-yellow)';
    const status = statuses.get(sessionId);
    if (status && status.isProcessing && isAgentProcess(status.foregroundProcess)) {
      return 'var(--accent-green)';
    }
    return 'rgba(192, 202, 245, 0.22)';
  };

  const viewMap = toMap(view.x, view.y);

  return (
    <div
      style={{
        position: 'fixed',
        right: 14,
        bottom: 14,
        width: WIDTH,
        zIndex: 9997,
        background: 'rgba(28, 29, 46, 0.82)',
        border: '1px solid rgba(122, 162, 247, 0.18)',
        borderRadius: 10,
        boxShadow: '0 8px 24px -10px rgba(0,0,0,0.6)',
        backdropFilter: 'blur(10px)',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      <div
        onClick={toggleCollapsed}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: HEADER_H,
          padding: '0 9px',
          cursor: 'pointer',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-tertiary)',
        }}
      >
        <span>Map</span>
        <span style={{ fontSize: 9 }}>{collapsed ? '▢' : '▣'}</span>
      </div>
      {!collapsed && (
        <svg
          ref={svgRef}
          width={WIDTH}
          height={BODY_H}
          style={{ display: 'block', cursor: 'pointer' }}
          onMouseDown={(e) => {
            e.preventDefault();
            draggingRef.current = true;
            recenterFromEvent(e);
          }}
        >
          {Array.from(terminals.values()).map((tw) => {
            const p = toMap(tw.x, tw.y);
            return (
              <rect
                key={tw.id}
                x={p.x}
                y={p.y}
                width={Math.max(2, tw.width * box.scale)}
                height={Math.max(2, tw.height * box.scale)}
                rx={1.5}
                fill={colorFor(tw.id, tw.sessionId)}
                stroke={tw.id === activeId ? 'var(--accent-blue)' : 'none'}
                strokeWidth={tw.id === activeId ? 1 : 0}
              />
            );
          })}
          <rect
            x={viewMap.x}
            y={viewMap.y}
            width={view.w * box.scale}
            height={view.h * box.scale}
            fill="rgba(122, 162, 247, 0.10)"
            stroke="rgba(122, 162, 247, 0.85)"
            strokeWidth={1}
            rx={2}
          />
        </svg>
      )}
    </div>
  );
}
