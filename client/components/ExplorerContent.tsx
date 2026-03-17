import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../types.js';

interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null; // null = not loaded yet
  expanded: boolean;
  depth: number;
}

interface ExplorerContentProps {
  rootPath: string;
  isActive: boolean;
  onOpenFile: (filePath: string, fileName: string) => void;
  onNavigate?: (newRoot: string) => void;
}

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

interface FetchResult {
  files: FileEntry[];
  resolvedPath: string;
}

async function fetchDirectory(path: string, showHidden: boolean): Promise<FetchResult> {
  const endpoint = showHidden ? '/api/files/all' : '/api/files';
  const query = path === '~' ? '' : `?path=${encodeURIComponent(path)}`;
  const res = await fetch(`${endpoint}${query}`);
  if (!res.ok) throw new Error('Failed to load directory');
  const data = await res.json();
  return { files: data.files, resolvedPath: data.path };
}

export default function ExplorerContent({ rootPath, isActive, onOpenFile, onNavigate }: ExplorerContentProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load root directory
  const loadRoot = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const { files, resolvedPath } = await fetchDirectory(path, showHidden);
      setTree(
        files.map((f) => ({
          entry: f,
          children: f.isDirectory ? null : [],
          expanded: false,
          depth: 0,
        }))
      );
      setCurrentPath(resolvedPath);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    loadRoot(rootPath);
  }, [rootPath, loadRoot]);

  // Toggle directory expand/collapse
  const toggleExpand = useCallback(
    async (nodePath: string) => {
      const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((node) => {
          if (node.entry.path === nodePath) {
            if (node.expanded) {
              return { ...node, expanded: false };
            }
            // Need to load children
            if (node.children === null) {
              // Return loading state, then fetch
              fetchDirectory(nodePath, showHidden).then(({ files }) => {
                setTree((prev) => updateChildren(prev, nodePath, files));
              });
              return { ...node, expanded: true, children: [] };
            }
            return { ...node, expanded: true };
          }
          if (node.children && node.children.length > 0) {
            return { ...node, children: updateNodes(node.children) };
          }
          return node;
        });

      setTree((prev) => updateNodes(prev));
    },
    [showHidden]
  );

  const updateChildren = (nodes: TreeNode[], parentPath: string, files: FileEntry[]): TreeNode[] =>
    nodes.map((node) => {
      if (node.entry.path === parentPath) {
        return {
          ...node,
          children: files.map((f) => ({
            entry: f,
            children: f.isDirectory ? null : [],
            expanded: false,
            depth: node.depth + 1,
          })),
        };
      }
      if (node.children && node.children.length > 0) {
        return { ...node, children: updateChildren(node.children, parentPath, files) };
      }
      return node;
    });

  const handleClick = useCallback(
    (node: TreeNode) => {
      if (node.entry.isDirectory) {
        toggleExpand(node.entry.path);
      } else {
        setSelectedPath(node.entry.path);
        onOpenFile(node.entry.path, node.entry.name);
      }
    },
    [toggleExpand, onOpenFile]
  );

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      if (node.entry.isDirectory) {
        loadRoot(node.entry.path);
        onNavigate?.(node.entry.path);
      }
    },
    [loadRoot, onNavigate]
  );

  // Navigate up
  const goUp = useCallback(() => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadRoot(parent);
    onNavigate?.(parent);
  }, [currentPath, loadRoot, onNavigate]);

  // Flatten tree for rendering
  const flattenTree = (nodes: TreeNode[]): TreeNode[] => {
    const result: TreeNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (node.expanded && node.children && node.children.length > 0) {
        result.push(...flattenTree(node.children));
      }
    }
    return result;
  };

  const flatItems = flattenTree(tree);

  // Shorten path for display
  const displayPath = currentPath;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'rgba(22, 22, 30, 0.75)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        color: 'var(--text-secondary)',
        fontSize: 12.5,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '4px 8px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
          background: 'transparent',
          flexShrink: 0,
          minHeight: 30,
        }}
      >
        <button
          onClick={goUp}
          title="Go up"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            borderRadius: 4,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 12V4M4 7l4-4 4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={() => loadRoot(currentPath)}
          title="Refresh"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            borderRadius: 4,
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'none';
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v4h-4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          onClick={() => {
            setShowHidden((p) => !p);
            // Reload will happen via useEffect since showHidden triggers loadRoot change
          }}
          title={showHidden ? 'Hide dotfiles' : 'Show dotfiles'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            background: showHidden ? 'rgba(122, 162, 247, 0.15)' : 'none',
            border: 'none',
            color: showHidden ? 'var(--accent-blue)' : 'var(--text-tertiary)',
            cursor: 'pointer',
            borderRadius: 4,
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 700,
          }}
          onMouseEnter={(e) => {
            if (!showHidden) e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
          }}
          onMouseLeave={(e) => {
            if (!showHidden) e.currentTarget.style.background = 'none';
          }}
        >
          .*
        </button>
        <div
          style={{
            flex: 1,
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left',
          }}
        >
          <bdi>{currentPath}</bdi>
        </div>
      </div>

      {/* File tree */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '4px 0',
        }}
      >
        {loading && tree.length === 0 && (
          <div
            style={{
              padding: '20px',
              textAlign: 'center',
              color: 'var(--text-ghost)',
              fontSize: 11,
            }}
          >
            Loading...
          </div>
        )}
        {error && (
          <div
            style={{
              padding: '12px',
              color: 'var(--accent-red)',
              fontSize: 11,
            }}
          >
            {error}
          </div>
        )}
        {flatItems.map((node) => {
          const isDir = node.entry.isDirectory;
          const isSelected = selectedPath === node.entry.path;
          const iconInfo = isDir ? null : getFileIcon(node.entry.extension);
          const indent = 12 + node.depth * 16;

          return (
            <div
              key={node.entry.path}
              onClick={() => handleClick(node)}
              onDoubleClick={() => handleDoubleClick(node)}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: 24,
                paddingLeft: indent,
                paddingRight: 8,
                cursor: 'pointer',
                position: 'relative',
                background: isSelected
                  ? 'rgba(122, 162, 247, 0.08)'
                  : 'transparent',
                transition: 'background 80ms',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => {
                if (!isSelected)
                  e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
              }}
              onMouseLeave={(e) => {
                if (!isSelected)
                  e.currentTarget.style.background = 'transparent';
              }}
            >
              {/* Indent guide lines */}
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

              {/* Chevron / file icon */}
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

              {/* Folder / file icon */}
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
                    fill={node.expanded ? '#e0af68' : '#7aa2f7'}
                    opacity={0.7}
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

              {/* Name */}
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  fontSize: 12,
                  fontWeight: isDir ? 600 : 400,
                  color: '#fff',
                  letterSpacing: '-0.01em',
                }}
              >
                {node.entry.name}
              </span>

              {/* Size for files */}
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
        })}
        {!loading && !error && flatItems.length === 0 && (
          <div
            style={{
              padding: '20px',
              textAlign: 'center',
              color: 'var(--text-ghost)',
              fontSize: 11,
            }}
          >
            Empty directory
          </div>
        )}
      </div>
    </div>
  );
}
