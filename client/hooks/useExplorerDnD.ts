// Drag-and-drop geometry, hit-testing, and handlers for the file explorer.
// Extracted from ExplorerContent.tsx; logic unchanged. Owns the transient drop
// state (hover targets, dragging row) and exposes handlers the component wires
// onto the scroll container and each row.
import { useCallback, useState } from 'react';
import { apiFetch, withToken, readApiPayload, getApiError } from '../api.js';
import { type TreeNode, getParentPath } from '../utils/treeUtils.js';

const INTERNAL_DRAG_MIME = 'application/x-tboard-file-entry';

interface InternalDragPayload {
  path: string;
  name: string;
  isDirectory: boolean;
  parentPath: string;
}

// Where a background (non-row) drop lands: the selected directory, the selected
// file's parent, or the current root when nothing is selected.
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

// Pixel rect highlighting the directory (and its visible subtree) under the
// cursor while dragging.
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
  return withToken(`${window.location.origin}/api/files/download?path=${encodeURIComponent(filePath)}`);
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

export interface RowDragHandlers {
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void;
}

interface UseExplorerDnDParams {
  tree: TreeNode[];
  flatItems: TreeNode[];
  currentPath: string;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  setActionError: (err: string | null) => void;
  loadRoot: (
    path: string,
    nextSelectedPath?: string | null,
    options?: { preserveExpanded?: boolean }
  ) => Promise<void>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

export interface ExplorerDnD {
  dropTargetPath: string | null;
  rootDropActive: boolean;
  rootDropTargetPath: string | null;
  draggingPath: string | null;
  backgroundDropTarget: string;
  directoryDropBlock: { top: number; height: number } | null;
  handleRootDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  handleRootDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  handleRootDrop: (e: React.DragEvent<HTMLDivElement>) => Promise<void>;
  getRowHandlers: (node: TreeNode) => RowDragHandlers;
}

export function useExplorerDnD({
  tree,
  flatItems,
  currentPath,
  selectedPath,
  setSelectedPath,
  setActionError,
  loadRoot,
  scrollRef,
}: UseExplorerDnDParams): ExplorerDnD {
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const [rootDropTargetPath, setRootDropTargetPath] = useState<string | null>(null);
  const [draggingPath, setDraggingPath] = useState<string | null>(null);

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

      const res = await apiFetch('/api/files/move', {
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
        const res = await apiFetch('/api/files/upload', {
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
  }, [canDropInto, currentPath, loadRoot, setActionError]);

  const backgroundDropTarget = getBackgroundDropTarget(currentPath, selectedPath, tree);
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
  }, [backgroundDropTarget, flatItems, scrollRef]);

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
  }, [performDrop, resolvePointerDropTarget, setActionError]);

  // Built fresh per render (matching the original inline handlers) so the
  // dragLeave closure sees the current dropTargetPath.
  const getRowHandlers = (node: TreeNode): RowDragHandlers => {
    const rowDropTarget = getRowDropTarget(node);
    return {
      onDragStart: (e) => {
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
      },
      onDragEnd: () => {
        setDraggingPath(null);
        setDropTargetPath(null);
        setRootDropActive(false);
        setRootDropTargetPath(null);
      },
      onDragOver: (e) => {
        if (!canDropInto(rowDropTarget, e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = hasExternalFiles(e.dataTransfer) ? 'copy' : 'move';
        setDropTargetPath(rowDropTarget);
        setRootDropActive(false);
        setRootDropTargetPath(null);
      },
      onDragLeave: (e) => {
        const related = e.relatedTarget as Node | null;
        if (related && e.currentTarget.contains(related)) return;
        if (dropTargetPath === rowDropTarget) {
          setDropTargetPath(null);
        }
      },
      onDrop: async (e) => {
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
      },
    };
  };

  return {
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
  };
}
