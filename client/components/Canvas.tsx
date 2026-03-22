import { useCallback, useEffect, useRef } from 'react';
import TerminalWindow from './TerminalWindow.js';
import LinkLines from './LinkLines.js';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import type { CanvasTransform } from '../hooks/useCanvas.js';

interface CanvasProps {
  transform: CanvasTransform;
  startPan: (clientX: number, clientY: number) => void;
  updatePan: (clientX: number, clientY: number) => void;
  endPan: () => void;
  zoom: (deltaY: number, clientX: number, clientY: number) => void;
  getIsSpaceDown: () => boolean;
  getIsPanning: () => boolean;
  setSpaceDown: (down: boolean) => void;
  onOpenFile?: (filePath: string, fileName: string, nearX: number, nearY: number) => void;
}

export default function Canvas({
  transform,
  startPan,
  updatePan,
  endPan,
  zoom,
  getIsSpaceDown,
  getIsPanning,
  setSpaceDown,
  onOpenFile,
}: CanvasProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const token = useTerminalStore((s) => s.token);
  const linkDragActive = useTerminalStore((s) => s.linkDrag.active);
  const canvasRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Space key tracking
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        const active = document.activeElement;
        const isInTerminal = active?.closest('.xterm');
        if (!isInTerminal) {
          e.preventDefault();
          setSpaceDown(true);
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setSpaceDown(false);
        endPan();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [setSpaceDown, endPan]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      const isBackground = e.target === canvasRef.current || e.target === canvasRef.current?.firstElementChild;
      if ((isBackground && e.button === 0) || (getIsSpaceDown() && e.button === 0) || e.button === 1) {
        e.preventDefault();
        startPan(e.clientX, e.clientY);
      }
    },
    [getIsSpaceDown, startPan]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (getIsPanning()) {
        updatePan(e.clientX, e.clientY);
      }
    },
    [getIsPanning, updatePan]
  );

  const onMouseUp = useCallback(() => {
    endPan();
  }, [endPan]);

  // Global wheel zoom – works even when mouse is over panels
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(e.deltaY, e.clientX, e.clientY);
      }
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, [zoom]);

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
      const t = transformRef.current;
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
  }, [linkDragActive]);

  const dotOpacity = Math.min(0.28, 0.15 + transform.scale * 0.06);

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
        cursor: linkDragActive ? 'crosshair' : getIsPanning() ? 'grabbing' : 'grab',
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

      {/* Dot grid */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: `radial-gradient(circle, rgba(192, 202, 245, ${dotOpacity}) 0.8px, transparent 0.8px)`,
          backgroundSize: `${20 * transform.scale}px ${20 * transform.scale}px`,
          backgroundPosition: `${transform.offsetX}px ${transform.offsetY}px`,
          pointerEvents: 'none',
        }}
      />

      {/* Transform container */}
      <div
        style={{
          transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
          transformOrigin: '0 0',
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        <LinkLines />
        {token &&
          Array.from(terminals.values()).map((tw) => (
            <TerminalWindow
              key={tw.id}
              tw={tw}
              token={token}
              scale={transform.scale}
              onZoom={zoom}
              onOpenFile={onOpenFile}
            />
          ))}
      </div>
    </div>
  );
}
