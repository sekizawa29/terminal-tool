import { useEffect, useRef, useState } from 'react';
import { MIN_SCALE, MAX_SCALE } from '../hooks/useCanvas.js';

interface ZoomIndicatorProps {
  scale: number;
  setScale: (scale: number, anchorX?: number, anchorY?: number) => void;
}

const MIN_PCT = Math.round(MIN_SCALE * 100);
const MAX_PCT = Math.round(MAX_SCALE * 100);
const STEP_PCT = 10;

export default function ZoomIndicator({ scale, setScale }: ZoomIndicatorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const currentPct = Math.round(scale * 100);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = (raw: string) => {
    const n = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    if (!Number.isNaN(n)) {
      const clamped = Math.min(MAX_PCT, Math.max(MIN_PCT, n));
      setScale(clamped / 100);
    }
    setEditing(false);
  };

  const stepBy = (deltaPct: number) => {
    const next = Math.min(MAX_PCT, Math.max(MIN_PCT, currentPct + deltaPct));
    setScale(next / 100);
  };

  const btnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1,
    padding: 0,
    fontFamily: 'inherit',
  };

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 6px',
        background: 'var(--glass-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: 8,
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        zIndex: 100,
        userSelect: 'none',
        fontFamily: 'inherit',
      }}
    >
      <button
        type="button"
        onClick={() => stepBy(-STEP_PCT)}
        disabled={currentPct <= MIN_PCT}
        style={{ ...btnStyle, opacity: currentPct <= MIN_PCT ? 0.35 : 1 }}
        onMouseEnter={(e) => { if (currentPct > MIN_PCT) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        title="Zoom out (10%)"
      >
        −
      </button>

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          defaultValue={String(currentPct)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          style={{
            width: 46,
            textAlign: 'center',
            background: 'rgba(122, 162, 247, 0.10)',
            border: '1px solid var(--border-accent)',
            borderRadius: 4,
            color: 'var(--text-primary)',
            fontSize: 11.5,
            fontWeight: 600,
            padding: '3px 2px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(String(currentPct));
            setEditing(true);
          }}
          style={{
            minWidth: 46,
            height: 22,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary)',
            cursor: 'text',
            fontSize: 11.5,
            fontWeight: 600,
            padding: '0 6px',
            borderRadius: 4,
            fontFamily: 'inherit',
            letterSpacing: '0.02em',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="Click to edit zoom %"
        >
          {currentPct}%
        </button>
      )}

      <button
        type="button"
        onClick={() => stepBy(STEP_PCT)}
        disabled={currentPct >= MAX_PCT}
        style={{ ...btnStyle, opacity: currentPct >= MAX_PCT ? 0.35 : 1 }}
        onMouseEnter={(e) => { if (currentPct < MAX_PCT) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        title="Zoom in (10%)"
      >
        +
      </button>
    </div>
  );
}
