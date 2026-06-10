// Pure tree helpers for the file explorer: building nodes, tracking expand
// state, flattening for render, and inserting fetched children. Extracted from
// ExplorerContent.tsx; logic unchanged.
import type { FileEntry } from '../types.js';

export interface TreeNode {
  entry: FileEntry;
  children: TreeNode[] | null;
  expanded: boolean;
  depth: number;
}

export function getParentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

export function createTreeNodes(files: FileEntry[], depth: number): TreeNode[] {
  return files.map((file) => ({
    entry: file,
    children: file.isDirectory ? null : [],
    expanded: false,
    depth,
  }));
}

export function collectExpandedPaths(nodes: TreeNode[]): string[] {
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

// Depth-first list of visible rows (a node's children only when expanded).
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.expanded && node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

// Replace the children of the node at parentPath with freshly-fetched entries.
export function updateChildren(nodes: TreeNode[], parentPath: string, files: FileEntry[]): TreeNode[] {
  return nodes.map((node) => {
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
}
