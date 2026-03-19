import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEntry } from '../types.js';

interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null;
  expanded: boolean;
  depth: number;
}

interface ExplorerContentProps {
  rootPath: string;
  isActive: boolean;
  onOpenFile: (filePath: string, fileName: string) => void;
  onNavigate?: (newRoot: string) => void;
}

interface FetchResult {
  files: FileEntry[];
  resolvedPath: string;
}

interface InternalDragPayload {
  path: string;
  name: string;
  isDirectory: boolean;
  parentPath: string;
}

interface LoadRootOptions {
  preserveExpanded?: boolean;
}

const INTERNAL_DRAG_MIME = 'application/x-tboard-file-entry';

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

function getParentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

function getBackgroundDropTarget(currentPath: string, selectedPath: string | null, nodes: TreeNode[]): string {
  if (!selectedPath) return currentPath;

  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.entry.path === selectedPath) {
      return node.entry.isDirectory ? node.entry.path : getParentPath(node.entry.path);
    }
    if (node.children && node.children.length > 0) {
      stack.unshift(...node.children);
    }
  }

  return getParentPath(selectedPath);
}

function getRowDropTarget(node: TreeNode): string {
  return node.entry.isDirectory ? node.entry.path : getParentPath(node.entry.path);
}

function getVisibleDirectoryBlock(
  nodes: TreeNode[],
  targetPath: string | null
): { top: number; height: number } | null {
  if (!targetPath) return null;

  const startIndex = nodes.findIndex((node) => node.entry.path === targetPath && node.entry.isDirectory);
  if (startIndex === -1) return null;

  const targetDepth = nodes[startIndex].depth;
  let endIndex = nodes.length;
  for (let i = startIndex + 1; i < nodes.length; i++) {
    if (nodes[i].depth <= targetDepth) {
      endIndex = i;
      break;
    }
  }

  return {
    top: 4 + startIndex * 24,
    height: Math.max(24, (endIndex - startIndex) * 24),
  };
}

function getElementDropTarget(element: Element | null): string | null {
  const row = element?.closest('[data-explorer-row="true"]');
  if (!(row instanceof HTMLElement)) return null;

  const entryPath = row.dataset.entryPath;
  const isDirectory = row.dataset.entryDirectory === 'true';
  if (!entryPath) return null;
  return isDirectory ? entryPath : getParentPath(entryPath);
}

function isSameOrDescendantPath(parentPath: string, childPath: string): boolean {
  const normalizedParent = parentPath.endsWith('/') ? parentPath : `${parentPath}/`;
  return childPath === parentPath || childPath.startsWith(normalizedParent);
}

function hasExternalFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files');
}

function parseInternalDragData(dataTransfer: DataTransfer): InternalDragPayload | null {
  const raw = dataTransfer.getData(INTERNAL_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InternalDragPayload;
  } catch {
    return null;
  }
}

function getDownloadUrl(filePath: string): string {
  return `${window.location.origin}/api/files/download?path=${encodeURIComponent(filePath)}`;
}

async function readApiPayload(res: Response): Promise<unknown> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return await res.json();
  }
  return await res.text();
}

function getApiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  if (typeof payload === 'string' && payload.trim()) {
    return payload.slice(0, 200);
  }
  return fallback;
}

async function readFileAsBase64(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

async function fetchDirectory(path: string, showHidden: boolean): Promise<FetchResult> {
  const endpoint = showHidden ? '/api/files/all' : '/api/files';
  const query = path === '~' ? '' : `?path=${encodeURIComponent(path)}`;
  const res = await fetch(`${endpoint}${query}`);
  const data = await readApiPayload(res);
  if (!res.ok) {
    throw new Error(getApiError(data, 'Failed to load directory'));
  }
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid directory response');
  }
  return { files: data.files, resolvedPath: data.path };
}

function createTreeNodes(files: FileEntry[], depth: number): TreeNode[] {
  return files.map((file) => ({
    entry: file,
    children: file.isDirectory ? null : [],
    expanded: false,
    depth,
  }));
}

