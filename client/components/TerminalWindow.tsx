import { useCallback, useRef, useState } from 'react';
import TerminalContent from './TerminalContent.js';
import ResizeHandle from './ResizeHandle.js';
import type { TerminalWindow as TWType } from '../types.js';
import { useTerminalStore } from '../hooks/useTerminalStore.js';

interface TerminalWindowProps {
  tw: TWType;
  token: string;
  scale: number;
  onZoom: (deltaY: number, clientX: number, clientY: number) => void;
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

export default function TerminalWindow({ tw, token, scale, onZoom }: TerminalWindowProps) {
  const { updateTerminal, removeTerminal, bringToFront, setActive, activeTerminalId, saveLayout } =
    useTerminalStore();

  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);

  const onTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY };
      bringToFront(tw.id);
      setActive(tw.id);

      const onMouseMove = (e: MouseEvent) => {
        if (!dragging.current) return;
        const dx = (e.clientX - dragStart.current.x) / scale;
        const dy = (e.clientY - dragStart.current.y) / scale;
        dragStart.current = { x: e.clientX, y: e.clientY };
        updateTerminal(tw.id, { x: tw.x + dx, y: tw.y + dy });
        tw.x += dx;
        tw.y += dy;
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        saveLayout();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [tw, scale, updateTerminal, bringToFront, setActive, saveLayout]
  );

  const onResize = useCallback(
    (dx: number, dy: number) => {
      const newWidth = Math.max(MIN_WIDTH, tw.width + dx);
      const newHeight = Math.max(MIN_HEIGHT, tw.height + dy);
      updateTerminal(tw.id, { width: newWidth, height: newHeight });
      tw.width = newWidth;
      tw.height = newHeight;
    },
    [tw, updateTerminal]
  );

  const onResizeEnd = useCallback(() => {
    saveLayout();
  }, [saveLayout]);

  const onWindowClick = useCallback(() => {
    bringToFront(tw.id);
    setActive(tw.id);
  }, [tw.id, bringToFront, setActive]);

  const onClose = useCallback(() => {
    // Kill PTY on server
    fetch(`/api/terminals/${tw.sessionId}`, { method: 'DELETE' }).catch(() => {});
    removeTerminal(tw.id);
    saveLayout();
  }, [tw.id, tw.sessionId, removeTerminal, saveLayout]);

  const isActive = activeTerminalId === tw.id;

  return (
    <div
      className="terminal-window-enter"
      onMouseDown={onWindowClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'absolute',
        left: tw.x,
        top: tw.y,
        width: tw.width,
        height: tw.height,
        zIndex: tw.zIndex,
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        border: isActive
          ? '1px solid rgba(122, 162, 247, 0.5)'
          : isHovered
          ? '1px solid var(--border-strong)'
          : '1px solid var(--border-subtle)',
        boxShadow: isActive
          ? 'var(--shadow-glow)'
          : isHovered
          ? 'var(--shadow-lg)'
          : 'var(--shadow-window)',
        transition: 'border-color var(--duration-normal) var(--ease-out), box-shadow var(--duration-slow) var(--ease-out)',
      }}
    >
      {/* Title bar — macOS-inspired */}
      <div
        onMouseDown={onTitleMouseDown}
        style={{
          height: 36,
          background: isActive
            ? 'linear-gradient(180deg, #1f2033 0%, #1a1b2a 100%)'
            : 'linear-gradient(180deg, #1a1b28 0%, #16171f 100%)',
          display: 'flex',
          alignItems: 'center',
          padding: '0 12px',
          cursor: 'grab',
          userSelect: 'none',
          flexShrink: 0,
          gap: 10,
          borderBottom: '1px solid rgba(0, 0, 0, 0.3)',
          transition: 'background var(--duration-normal)',
        }}
      >
        {/* Traffic light — close button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            onMouseEnter={() => setCloseHovered(true)}
            onMouseLeave={() => setCloseHovered(false)}
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              border: 'none',
              background: closeHovered
                ? 'var(--accent-red)'
                : isActive
                ? 'rgba(247, 118, 142, 0.4)'
                : 'var(--border-default)',
              cursor: 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'all var(--duration-fast) var(--ease-out)',
              boxShadow: closeHovered ? '0 0 6px rgba(247, 118, 142, 0.4)' : 'none',
            }}
          >
            {closeHovered && (
              <svg width="6" height="6" viewBox="0 0 6 6" fill="none">
                <path d="M1 1l4 4M5 1l-4 4" stroke="#1a1b26" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            )}
          </button>
          {/* Decorative dots */}
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: isActive ? 'rgba(224, 175, 104, 0.25)' : 'var(--border-default)',
              transition: 'background var(--duration-normal)',
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: isActive ? 'rgba(158, 206, 106, 0.25)' : 'var(--border-default)',
              transition: 'background var(--duration-normal)',
            }}
          />
        </div>

        {/* Title */}
        <span
          style={{
            flex: 1,
            fontSize: 11.5,
            fontWeight: 500,
            color: isActive ? 'var(--text-secondary)' : 'var(--text-tertiary)',
            textAlign: 'center',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '0.2px',
            transition: 'color var(--duration-normal)',
          }}
        >
          {tw.title}
        </span>

        {/* Right spacer to balance the traffic lights */}
        <div style={{ width: 54 }} />
      </div>

      {/* Terminal content */}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <TerminalContent
          sessionId={tw.sessionId}
          token={token}
          isActive={isActive}
          onZoom={onZoom}
          onExit={onClose}
        />
        <ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} scale={scale} />
      </div>
    </div>
  );
}
