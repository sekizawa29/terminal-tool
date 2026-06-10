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
  const [confirming, setConfirming] = useState(false);

  const source = terminals.get(link.sourceId);
  const target = terminals.get(link.targetId);
  if (!source || !target) return null;

  const d = getLinkPath(source, target);

  // Attachment points
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;

  // Midpoint for the label / delete confirmation
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;
  const subName = target.title || 'sub';

  return (
    <g>
      {/* Wide hit area for hover/click — click opens a confirm popover (no
          instant delete, which was easy to trigger by accident) */}
      <path
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        style={{ pointerEvents: 'auto', cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          setConfirming(true);
        }}
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
      {/* Target arrow marker (drawn manually for hover reactivity) */}
      <polygon
        points={`${tx} ${ty}, ${tx - 12} ${ty - 6}, ${tx - 12} ${ty + 6}`}
        fill="#bb9af7"
        style={{
          filter: 'drop-shadow(0 0 4px rgba(187, 154, 247, 0.5))',
          transition: 'opacity 0.15s',
          opacity: hovered ? 1 : 0.8,
        }}
      />
      {/* Direction label on hover (MAIN → sub) */}
      {hovered && !confirming && (
        <g style={{ pointerEvents: 'none' }}>
          <rect
            x={mx - 62} y={my - 11} width={124} height={22} rx={6}
            fill="rgba(26,27,38,0.92)" stroke="rgba(125,207,255,0.35)" strokeWidth={1}
          />
          <text
            x={mx} y={my + 4}
            textAnchor="middle"
            fontSize={11}
            fill="#c0caf5"
            style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
          >
            MAIN → {subName.length > 12 ? `${subName.slice(0, 12)}…` : subName}
          </text>
        </g>
      )}
      {/* Click-to-confirm unlink popover */}
      {confirming && (
        <g style={{ pointerEvents: 'auto' }}>
          <rect
            x={mx - 62} y={my - 14} width={124} height={28} rx={7}
            fill="rgba(26,27,38,0.98)" stroke="rgba(122,162,247,0.3)" strokeWidth={1}
            style={{ filter: 'drop-shadow(0 0 6px rgba(0,0,0,0.5))' }}
          />
          <g style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setConfirming(false); removeLink(link.id); }}>
            <rect x={mx - 58} y={my - 10} width={66} height={20} rx={5} fill="rgba(247,118,142,0.18)" />
            <text x={mx - 25} y={my + 4} textAnchor="middle" fontSize={11} fill="var(--accent-red)" style={{ fontWeight: 600 }}>リンク解除</text>
          </g>
          <g style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setConfirming(false); }}>
            <rect x={mx + 10} y={my - 10} width={48} height={20} rx={5} fill="rgba(255,255,255,0.06)" />
            <text x={mx + 34} y={my + 4} textAnchor="middle" fontSize={11} fill="var(--text-secondary)">取消</text>
          </g>
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
      <polygon
        points={`${tx} ${ty}, ${tx - 10} ${ty - 5}, ${tx - 10} ${ty + 5}`}
        fill="#bb9af7"
        opacity={0.7}
      />
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
