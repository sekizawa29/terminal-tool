import type { TreeNode } from '../utils/treeUtils.js';

const FILE_ICONS: Record<string, { icon: string; color: string }> = {
  md: { icon: 'M', color: '#519aba' },
  mdx: { icon: 'M', color: '#519aba' },
  ts: { icon: 'TS', color: '#3178c6' },
  tsx: { icon: 'TX', color: '#3178c6' },
  js: { icon: 'JS', color: '#f0db4f' },
  jsx: { icon: 'JX', color: '#f0db4f' },
  json: { icon: '{}', color: '#cbcb41' },
  css: { icon: '#', color: '#56b6c2' },
  scss: { icon: 'S#', color: '#cd6799' },
  html: { icon: '<>', color: '#e34c26' },
  py: { icon: 'Py', color: '#3776ab' },
  rs: { icon: 'Rs', color: '#dea584' },
  go: { icon: 'Go', color: '#00add8' },
  yaml: { icon: 'Y', color: '#cb171e' },
  yml: { icon: 'Y', color: '#cb171e' },
  toml: { icon: 'T', color: '#9c4221' },
  sh: { icon: '$', color: '#89e051' },
  svg: { icon: '◇', color: '#ffb13b' },
  png: { icon: '◻', color: '#a074c4' },
  jpg: { icon: '◻', color: '#a074c4' },
  gif: { icon: '◻', color: '#a074c4' },
  txt: { icon: 'T', color: '#89898b' },
  env: { icon: '⚙', color: '#ecd53f' },
  lock: { icon: '🔒', color: '#89898b' },
};

function getFileIcon(ext: string): { icon: string; color: string } {
  return FILE_ICONS[ext] || { icon: '·', color: 'var(--text-ghost)' };
}

interface TreeRowProps {
  node: TreeNode;
  isActive: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  isDragging: boolean;
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  onClick: () => void;
  onDoubleClick: () => void;
}

// A single explorer row: indent guides, folder/file icon, name, and size. All
// drag/drop and click behavior is supplied by the parent as handlers.
export default function TreeRow({
  node,
  isActive,
  isSelected,
  isDropTarget,
  isDragging,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onClick,
  onDoubleClick,
}: TreeRowProps) {
  const isDir = node.entry.isDirectory;
  const iconInfo = isDir ? null : getFileIcon(node.entry.extension);
  const indent = 12 + node.depth * 16;

  return (
    <div
      data-explorer-row="true"
      data-entry-path={node.entry.path}
      data-entry-directory={node.entry.isDirectory ? 'true' : 'false'}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 24,
        paddingLeft: indent,
        paddingRight: 8,
        cursor: isActive ? 'pointer' : 'default',
        position: 'relative',
        background: isDropTarget
          ? 'rgba(122, 162, 247, 0.06)'
          : isSelected
          ? 'rgba(122, 162, 247, 0.08)'
          : 'transparent',
        transition: 'background 80ms, opacity 80ms',
        whiteSpace: 'nowrap',
        opacity: isDragging ? 0.45 : 1,
      }}
      onMouseEnter={(e) => {
        if (!isSelected && !isDropTarget) {
          e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
        }
      }}
      onMouseLeave={(e) => {
        if (!isSelected && !isDropTarget) {
          e.currentTarget.style.background = 'transparent';
        }
      }}
    >
      {Array.from({ length: node.depth }, (_, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: 12 + 8 + i * 16,
            top: 0,
            bottom: 0,
            width: 1,
            background: 'rgba(255, 255, 255, 0.06)',
          }}
        />
      ))}

      {isDir ? (
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          style={{
            flexShrink: 0,
            marginRight: 4,
            transform: node.expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 120ms ease',
          }}
        >
          <path
            d="M3 2l4 3-4 3"
            stroke="var(--text-ghost)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <span
          style={{
            flexShrink: 0,
            marginRight: 4,
            width: 10,
            textAlign: 'center',
          }}
        />
      )}

      {isDir ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          style={{ flexShrink: 0, marginRight: 6 }}
        >
          <path
            d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293L8.414 4.414A1 1 0 009.121 4.5H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z"
            fill={isDropTarget ? '#7dcfff' : node.expanded ? '#e0af68' : '#7aa2f7'}
            opacity={0.78}
          />
        </svg>
      ) : (
        <span
          style={{
            flexShrink: 0,
            marginRight: 6,
            fontSize: 8,
            fontWeight: 700,
            color: iconInfo?.color || 'var(--text-ghost)',
            width: 14,
            textAlign: 'center',
            letterSpacing: '-0.05em',
          }}
        >
          {iconInfo?.icon || '·'}
        </span>
      )}

      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          fontSize: 12,
          fontWeight: 400,
          color: '#fff',
          letterSpacing: '-0.01em',
        }}
      >
        {node.entry.name}
      </span>

      {!isDir && node.entry.size > 0 && (
        <span
          style={{
            fontSize: 9.5,
            color: 'var(--text-ghost)',
            flexShrink: 0,
            marginLeft: 8,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {node.entry.size < 1024
            ? `${node.entry.size}B`
            : node.entry.size < 1024 * 1024
            ? `${(node.entry.size / 1024).toFixed(1)}K`
            : `${(node.entry.size / (1024 * 1024)).toFixed(1)}M`}
        </span>
      )}
    </div>
  );
}