function collectExpandedPaths(nodes: TreeNode[]): string[] {
  const expanded: string[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (node.expanded && node.entry.isDirectory) {
      expanded.push(node.entry.path);
    }
    if (node.children && node.children.length > 0) {
      stack.unshift(...node.children);
    }
  }
  return expanded;
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

export default function ExplorerContent({ rootPath, isActive, onOpenFile, onNavigate }: ExplorerContentProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(rootPath);
  const [showHidden, setShowHidden] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [rootDropTargetPath, setRootDropTargetPath] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<TreeNode[]>([]);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

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

  const updateChildren = useCallback((nodes: TreeNode[], parentPath: string, files: FileEntry[]): TreeNode[] =>
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
    }), []);

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
  }, [showHidden, updateChildren]);

  const handleClick = useCallback((node: TreeNode) => {
    setActionError(null);
    if (node.entry.isDirectory) {
      setSelectedPath(node.entry.path);
      toggleExpand(node.entry.path);
    } else {
      setSelectedPath(node.entry.path);
      onOpenFile(node.entry.path, node.entry.name);
    }
  }, [onOpenFile, toggleExpand]);

  const handleDoubleClick = useCallback((node: TreeNode) => {
    if (node.entry.isDirectory) {
      loadRoot(node.entry.path, node.entry.path);
      onNavigate?.(node.entry.path);
    }
  }, [loadRoot, onNavigate]);

  const goUp = useCallback(() => {
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
    loadRoot(parent, parent);
    onNavigate?.(parent);
  }, [currentPath, loadRoot, onNavigate]);

  const flattenTree = useCallback((nodes: TreeNode[]): TreeNode[] => {
    const result: TreeNode[] = [];
    for (const node of nodes) {
      result.push(node);
      if (node.expanded && node.children && node.children.length > 0) {
        result.push(...flattenTree(node.children));
      }
    }
    return result;
  }, []);

  const canDropInto = useCallback((targetDir: string, dataTransfer: DataTransfer): boolean => {
    if (hasExternalFiles(dataTransfer)) {
      return Array.from(dataTransfer.files).every((file) => file.type !== '' || file.size >= 0);
    }

    const payload = parseInternalDragData(dataTransfer);
    if (!payload) return false;
    if (payload.path === targetDir) return false;
    if (payload.parentPath === targetDir) return false;
    if (payload.isDirectory && isSameOrDescendantPath(payload.path, targetDir)) return false;
    return true;
  }, []);

  const performDrop = useCallback(async (targetDir: string, dataTransfer: DataTransfer) => {
    setActionError(null);
    const internalPayload = parseInternalDragData(dataTransfer);
    const externalFiles = Array.from(dataTransfer.files);

    if (internalPayload) {
      if (!canDropInto(targetDir, dataTransfer)) return;

      const res = await fetch('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourcePath: internalPayload.path, targetDir }),
      });
      const data = await readApiPayload(res);
      if (!res.ok) {
        throw new Error(getApiError(data, `Failed to move item (HTTP ${res.status})`));
      }
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid move response');
      }
      await loadRoot(currentPath, data.path || internalPayload.path, { preserveExpanded: true });
      return;
    }

    if (externalFiles.length > 0) {
      let lastPath: string | null = null;
      for (const file of externalFiles) {
        const data = await readFileAsBase64(file);
        const res = await fetch('/api/files/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, data, targetDir }),
        });
        const body = await readApiPayload(res);
        if (!res.ok) {
          throw new Error(getApiError(body, `Failed to upload ${file.name} (HTTP ${res.status})`));
        }
        if (!body || typeof body !== 'object') {
          throw new Error(`Invalid upload response for ${file.name}`);
        }
        lastPath = body.path || null;
      }
      await loadRoot(currentPath, lastPath, { preserveExpanded: true });
    }
  }, [canDropInto, currentPath, loadRoot]);

  const backgroundDropTarget = getBackgroundDropTarget(currentPath, selectedPath, tree);
  const flatItems = flattenTree(tree);
  const directoryDropBlock = getVisibleDirectoryBlock(flatItems, dropTargetPath);
  const resolveListDropTarget = useCallback((clientY: number): string => {
    const container = scrollRef.current;
    if (!container || flatItems.length === 0) {
      return backgroundDropTarget;
    }

    const rect = container.getBoundingClientRect();
    const contentY = clientY - rect.top + container.scrollTop - 4;
    const rowIndex = Math.floor(contentY / 24);
    if (rowIndex >= 0 && rowIndex < flatItems.length) {
      return getRowDropTarget(flatItems[rowIndex]);
    }

    return backgroundDropTarget;
  }, [backgroundDropTarget, flatItems]);
  const resolvePointerDropTarget = useCallback((clientX: number, clientY: number): string => {
    const hitTarget = getElementDropTarget(document.elementFromPoint(clientX, clientY));
    if (hitTarget) return hitTarget;
    return resolveListDropTarget(clientY);
  }, [resolveListDropTarget]);

  const handleRootDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const targetDir = resolvePointerDropTarget(e.clientX, e.clientY);
    if (!canDropInto(targetDir, e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = hasExternalFiles(e.dataTransfer) ? 'copy' : 'move';
    setRootDropActive(true);
    setRootDropTargetPath(targetDir);
    setDropTargetPath(null);
  }, [canDropInto, resolvePointerDropTarget]);

  const handleRootDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null;
    if (related && e.currentTarget.contains(related)) return;
    setRootDropActive(false);
    setRootDropTargetPath(null);
  }, []);

  const handleRootDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setRootDropActive(false);
    setRootDropTargetPath(null);
    setDropTargetPath(null);
    setDraggingPath(null);
    try {
      await performDrop(resolvePointerDropTarget(e.clientX, e.clientY), e.dataTransfer);
    } catch (err) {
      setActionError(String(err));
    }
  }, [performDrop, resolvePointerDropTarget]);

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
          const isDir = node.entry.isDirectory;
          const rowDropTarget = getRowDropTarget(node);
          const isSelected = selectedPath === node.entry.path;
          const isDropTarget = dropTargetPath === node.entry.path;
          const iconInfo = isDir ? null : getFileIcon(node.entry.extension);
          const indent = 12 + node.depth * 16;
          const isDragging = draggingPath === node.entry.path;

          const handleNodeDragOver = (e: React.DragEvent<HTMLDivElement>) => {
            if (!canDropInto(rowDropTarget, e.dataTransfer)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = hasExternalFiles(e.dataTransfer) ? 'copy' : 'move';
            setDropTargetPath(rowDropTarget);
            setRootDropActive(false);
            setRootDropTargetPath(null);
          };

          const handleNodeDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
            const related = e.relatedTarget as Node | null;
            if (related && e.currentTarget.contains(related)) return;
            if (dropTargetPath === rowDropTarget) {
              setDropTargetPath(null);
            }
          };

          const handleNodeDrop = async (e: React.DragEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();
            setDropTargetPath(null);
            setRootDropActive(false);
            setRootDropTargetPath(null);
            setDraggingPath(null);
            try {
              await performDrop(rowDropTarget, e.dataTransfer);
            } catch (err) {
              setActionError(String(err));
            }
          };

          return (
            <div
              key={node.entry.path}
              data-explorer-row="true"
              data-entry-path={node.entry.path}
              data-entry-directory={node.entry.isDirectory ? 'true' : 'false'}
              draggable
              onDragStart={(e) => {
                setDraggingPath(node.entry.path);
                const payload: InternalDragPayload = {
                  path: node.entry.path,
                  name: node.entry.name,
                  isDirectory: node.entry.isDirectory,
                  parentPath: getParentPath(node.entry.path),
                };
                e.dataTransfer.setData(INTERNAL_DRAG_MIME, JSON.stringify(payload));
                if (!node.entry.isDirectory) {
                  const downloadUrl = getDownloadUrl(node.entry.path);
                  e.dataTransfer.setData('DownloadURL', `application/octet-stream:${node.entry.name}:${downloadUrl}`);
                  e.dataTransfer.setData('text/uri-list', downloadUrl);
                  e.dataTransfer.setData('text/plain', node.entry.path);
                }
                e.dataTransfer.effectAllowed = node.entry.isDirectory ? 'move' : 'copyMove';
                setSelectedPath(node.entry.path);
              }}
              onDragEnd={() => {
                setDraggingPath(null);
                setDropTargetPath(null);
                setRootDropActive(false);
                setRootDropTargetPath(null);
              }}
              onDragOver={handleNodeDragOver}
              onDragLeave={handleNodeDragLeave}
              onDrop={handleNodeDrop}
              onClick={() => handleClick(node)}
              onDoubleClick={() => handleDoubleClick(node)}
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
    </div>
  );
}
