// Recent/pinned working-directory helpers backed by the server's /api/dirs
// endpoints. Extracted from Sidebar.tsx; behavior unchanged.
import { apiFetch } from '../api.js';

export interface DirsState {
  recent: string[];
  pinned: string[];
}

export const EMPTY_DIRS_STATE: DirsState = { recent: [], pinned: [] };

export async function fetchDirsState(): Promise<DirsState | null> {
  try {
    const res = await apiFetch('/api/dirs');
    if (!res.ok) return null;
    const data = await res.json();
    return {
      recent: Array.isArray(data.recent) ? data.recent : [],
      pinned: Array.isArray(data.pinned) ? data.pinned : [],
    };
  } catch {
    return null;
  }
}

export async function pushRecentDir(cwd: string): Promise<DirsState | null> {
  try {
    const res = await apiFetch('/api/dirs/recent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function pinDir(cwd: string): Promise<DirsState | null> {
  try {
    const res = await apiFetch('/api/dirs/pinned', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function unpinDir(cwd: string): Promise<DirsState | null> {
  try {
    const res = await apiFetch('/api/dirs/pinned', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
