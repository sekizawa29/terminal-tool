import { useCallback, useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import TerminalWindow from './TerminalWindow.js';
import LinkLines from './LinkLines.js';
import ZoomIndicator from './ZoomIndicator.js';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import { useSettings } from '../hooks/useSettings.js';
import type { CanvasController } from '../hooks/useCanvas.js';

// Distance (px) the pointer must travel before a terminal drag is treated as a
// board pan rather than a click (which still focuses the terminal).
const TERMINAL_PAN_THRESHOLD = 4;

interface CanvasProps {
  controller: CanvasController;
  onOpenFile?: (filePath: string, fileName: string, nearX: number, nearY: number) => void;
  onSpawnHere?: (kind: 'terminal' | 'claude' | 'codex', cwd: string, nearX: number, nearY: number) => void;
}

export default function Canvas({ controller, onOpenFile, onSpawnHere }: CanvasProps) {
  // Subscribe only to the SET of window ids (shallow-compared) so a position
  // update during a drag — which replaces the terminals Map but not its keys —
  // does not re-render Canvas (and thus every window). Each TerminalWindow
  // subscribes to its own data by id.
  const terminalIds = useTerminalStore(useShallow((s) => Array.from(s.terminals.keys())));
  const token = useTerminalStore((s) => s.token);
  const linkDragActive = useTerminalStore((s) => s.linkDrag.active);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Event-time scale getter passed to windows so they read the current zoom
  // without re-rendering when it changes.
  const getScale = useCallback(() => controller.getTransform().scale, [controller]);

  // Space key tracking
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        const active = document.activeElement;
        const isInTerminal = active?.closest('.xterm');
        if (!isInTerminal) {
          e.preventDefault();
          controller.setSpaceDown(true);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        controller.setSpaceDown(false);
        controller.endPan();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [controller]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const isBackground = e.target === canvasRef.current || e.target === canvasRef.current?.firstElementChild;
      if ((isBackground && e.button === 0) || (controller.getIsSpaceDown() && e.button === 0) || e.button === 1) {
        e.preventDefault();
        controller.startPan(e.clientX, e.clientY);
      }
    },
    [controller]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (controller.getIsPanning()) {
        controller.updatePan(e.clientX, e.clientY);
      }
    },
    [controller]
  );

  const onMouseUp = useCallback(() => {
    controller.endPan();
  }, [controller]);

  // Global wheel zoom – works even when mouse is over panels
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        controller.zoom(e.deltaY, e.clientX, e.clientY);
        return;
      }

      const target = e.target;
      const inWindow = target instanceof Element && target.closest('.terminal-window-enter');
      if (!inWindow) {
        e.preventDefault();
        controller.panBy(-e.deltaX, -e.deltaY);
      }
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, [controller]);

  // Pan the board when dragging over a terminal (opt-in via settings).
  //
  // macOS three-finger-drag reports a normal left-button drag, which xterm
  // turns into a text selection. When panOverTerminals is on we hijack that
  // drag to pan the canvas instead. We listen in the CAPTURE phase on window so
  // we run before xterm's own document-level mousemove/mouseup selection
  // listeners; stopImmediatePropagation then prevents them from extending a
  // selection (or sending mouse-move reports) while we pan.
  //
  // mousedown is intentionally NOT swallowed, so a plain click still reaches
  // xterm (focus + forwarding clicks to TUI apps). Only once the pointer moves
  // past the threshold do we take over.
  useEffect(() => {
    let armed = false; // mousedown landed on a terminal in pan mode
    let panning = false; // threshold crossed → driving controller pan
    let startX = 0;
    let startY = 0;

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      if (!useSettings.getState().panOverTerminals) return;
      // Defer to the existing space-pan / link-drag flows when active.
      if (controller.getIsSpaceDown()) return;
      if (useTerminalStore.getState().linkDrag.active) return;
      const target = e.target;
      if (!(target instanceof Element) || !target.closest('.xterm')) return;
      armed = true;
      panning = false;
      startX = e.clientX;
      startY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!armed) return;
      if (!panning) {
        if (
          Math.abs(e.clientX - startX) < TERMINAL_PAN_THRESHOLD &&
          Math.abs(e.clientY - startY) < TERMINAL_PAN_THRESHOLD
        ) {
          // Still in the click dead-zone: suppress xterm selection jitter but
          // don't pan yet, so a tiny wobble on a click doesn't move the board.
          e.stopImmediatePropagation();
          return;
        }
        panning = true;
        controller.startPan(startX, startY);
      }
      // Take over: block xterm selection / mouse-report and pan instead.
      e.stopImmediatePropagation();
      e.preventDefault();
      controller.updatePan(e.clientX, e.clientY);
    };

    const onMouseUp = () => {
      // Let mouseup reach xterm so it tears down its selection listeners; we
      // only need to end the pan. A no-move click falls through as a real click.
      if (panning) controller.endPan();
      armed = false;
      panning = false;
    };

    window.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('mouseup', onMouseUp, true);
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('mouseup', onMouseUp, true);
    };
  }, [controller]);

  // Prevent middle-click autoscroll
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, []);

  // Global handlers for link drag (track mouse position + cancel on mouseUp)
  useEffect(() => {
    if (!linkDragActive) return;

    const onMove = (e: MouseEvent) => {
      const t = controller.getTransform();
      const canvasX = (e.clientX - t.offsetX) / t.scale;
      const canvasY = (e.clientY - t.offsetY) / t.scale;
      useTerminalStore.getState().updateLinkDrag(canvasX, canvasY);
    };

    const onUp = () => {
      useTerminalStore.getState().endLinkDrag();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [linkDragActive, controller]);

  const initial = controller.getTransform();
  const initialDotOpacity = Math.min(0.28, 0.15 + initial.scale * 0.06);

  return (
    <div
      ref={canvasRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        background: 'var(--bg-deepest)',
        cursor: linkDragActive ? 'crosshair' : 'grab',
      }}
    >
      {/* Subtle radial gradient — depth atmosphere */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse 80% 60% at 50% 40%, rgba(122, 162, 247, 0.03) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      {/* Dot grid — updated imperatively by the controller (gridRef) */}
      <div
        ref={controller.gridRef}
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(circle, rgba(192, 202, 245, ${initialDotOpacity}) 0.8px, transparent 0.8px)`,
          backgroundSize: `${20 * initial.scale}px ${20 * initial.scale}px`,
          backgroundPosition: `${initial.offsetX}px ${initial.offsetY}px`,
          pointerEvents: 'none',
        }}
      />

      {/* Transform container — updated imperatively by the controller (containerRef) */}
      <div
        ref={controller.containerRef}
        style={{
          transform: `translate(${initial.offsetX}px, ${initial.offsetY}px) scale(${initial.scale})`,
          transformOrigin: '0 0',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        <LinkLines />
        {token &&
          terminalIds.map((id) => (
            <TerminalWindow
              key={id}
              id={id}
              token={token}
              getScale={getScale}
              onZoom={controller.zoom}
              onOpenFile={onOpenFile}
              onSpawnHere={onSpawnHere}
            />
          ))}
      </div>

      <ZoomIndicator controller={controller} />
    </div>
  );
}
