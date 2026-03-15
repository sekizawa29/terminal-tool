import { useCallback, useEffect, useRef } from 'react';
import TerminalWindow from './TerminalWindow.js';
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
}: CanvasProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const token = useTerminalStore((s) => s.token);
  const canvasRef = useRef<HTMLDivElement>(null);

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

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        zoom(e.deltaY, e.clientX, e.clientY);
      }
    },
    [zoom]
  );

  // Prevent browser zoom
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, []);

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

  const dotOpacity = Math.min(0.28, 0.15 + transform.scale * 0.06);

  return (
    <div
      ref={canvasRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onWheel={onWheel}
      style={{
        position: 'fixed',
        inset: 0,
        overflow: 'hidden',
        background: 'var(--bg-deepest)',
        cursor: getIsPanning() ? 'grabbing' : 'grab',
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
          transform: `translate(${transform.offsetX}px, ${transform.offsetY}px)`,
          zoom: transform.scale,
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      >
        {token &&
          Array.from(terminals.values()).map((tw) => (
            <TerminalWindow
              key={tw.id}
              tw={tw}
              token={token}
              scale={transform.scale}
              onZoom={zoom}
            />
          ))}
      </div>
    </div>
  );
}
