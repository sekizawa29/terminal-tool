import { useState } from 'react';
import { StarIcon, PinIcon, ClaudeIcon, CodexIcon, AgyIcon, GrokIcon, TerminalIcon } from '../icons.js';
import { RowAction } from './RowAction.js';

interface RecentDirItemProps {
  cwd: string;
  pinned: boolean;
  onOpenTerminal: () => void;
  onOpenClaude: () => void;
  onOpenCodex: () => void;
  onOpenAgy: () => void;
  onOpenGrok: () => void;
  onTogglePin: () => void;
}

function shortDirLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

// A recent or pinned working directory; clicking opens a terminal there, the
// row actions open Claude/Codex/Terminal or toggle the pin.
export function RecentDirItem({ cwd, pinned, onOpenTerminal, onOpenClaude, onOpenCodex, onOpenAgy, onOpenGrok, onTogglePin }: RecentDirItemProps) {
  const [hover, setHover] = useState(false);
  const name = shortDirLabel(cwd);
  return (
    <div
      onClick={onOpenTerminal}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={cwd}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        borderRadius: 7,
        cursor: 'pointer',
        background: hover ? 'rgba(255, 255, 255, 0.035)' : 'transparent',
        transition: 'background 120ms',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          color: pinned ? 'var(--accent-yellow)' : 'var(--text-ghost)',
        }}
      >
        <StarIcon filled={pinned} />
      </span>
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
            color: 'var(--text-primary)',
            fontWeight: 500,
            fontSize: 12,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        <span
          style={{
            color: 'var(--text-ghost)',
            fontSize: 10,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {cwd}
        </span>
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          opacity: hover ? 1 : 0.35,
          transition: 'opacity 120ms',
          flexShrink: 0,
        }}
      >
        <RowAction
          icon={<PinIcon filled={pinned} />}
          hint={pinned ? 'ピン留めを解除' : 'ピン留めする'}
          onClick={onTogglePin}
          activeColor={pinned ? 'var(--accent-yellow)' : undefined}
        />
        <RowAction icon={<ClaudeIcon />} hint="このディレクトリで Claude を開く" onClick={onOpenClaude} />
        <RowAction icon={<CodexIcon />} hint="このディレクトリで Codex を開く" onClick={onOpenCodex} />
        <RowAction icon={<AgyIcon />} hint="このディレクトリで Antigravity を開く" onClick={onOpenAgy} />
        <RowAction icon={<GrokIcon />} hint="このディレクトリで Grok を開く" onClick={onOpenGrok} />
        <RowAction icon={<TerminalIcon />} hint="このディレクトリで Terminal を開く" onClick={onOpenTerminal} />
      </div>
    </div>
  );
}
