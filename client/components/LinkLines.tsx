import { useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import type { TerminalLink, TerminalWindow } from '../types.js';

function getLinkPath(source: TerminalWindow, target: TerminalWindow): string {
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;
  const dx = Math.abs(tx - sx);
  const cp = Math.max(100, dx * 0.4);
  return `M ${sx} ${sy} C ${sx + cp} ${sy}, ${tx - cp} ${ty}, ${tx} ${ty}`;
}

function LinkLine({ link }: { link: TerminalLink }) {
  const terminals = useTerminalStore((s) => s.terminals);
  const removeLink = useTerminalStore((s) => s.removeLink);
  const [hovered, setHovered] = useState(false);

  const source = terminals.get(link.sourceId);
  const target = terminals.get(link.targetId);
  if (!source || !target) return null;

  const d = getLinkPath(source, target);

  // Attachment points
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;

  // Midpoint for delete button
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;

  return (
    <g>
      {/* Wide hit area for hover/click */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => removeLink(link.id)}
      />
      {/* Visible bezier curve */}
      <path
        d={d}
        fill="none"
        stroke="url(#link-gradient)"
        strokeWidth={hovered ? 2.5 : 1.8}
        strokeDasharray="8 4"
        className="link-flow"
        style={{
          filter: hovered
            ? 'drop-shadow(0 0 8px rgba(125, 207, 255, 0.5))'
            : 'drop-shadow(0 0 3px rgba(125, 207, 255, 0.15))',
          opacity: hovered ? 1 : 0.6,
          transition: 'opacity 0.2s, stroke-width 0.2s, filter 0.2s',
        }}
      />
      {/* Source attachment dot */}
      <circle
        cx={sx}
        cy={sy}
        r={hovered ? 5 : 4}
        fill="#7dcfff"
        style={{
          filter: 'drop-shadow(0 0 4px rgba(125, 207, 255, 0.5))',
          transition: 'r 0.15s',
        }}
      />
      {/* Target attachment dot */}
      <circle
        cx={tx}
        cy={ty}
        r={hovered ? 5 : 4}
        fill="#bb9af7"
        style={{
          filter: 'drop-shadow(0 0 4px rgba(187, 154, 247, 0.5))',
          transition: 'r 0.15s',
        }}
      />
      {/* Delete button on hover */}
      {hovered && (
        <g
          style={{ cursor: 'pointer', pointerEvents: 'auto' }}
          onClick={(e) => {
            e.stopPropagation();
            removeLink(link.id);
          }}
        >
          <circle
            cx={mx}
            cy={my}
            r={11}
            fill="var(--bg-elevated)"
            stroke="var(--accent-red)"
            strokeWidth={1.5}
            style={{ filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.4))' }}
          />
          <path
            d={`M ${mx - 3.5} ${my - 3.5} L ${mx + 3.5} ${my + 3.5} M ${mx + 3.5} ${my - 3.5} L ${mx - 3.5} ${my + 3.5}`}
            stroke="var(--accent-red)"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </g>
      )}
    </g>
  );
}

function DragLine() {
  const terminals = useTerminalStore((s) => s.terminals);
  const linkDrag = useTerminalStore((s) => s.linkDrag);

  if (!linkDrag.active || !linkDrag.sourceId) return null;

  const source = terminals.get(linkDrag.sourceId);
  if (!source) return null;

  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = linkDrag.mouseX;
  const ty = linkDrag.mouseY;
  const dx = Math.abs(tx - sx);
  const cp = Math.max(60, dx * 0.3);
  const d = `M ${sx} ${sy} C ${sx + cp} ${sy}, ${tx - cp} ${ty}, ${tx} ${ty}`;

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke="url(#link-gradient)"
        strokeWidth={2}
        strokeDasharray="6 4"
        className="link-flow"
        style={{
          opacity: 0.5,
          filter: 'drop-shadow(0 0 4px rgba(125, 207, 255, 0.3))',
        }}
      />
      <circle
        cx={sx}
        cy={sy}
        r={5}
        fill="#7dcfff"
        style={{ filter: 'drop-shadow(0 0 4px rgba(125, 207, 255, 0.5))' }}
      />
      <circle cx={tx} cy={ty} r={4} fill="#bb9af7" opacity={0.7} />
    </g>
  );
}

export default function LinkLines() {
  const links = useTerminalStore((s) => s.links);
  const linkDragActive = useTerminalStore((s) => s.linkDrag.active);

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 1,
        height: 1,
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      <defs>
        <linearGradient id="link-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#7dcfff" />
          <stop offset="100%" stopColor="#bb9af7" />
        </linearGradient>
      </defs>
      {links.map((link) => (
        <LinkLine key={link.id} link={link} />
      ))}
      {linkDragActive && <DragLine />}
    </svg>
  );
}
