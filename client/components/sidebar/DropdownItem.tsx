import { useState } from 'react';

interface DropdownItemProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}

// A labelled row in the "add window" dropdown.
export function DropdownItem({ icon, label, hint, onClick }: DropdownItemProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '7px 10px',
        background: hover ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
        border: 'none',
        borderRadius: 6,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12,
        transition: 'background 100ms',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, color: 'var(--text-tertiary)' }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-ghost)',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          letterSpacing: '0.04em',
        }}
      >
        {hint}
      </span>
    </button>
  );
}
