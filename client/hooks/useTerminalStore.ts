import { create } from 'zustand';
import { apiFetch } from '../api.js';
import type { TerminalWindow, TerminalLink, SessionStatus, AttentionInfo } from '../types.js';
import { type DirsState, EMPTY_DIRS_STATE } from '../api/dirsApi.js';

const LAYOUT_KEY = 'terminal-board-layout';
const LINKS_KEY = 'terminal-board-links';
// Bump when the persisted shape changes incompatibly. v1 was a bare array; v2
// wraps it as { version, items } so future migrations have a hook.
const SCHEMA_VERSION = 2;

interface SavedLayout {
  sessionId: string;
  type?: 'terminal' | 'browser' | 'explorer' | 'editor' | 'memo';
  url?: string;
  explorerRoot?: string;
  filePath?: string;
  memoText?: string;
  cwd?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

interface SavedLink {
  sourceSessionId: string;
  targetSessionId: string;
}

// Read a versioned { version, items } blob, migrating the legacy bare-array form
// (treated as v1) transparently. Unknown future versions yield [].
function loadVersioned<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // v1: bare array.
    if (Array.isArray(parsed)) return parsed as T[];
    // v2+: { version, items }.
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      if (parsed.version === SCHEMA_VERSION) return parsed.items as T[];
      return []; // unknown/newer schema — ignore rather than misread
    }
  } catch {
    // corrupted
  }
  return [];
}

function saveVersioned<T>(key: string, items: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify({ version: SCHEMA_VERSION, items }));
  } catch {
    // quota exceeded
  }
}

interface LinkDrag {
  active: boolean;
  sourceId: string | null;
  mouseX: number;
  mouseY: number;
}

interface TerminalState {
  terminals: Map<string, TerminalWindow>;
  activeTerminalId: string | null;
  nextZIndex: number;
  token: string | null;
  links: TerminalLink[];
  linkDrag: LinkDrag;
  sessionStatuses: Map<string, SessionStatus>;
  dirtyWindows: Set<string>;
  dirsState: DirsState;
  attention: Map<string, AttentionInfo>;

  setToken: (token: string) => void;
  setWindowDirty: (id: string, dirty: boolean) => void;
  setDirsState: (dirs: DirsState) => void;
  setAttention: (windowId: string, info: AttentionInfo) => void;
  clearAttention: (windowId: string) => void;
  setSessionStatuses: (statuses: Map<string, SessionStatus>) => void;
  addTerminal: (tw: TerminalWindow) => void;
  removeTerminal: (id: string) => void;
  updateTerminal: (id: string, updates: Partial<TerminalWindow>) => void;
  bringToFront: (id: string) => void;
  setActive: (id: string | null) => void;
  saveLayout: () => void;
  loadLayout: () => SavedLayout[];

  addLink: (sourceId: string, targetId: string) => void;
  restoreLink: (sourceId: string, targetId: string) => void;
  removeLink: (linkId: string) => void;
  startLinkDrag: (sourceId: string) => void;
  updateLinkDrag: (mouseX: number, mouseY: number) => void;
  endLinkDrag: () => void;
  saveLinks: () => void;
  loadLinks: () => SavedLink[];
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,
  nextZIndex: 1,
  token: null,
  links: [],
  linkDrag: { active: false, sourceId: null, mouseX: 0, mouseY: 0 },
  sessionStatuses: new Map(),
  dirtyWindows: new Set(),
  dirsState: EMPTY_DIRS_STATE,
  attention: new Map(),

  setToken: (token) => set({ token }),
  setDirsState: (dirs) => set({ dirsState: dirs }),
  setAttention: (windowId, info) =>
    set((state) => {
      const attention = new Map(state.attention);
      attention.set(windowId, info);
      return { attention };
    }),
  clearAttention: (windowId) =>
    set((state) => {
      if (!state.attention.has(windowId)) return state;
      const attention = new Map(state.attention);
      attention.delete(windowId);
      return { attention };
    }),
  setWindowDirty: (id, dirty) =>
    set((state) => {
      if (dirty === state.dirtyWindows.has(id)) return state;
      const dirtyWindows = new Set(state.dirtyWindows);
      if (dirty) dirtyWindows.add(id);
      else dirtyWindows.delete(id);
      return { dirtyWindows };
    }),
  setSessionStatuses: (statuses) => set({ sessionStatuses: statuses }),

  addTerminal: (tw) =>
    set((state) => {
      const terminals = new Map(state.terminals);
      tw.zIndex = state.nextZIndex;
      terminals.set(tw.id, tw);
      return { terminals, nextZIndex: state.nextZIndex + 1, activeTerminalId: tw.id };
    }),

