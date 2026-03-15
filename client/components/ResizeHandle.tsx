import { useCallback, useRef, useState } from 'react';

interface ResizeHandleProps {
  onResize: (dx: number, dy: number) => void;
  onResizeEnd: () => void;
  scale: number;
}

export default function ResizeHandle({ onResize, onResizeEnd, scale }: ResizeHandleProps) {
  const dragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = true;
      setIsDragging(true);
      startPos.current = { x: e.clientX, y: e.clientY };

      const onMouseMove = (e: MouseEvent) => {
        if (!dragging.current) return;
        const dx = (e.clientX - startPos.current.x) / scale;
        const dy = (e.clientY - startPos.current.y) / scale;
        startPos.current = { x: e.clientX, y: e.clientY };
        onResize(dx, dy);
      };

      const onMouseUp = () => {
        dragging.current = false;
        setIsDragging(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        onResizeEnd();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [onResize, onResizeEnd, scale]
  );

  const active = isHovered || isDragging;

  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        position: 'absolute',
        right: 0,
        bottom: 0,
        width: 20,
        height: 20,
        cursor: 'nwse-resize',
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity var(--duration-fast)',
        opacity: active ? 1 : 0.4,
      }}
    >
      {/* Three-line grip indicator */}
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        style={{
          transform: 'translate(2px, 2px)',
          transition: 'opacity var(--duration-fast)',
        }}
      >
        <line x1="9" y1="1" x2="1" y2="9" stroke={active ? 'var(--accent-blue)' : 'var(--text-ghost)'} strokeWidth="1" strokeLinecap="round" style={{ transition: 'stroke var(--duration-fast)' }} />
        <line x1="9" y1="4.5" x2="4.5" y2="9" stroke={active ? 'var(--accent-blue)' : 'var(--text-ghost)'} strokeWidth="1" strokeLinecap="round" style={{ transition: 'stroke var(--duration-fast)' }} />
        <line x1="9" y1="8" x2="8" y2="9" stroke={active ? 'var(--accent-blue)' : 'var(--text-ghost)'} strokeWidth="1" strokeLinecap="round" style={{ transition: 'stroke var(--duration-fast)' }} />
      </svg>
    </div>
  );
}
