import { useEffect, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import type { CanvasController } from '../hooks/useCanvas.js';
import { isWindowInViewport, windowScreenCenter } from '../utils/viewport.js';

const EDGE_MARGIN = 16;
const CHIP_HALF_W = 80; // keep the chip fully on screen when clamping
const CHIP_HALF_H = 14;

// Arrow glyph pointing from the viewport toward the offscreen window.
function arrowFor(dx: number, dy: number): string {
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, y is down
  const arrows = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  const idx = Math.round(((deg + 360) % 360) / 45) % 8;
  return arrows[idx];
}

// Fixed overlay (outside the transformed canvas) that points to windows with
// pending attention while they are offscreen. Click jumps to the window.
export default function EdgeBadges({ controller }: { controller: CanvasController }) {
  const attention = useTerminalStore((s) => s.attention);
  const terminals = useTerminalStore((s) => s.terminals);
  const setActive = useTerminalStore((s) => s.setActive);
  const bringToFront = useTerminalStore((s) => s.bringToFront);
  const clearAttention = useTerminalStore((s) => s.clearAttention);
  const [, forceTick] = useState(0);

  // Re-render on pan/zoom (rAF-throttled) so the chips track the transform.
  useEffect(() => {
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
  }, [controller]);

  // Drop attention for windows that are gone or now visible. Runs after every
  // render (including transform ticks), converges because clearing a resolved
  // id leaves nothing more to clear.
  useEffect(() => {
    for (const id of attention.keys()) {
      const tw = terminals.get(id);
      if (!tw) {
        clearAttention(id);
        continue;
      }
      if (
        document.visibilityState === 'visible' &&
        isWindowInViewport(tw, controller.getTransform())
      ) {
        clearAttention(id);
      }
    }
  });

  const t = controller.getTransform();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;
  const cx = vpW / 2;
  const cy = vpH / 2;

  const chips: React.ReactNode[] = [];
  for (const id of attention.keys()) {
    const tw = terminals.get(id);
    if (!tw) continue;
    if (isWindowInViewport(tw, t)) continue;

    const wc = windowScreenCenter(tw, t);
    let dx = wc.x - cx;
    let dy = wc.y - cy;
    if (dx === 0 && dy === 0) dy = 1;

    // Cast a ray from the viewport center toward the window and find where it
    // exits the inset rectangle.
    const insetX = vpW / 2 - EDGE_MARGIN;
    const insetY = vpH / 2 - EDGE_MARGIN;
    const tx = dx !== 0 ? insetX / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? insetY / Math.abs(dy) : Infinity;
    const k = Math.min(tx, ty);
    let px = cx + dx * k;
    let py = cy + dy * k;
    // Keep the whole chip on screen.
    px = Math.max(EDGE_MARGIN + CHIP_HALF_W, Math.min(vpW - EDGE_MARGIN - CHIP_HALF_W, px));
    py = Math.max(EDGE_MARGIN + CHIP_HALF_H, Math.min(vpH - EDGE_MARGIN - CHIP_HALF_H, py));

    chips.push(
      <button
        key={id}
        type="button"
        title={`${tw.title} へ移動`}
        onClick={() => {
          controller.focusOn(tw.x, tw.y, tw.width, tw.height);
          bringToFront(id);
          setActive(id);
          clearAttention(id);
        }}
        style={{
          position: 'absolute',
          left: px,
          top: py,
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          maxWidth: CHIP_HALF_W * 2,
          padding: '4px 9px',
          borderRadius: 999,
          border: '1px solid rgba(224, 175, 104, 0.55)',
          background: 'rgba(224, 175, 104, 0.18)',
          backdropFilter: 'blur(8px)',
          color: 'var(--accent-yellow)',
          fontSize: 11,
          fontWeight: 600,
          cursor: 'pointer',
          pointerEvents: 'auto',
          boxShadow: '0 2px 10px -2px rgba(0,0,0,0.5)',
          animation: 'statusPulse 2s ease-in-out infinite',
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{ fontSize: 12 }}>{arrowFor(dx, dy)}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tw.title}</span>
      </button>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9998,
        pointerEvents: 'none',
      }}
    >
      {chips}
    </div>
  );
}
