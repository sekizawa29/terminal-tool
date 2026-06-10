import { useState } from 'react';

interface RowActionProps {
  icon: React.ReactNode;
  hint: string;
  onClick: () => void;
  activeColor?: string;
}

// Small hover-highlighted icon button used in session and recent-dir rows.
// Stops click propagation so the row's own onClick does not also fire.
export function RowAction({ icon, hint, onClick, activeColor }: RowActionProps) {
  const [hover, setHover] = useState(false);
  const color = activeColor
    ? activeColor
    : hover
      ? 'var(--text-secondary)'
      : 'var(--text-tertiary)';
  return (
    <button
      type="button"
      title={hint}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 5,
        background: hover ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
        color,
        border: 'none',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'all 100ms',
      }}
    >
      {icon}
    </button>
  );
}
