import { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  dividerBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

// Fixed-position popover menu. Closes on outside click, Esc, or item selection.
// Clamps itself to stay within the viewport.
export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.x,
        top: pos.y,
        zIndex: 10001,
        minWidth: 168,
        padding: 4,
        background: 'rgba(28, 29, 46, 0.98)',
        border: '1px solid rgba(122, 162, 247, 0.2)',
        borderRadius: 8,
        boxShadow: '0 10px 30px -8px rgba(0,0,0,0.7)',
        backdropFilter: 'blur(10px)',
      }}
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.dividerBefore && (
            <div style={{ height: 1, background: 'var(--border-hair)', margin: '4px 6px' }} />
          )}
          <button
            type="button"
            onClick={() => {
              onClose();
              item.onClick();
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '6px 10px',
              border: 'none',
              borderRadius: 5,
              background: 'transparent',
              color: item.danger ? 'var(--accent-red)' : 'var(--text-secondary)',
              fontSize: 12,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = item.danger
                ? 'rgba(247, 118, 142, 0.12)'
                : 'rgba(255,255,255,0.06)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
