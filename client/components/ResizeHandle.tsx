import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  onResize: (dx: number, dy: number) => void;
  onResizeStart?: () => void;
  onResizeEnd: () => void;
  getScale: () => number;
}

export default function ResizeHandle({ onResize, onResizeStart, onResizeEnd, getScale }: ResizeHandleProps) {
  const dragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const cleanupRef = useRef<(() => void) | null>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Detach in-flight resize listeners if this handle unmounts mid-resize.
  useEffect(() => () => { cleanupRef.current?.(); }, []);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragging.current = true;
      setIsDragging(true);
      startPos.current = { x: e.clientX, y: e.clientY };
      onResizeStart?.();

      const onMouseMove = (e: MouseEvent) => {
        if (!dragging.current) return;
        const scale = getScale();
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
        cleanupRef.current = null;
        onResizeEnd();
      };

      cleanupRef.current = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [onResize, onResizeStart, onResizeEnd, getScale]
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
