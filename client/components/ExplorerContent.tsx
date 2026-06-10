import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch, withToken, readApiPayload, getApiError } from '../api.js';
import type { FileEntry } from '../types.js';
import ContextMenu, { type ContextMenuItem } from './ContextMenu.js';
import {
  type TreeNode,
  createTreeNodes,
  collectExpandedPaths,
  flattenTree,
  updateChildren,
} from '../utils/treeUtils.js';
import { useExplorerDnD } from '../hooks/useExplorerDnD.js';
import TreeRow from './TreeRow.js';

interface ExplorerContentProps {
  rootPath: string;
  isActive: boolean;
  onOpenFile: (filePath: string, fileName: string) => void;
  onNavigate?: (newRoot: string) => void;
  onSpawnHere?: (kind: 'terminal' | 'claude' | 'codex', cwd: string) => void;
}

interface MenuState {
  x: number;
  y: number;
  node: TreeNode;
}

// A floating name prompt for create/rename (inline-ish overlay near the row).
interface PromptState {
  x: number;
  y: number;
  title: string;
  value: string;
  onSubmit: (value: string) => void;
}

interface FetchResult {
  files: FileEntry[];
  resolvedPath: string;
}

interface LoadRootOptions {
  preserveExpanded?: boolean;
}

async function fetchDirectory(path: string, showHidden: boolean): Promise<FetchResult> {
  const endpoint = showHidden ? '/api/files/all' : '/api/files';
  const query = path === '~' ? '' : `?path=${encodeURIComponent(path)}`;
  const res = await apiFetch(`${endpoint}${query}`);
  const data = await readApiPayload(res);
  if (!res.ok) {
    throw new Error(getApiError(data, 'Failed to load directory'));
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid directory response');
  }
  return { files: data.files, resolvedPath: data.path };
}

async function hydrateExpandedNodes(
  nodes: TreeNode[],
  expandedPaths: Set<string>,
  showHidden: boolean
): Promise<TreeNode[]> {
  return await Promise.all(
    nodes.map(async (node) => {
      if (!node.entry.isDirectory || !expandedPaths.has(node.entry.path)) {
        return node;
      }

      const { files } = await fetchDirectory(node.entry.path, showHidden);
      const children = createTreeNodes(files, node.depth + 1);
      return {
        ...node,
        expanded: true,
        children: await hydrateExpandedNodes(children, expandedPaths, showHidden),
      };
    })
  );
}