  removeTerminal: (id) => {
    const state = get();
    // Unregister every link touching this window on the server so no stale peer
    // route survives (the client used to only filter its local list).
    const touched = state.links.filter((l) => l.sourceId === id || l.targetId === id);
    for (const l of touched) {
      const source = state.terminals.get(l.sourceId);
      const target = state.terminals.get(l.targetId);
      if (source && target) {
        apiFetch('/api/links', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: source.sessionId, targetId: target.sessionId }),
        }).catch(() => {});
      }
    }
    set((s) => {
      const terminals = new Map(s.terminals);
      terminals.delete(id);
      const links = s.links.filter((l) => l.sourceId !== id && l.targetId !== id);
      const activeTerminalId = s.activeTerminalId === id ? null : s.activeTerminalId;
      let dirtyWindows = s.dirtyWindows;
      if (dirtyWindows.has(id)) {
        dirtyWindows = new Set(dirtyWindows);
        dirtyWindows.delete(id);
      }
      let attention = s.attention;
      if (attention.has(id)) {
        attention = new Map(attention);
        attention.delete(id);
      }
      return { terminals, activeTerminalId, links, dirtyWindows, attention };
    });
    get().saveLinks();
  },

  updateTerminal: (id, updates) =>
    set((state) => {
      const terminals = new Map(state.terminals);
      const tw = terminals.get(id);
      if (tw) {
        terminals.set(id, { ...tw, ...updates });
      }
      return { terminals };
    }),

  bringToFront: (id) =>
    set((state) => {
      const terminals = new Map(state.terminals);
      const tw = terminals.get(id);
      if (tw) {
        tw.zIndex = state.nextZIndex;
        terminals.set(id, { ...tw });
      }
      return { terminals, nextZIndex: state.nextZIndex + 1 };
    }),

  setActive: (id) =>
    set((state) => {
      // Focusing a window resolves any pending attention on it.
      if (id && state.attention.has(id)) {
        const attention = new Map(state.attention);
        attention.delete(id);
        return { activeTerminalId: id, attention };
      }
      return { activeTerminalId: id };
    }),

  saveLayout: () => {
    const { terminals, sessionStatuses } = get();
    const layout: SavedLayout[] = Array.from(terminals.values()).map((tw) => ({
      sessionId: tw.sessionId,
      type: tw.type,
      url: tw.url,
      explorerRoot: tw.explorerRoot,
      filePath: tw.filePath,
      memoText: tw.memoText,
      // Snapshot the live cwd so a dead-session placeholder (phase 6.4) can offer
      // to reopen in the same directory after a server restart.
      cwd: sessionStatuses.get(tw.sessionId)?.cwd,
      x: tw.x,
      y: tw.y,
      width: tw.width,
      height: tw.height,
      title: tw.title,
    }));
    saveVersioned(LAYOUT_KEY, layout);
    get().saveLinks();
  },

  loadLayout: () => loadVersioned<SavedLayout>(LAYOUT_KEY),

  addLink: (sourceId, targetId) => {
    const state = get();
    if (sourceId === targetId) return;
    const exists = state.links.some(
      (l) => l.sourceId === sourceId && l.targetId === targetId
    );
    if (exists) return;

    const id = crypto.randomUUID();
    const newLinks = [...state.links, { id, sourceId, targetId }];
    set({ links: newLinks });

    // Register the link on the server with autoName so the SUB gets its sub-N
    // name assigned server-side (single source of truth; no separate PUT /name).
    const target = state.terminals.get(targetId);
    const source = state.terminals.get(sourceId);
    if (source && target) {
      apiFetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.sessionId, targetId: target.sessionId, autoName: true }),
      })
        .then((res) => res.json())
        .then((data) => {
          if (data?.assignedName) {
            get().updateTerminal(targetId, { title: data.assignedName });
            get().saveLayout();
          }
        })
        .catch(() => {});
    }

    get().saveLinks();
  },

  // Re-register an existing link on reload WITHOUT auto-naming or context
  // re-injection (the server's POST /api/links is idempotent for live peers).
  restoreLink: (sourceId, targetId) => {
    const state = get();
    if (sourceId === targetId) return;
    if (state.links.some((l) => l.sourceId === sourceId && l.targetId === targetId)) return;
    const id = crypto.randomUUID();
    set({ links: [...state.links, { id, sourceId, targetId }] });
    const source = state.terminals.get(sourceId);
    const target = state.terminals.get(targetId);
    if (source && target) {
      apiFetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.sessionId, targetId: target.sessionId }),
      }).catch(() => {});
    }
  },

  removeLink: (linkId) => {
    const state = get();
    const link = state.links.find((l) => l.id === linkId);

    // Unregister link on server
    if (link) {
      const source = state.terminals.get(link.sourceId);
      const target = state.terminals.get(link.targetId);
      if (source && target) {
        apiFetch('/api/links', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceId: source.sessionId, targetId: target.sessionId }),
        }).catch(() => {});
      }
    }

    set((s) => ({
      links: s.links.filter((l) => l.id !== linkId),
    }));
    get().saveLinks();
  },

  startLinkDrag: (sourceId) => {
    set({ linkDrag: { active: true, sourceId, mouseX: 0, mouseY: 0 } });
  },

  updateLinkDrag: (mouseX, mouseY) => {
    set((state) => ({
      linkDrag: { ...state.linkDrag, mouseX, mouseY },
    }));
  },

  endLinkDrag: () => {
    set({ linkDrag: { active: false, sourceId: null, mouseX: 0, mouseY: 0 } });
  },

  saveLinks: () => {
    const { links, terminals } = get();
    const saved: SavedLink[] = [];
    for (const l of links) {
      const source = terminals.get(l.sourceId);
      const target = terminals.get(l.targetId);
      if (source && target) {
        saved.push({
          sourceSessionId: source.sessionId,
          targetSessionId: target.sessionId,
        });
      }
    }
    saveVersioned(LINKS_KEY, saved);
  },

  loadLinks: () => loadVersioned<SavedLink>(LINKS_KEY),
}));
