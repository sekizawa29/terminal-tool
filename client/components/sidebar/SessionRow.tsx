import { useState } from 'react';
import { ClaudeIcon, CodexIcon, CopyIcon } from '../icons.js';
import { RowAction } from './RowAction.js';

const XIcon = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const WindowsBadge = () => (
  <span
    style={{
      fontSize: 9,
      fontWeight: 700,
      color: '#4ea3ff',
      background: 'rgba(78, 163, 255, 0.14)',
      padding: '1px 4px',
      borderRadius: 3,
      letterSpacing: '0.04em',
      lineHeight: '13px',
      flexShrink: 0,
    }}
  >
    WIN
  </span>
);

interface SessionRowProps {
  active: boolean;
  dotColor: string;
  dotGlow?: string;
  pulsing: boolean;
  windows: boolean;
  title: string;
  subtitle?: string;
  attention?: boolean;
  onClick: () => void;
  onClaude: () => void;
  onCodex: () => void;
  onCopy: () => void;
  onClose: () => void;
}

// A single live session in the sessions list: status dot, title, an optional
// cwd/process subtitle, and row actions to spawn Claude/Codex, duplicate, or
// close.
export function SessionRow({
  active,
  dotColor,
  dotGlow,
  pulsing,
  windows,
  title,
  subtitle,
  attention,
  onClick,
  onClaude,
  onCodex,
  onCopy,
  onClose,
}: SessionRowProps) {
  const [hover, setHover] = useState(false);
  const bg = active
    ? 'var(--accent-soft)'
    : hover
      ? 'rgba(255, 255, 255, 0.035)'
      : 'transparent';
  const actionsOpacity = hover || active ? 1 : 0.35;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        borderRadius: 7,
        cursor: 'pointer',
        background: bg,
        transition: 'background 120ms',
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: dotGlow,
          flexShrink: 0,
          animation: pulsing ? 'statusPulse 2s ease-in-out infinite' : undefined,
        }}
      />
      {windows && <WindowsBadge />}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </span>
        {subtitle && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-ghost)',
              fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {subtitle}
          </span>
        )}
      </span>
      {attention && (
        <span
          title="完了/入力待ち"
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--accent-yellow)',
            boxShadow: '0 0 6px rgba(224, 175, 104, 0.7)',
            flexShrink: 0,
            animation: 'statusPulse 2s ease-in-out infinite',
          }}
        />
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          opacity: actionsOpacity,
          transition: 'opacity 120ms',
          flexShrink: 0,
        }}
      >
        <RowAction icon={<ClaudeIcon />} hint="Open Claude here" onClick={onClaude} />
        <RowAction icon={<CodexIcon />} hint="Open Codex here" onClick={onCodex} />
        <RowAction icon={<CopyIcon />} hint="Duplicate" onClick={onCopy} />
        <RowAction icon={<XIcon />} hint="閉じる" onClick={onClose} activeColor="var(--accent-red)" />
      </div>
    </div>
  );
}