export default function ExplorerContent({ rootPath, isActive, onOpenFile, onNavigate, onSpawnHere }: ExplorerContentProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeNode[]>([]);
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    return () => {
      if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
    };
  }, []);

  const loadRoot = useCallback(async (
    path: string,
    nextSelectedPath?: string | null,
    options?: LoadRootOptions
  ) => {
    setLoading(true);
    setError(null);
    try {
      const expandedPaths = options?.preserveExpanded
        ? new Set(collectExpandedPaths(treeRef.current))
        : new Set<string>();
      const { files, resolvedPath } = await fetchDirectory(path, showHidden);
      let nextTree = createTreeNodes(files, 0);
      if (expandedPaths.size > 0) {
        nextTree = await hydrateExpandedNodes(nextTree, expandedPaths, showHidden);
      }
      setTree(nextTree);
      setCurrentPath(resolvedPath);
      if (nextSelectedPath !== undefined) {
        setSelectedPath(nextSelectedPath);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [showHidden]);

  useEffect(() => {
    loadRoot(rootPath);
  }, [rootPath, loadRoot]);

  const toggleExpand = useCallback(async (nodePath: string) => {
    const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        if (node.entry.path === nodePath) {
          if (node.expanded) {
            return { ...node, expanded: false };
          }
          if (node.children === null) {
            fetchDirectory(nodePath, showHidden).then(({ files }) => {
              setTree((prev) => updateChildren(prev, nodePath, files));
            }).catch((err: unknown) => {
              setActionError(String(err));
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
  }, [showHidden]);

  const handleClick = useCallback((node: TreeNode) => {
    setActionError(null);
    setSelectedPath(node.entry.path);
    if (node.entry.isDirectory) {
      // Defer the expand toggle so a follow-up double-click (root change) can
      // cancel it; otherwise both fire and the row expands then immediately
      // reloads as the new root.
      if (expandTimerRef.current) clearTimeout(expandTimerRef.current);
      expandTimerRef.current = setTimeout(() => {
        expandTimerRef.current = null;
        toggleExpand(node.entry.path);
      }, 250);
    } else {
      onOpenFile(node.entry.path, node.entry.name);
    }
  }, [onOpenFile, toggleExpand]);

  const handleDoubleClick = useCallback((node: TreeNode) => {
    if (node.entry.isDirectory) {
      if (expandTimerRef.current) {
        clearTimeout(expandTimerRef.current);
        expandTimerRef.current = null;
      }
      loadRoot(node.entry.path, node.entry.path);
      onNavigate?.(node.entry.path);
    }
  }, [loadRoot, onNavigate]);

  const goUp = useCallback(() => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadRoot(parent, parent);
    onNavigate?.(parent);
  }, [currentPath, loadRoot, onNavigate]);

  const refresh = useCallback(() => {
    loadRoot(currentPath, selectedPath, { preserveExpanded: true });
  }, [currentPath, selectedPath, loadRoot]);

  const callFileOp = useCallback(async (endpoint: string, body: unknown, errLabel: string) => {
    setActionError(null);
    try {
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readApiPayload(res);
      if (!res.ok) throw new Error(getApiError(data, errLabel));
      refresh();
    } catch (err) {
      setActionError(String(err));
    }
  }, [refresh]);

  const openPrompt = useCallback((x: number, y: number, title: string, value: string, onSubmit: (v: string) => void) => {
    setPrompt({ x, y, title, value, onSubmit });
  }, []);

  const buildMenuItems = useCallback((node: TreeNode, x: number, y: number): ContextMenuItem[] => {
    const { path: p, isDirectory, name } = node.entry;
    const items: ContextMenuItem[] = [];
    if (isDirectory) {
      if (onSpawnHere) {
        items.push({ label: 'ここでターミナルを開く', onClick: () => onSpawnHere('terminal', p) });
        items.push({ label: 'ここで Claude を開く', onClick: () => onSpawnHere('claude', p) });
        items.push({ label: 'ここで Codex を開く', onClick: () => onSpawnHere('codex', p) });
      }
      items.push({
        label: '新規ファイル',
        dividerBefore: items.length > 0,
        onClick: () => openPrompt(x, y, '新規ファイル名', '', (v) =>
          callFileOp('/api/files/create', { path: `${p}/${v}` }, 'Failed to create file')),
      });
      items.push({
        label: '新規フォルダ',
        onClick: () => openPrompt(x, y, '新規フォルダ名', '', (v) =>
          callFileOp('/api/files/mkdir', { path: `${p}/${v}` }, 'Failed to create folder')),
      });
    } else {
      items.push({ label: '開く', onClick: () => onOpenFile(p, name) });
      items.push({
        label: 'ダウンロード',
        onClick: () => {
          const a = document.createElement('a');
          a.href = withToken(`/api/files/download?path=${encodeURIComponent(p)}`);
          a.download = name;
          a.click();
        },
      });
    }
    items.push({
      label: 'リネーム',
      dividerBefore: true,
      onClick: () => openPrompt(x, y, '新しい名前', name, (v) =>
        callFileOp('/api/files/rename', { path: p, newName: v }, 'Failed to rename')),
    });
    items.push({
      label: '削除',
      danger: true,
      onClick: () => {
        if (!window.confirm(`「${name}」を削除しますか?`)) return;
        callFileOp('/api/files/delete', { path: p, recursive: isDirectory }, 'Failed to delete');
      },
    });
    return items;
  }, [onSpawnHere, onOpenFile, openPrompt, callFileOp]);

  const flatItems = flattenTree(tree);
  const dnd = useExplorerDnD({
    tree,
    flatItems,
    currentPath,
    selectedPath,
    setSelectedPath,
    setActionError,
    loadRoot,
    scrollRef,
  });
  const {
    dropTargetPath,
    rootDropActive,
    rootDropTargetPath,
    draggingPath,
    backgroundDropTarget,
    directoryDropBlock,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
    getRowHandlers,
  } = dnd;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        background: 'transparent',
        color: 'var(--text-secondary)',
        fontSize: 12.5,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
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
          onClick={() => loadRoot(currentPath, selectedPath, { preserveExpanded: true })}
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
          onClick={() => setShowHidden((p) => !p)}
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

      {actionError && (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            color: 'var(--accent-red)',
            background: 'rgba(247, 118, 142, 0.08)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
          }}
        >
          {actionError}
        </div>
      )}

      <div
        ref={scrollRef}
        onDragOver={handleRootDragOver}
        onDragLeave={handleRootDragLeave}
        onDrop={handleRootDrop}
        title={rootDropActive ? `Drop into ${backgroundDropTarget}` : undefined}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '4px 0',
          background: rootDropActive ? 'rgba(122, 162, 247, 0.08)' : 'transparent',
          outline: rootDropActive ? '1px dashed rgba(122, 162, 247, 0.6)' : 'none',
          outlineOffset: -1,
          position: 'relative',
        }}
      >
        {directoryDropBlock && (
          <div
            style={{
              position: 'absolute',
              left: 6,
              right: 6,
              top: directoryDropBlock.top,
              height: directoryDropBlock.height,
              border: '1px dashed rgba(122, 162, 247, 0.8)',
              borderRadius: 8,
              background: 'rgba(122, 162, 247, 0.08)',
              boxSizing: 'border-box',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
        )}
        {rootDropActive && rootDropTargetPath === currentPath && (
          <div
            style={{
              margin: '6px 8px 8px',
              minHeight: 40,
              border: '1px dashed rgba(122, 162, 247, 0.75)',
              borderRadius: 8,
              background: 'rgba(122, 162, 247, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent-blue)',
              fontSize: 11,
              fontWeight: 600,
              pointerEvents: 'none',
            }}
          >
            Drop into {currentPath}
          </div>
        )}
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
          const isSelected = selectedPath === node.entry.path;
          const isDropTarget = dropTargetPath === node.entry.path;
          const isDragging = draggingPath === node.entry.path;
          const rowHandlers = getRowHandlers(node);

          return (
            <TreeRow
              key={node.entry.path}
              node={node}
              isActive={isActive}
              isSelected={isSelected}
              isDropTarget={isDropTarget}
              isDragging={isDragging}
              onDragStart={rowHandlers.onDragStart}
              onDragEnd={rowHandlers.onDragEnd}
              onDragOver={rowHandlers.onDragOver}
              onDragLeave={rowHandlers.onDragLeave}
              onDrop={rowHandlers.onDrop}
              onClick={() => handleClick(node)}
              onDoubleClick={() => handleDoubleClick(node)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelectedPath(node.entry.path);
                setMenu({ x: e.clientX, y: e.clientY, node });
              }}
            />
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
            Empty folder
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.node, menu.x, menu.y)}
          onClose={() => setMenu(null)}
        />
      )}

      {prompt && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            left: Math.min(prompt.x, window.innerWidth - 220),
            top: Math.min(prompt.y, window.innerHeight - 80),
            zIndex: 10002,
            width: 210,
            padding: 8,
            background: 'rgba(28, 29, 46, 0.98)',
            border: '1px solid rgba(122, 162, 247, 0.25)',
            borderRadius: 8,
            boxShadow: '0 10px 30px -8px rgba(0,0,0,0.7)',
          }}
        >
          <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginBottom: 5 }}>{prompt.title}</div>
          <input
            autoFocus
            value={prompt.value}
            onChange={(e) => setPrompt((p) => (p ? { ...p, value: e.target.value } : p))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                const v = prompt.value.trim();
                setPrompt(null);
                if (v) prompt.onSubmit(v);
              } else if (e.key === 'Escape') {
                setPrompt(null);
              }
            }}
            style={{
              width: '100%',
              height: 26,
              padding: '0 8px',
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 5,
              color: 'var(--text-secondary)',
              fontSize: 12,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>
      )}
    </div>
  );
}
