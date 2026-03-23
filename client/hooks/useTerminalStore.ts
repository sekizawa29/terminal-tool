import { create } from 'zustand';
import type { TerminalWindow, TerminalLink, SessionStatus } from '../types.js';

const LAYOUT_KEY = 'terminal-board-layout';
const LINKS_KEY = 'terminal-board-links';
interface SavedLayout {
  sessionId: string;
  type?: 'terminal' | 'browser' | 'explorer' | 'editor' | 'memo';
  url?: string;
  explorerRoot?: string;
  filePath?: string;
  memoText?: string;
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

  setToken: (token: string) => void;
  setSessionStatuses: (statuses: Map<string, SessionStatus>) => void;
  addTerminal: (tw: TerminalWindow) => void;
  removeTerminal: (id: string) => void;
  updateTerminal: (id: string, updates: Partial<TerminalWindow>) => void;
  bringToFront: (id: string) => void;
  setActive: (id: string | null) => void;
  saveLayout: () => void;
  loadLayout: () => SavedLayout[];

  addLink: (sourceId: string, targetId: string) => void;
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

  setToken: (token) => set({ token }),
  setSessionStatuses: (statuses) => set({ sessionStatuses: statuses }),

  addTerminal: (tw) =>
    set((state) => {
      const terminals = new Map(state.terminals);
      tw.zIndex = state.nextZIndex;
      terminals.set(tw.id, tw);
      return { terminals, nextZIndex: state.nextZIndex + 1, activeTerminalId: tw.id };
    }),

  removeTerminal: (id) =>
    set((state) => {
      const terminals = new Map(state.terminals);
      terminals.delete(id);
      const links = state.links.filter((l) => l.sourceId !== id && l.targetId !== id);
      const activeTerminalId = state.activeTerminalId === id ? null : state.activeTerminalId;
      return { terminals, activeTerminalId, links };
    }),

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

  setActive: (id) => set({ activeTerminalId: id }),

  saveLayout: () => {
    const { terminals } = get();
    const layout: SavedLayout[] = Array.from(terminals.values()).map((tw) => ({
      sessionId: tw.sessionId,
      type: tw.type,
      url: tw.url,
      explorerRoot: tw.explorerRoot,
      filePath: tw.filePath,
      memoText: tw.memoText,
      x: tw.x,
      y: tw.y,
      width: tw.width,
      height: tw.height,
      title: tw.title,
    }));
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // quota exceeded
    }
    get().saveLinks();
  },

  loadLayout: () => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // corrupted
    }
    return [];
  },

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

    // Auto-name the target terminal on the server
    const target = state.terminals.get(targetId);
    const source = state.terminals.get(sourceId);
    if (target) {
      const subCount = newLinks.filter((l) => l.sourceId === sourceId).length;
      fetch(`/api/terminals/${target.sessionId}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: `sub-${subCount}` }),
      }).catch(() => {});
    }

    // Register link on server for peer routing
    if (source && target) {
      fetch('/api/links', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: source.sessionId, targetId: target.sessionId }),
      }).catch(() => {});
    }

    get().saveLinks();
  },

  removeLink: (linkId) => {
    const state = get();
    const link = state.links.find((l) => l.id === linkId);

    // Unregister link on server
    if (link) {
      const source = state.terminals.get(link.sourceId);
      const target = state.terminals.get(link.targetId);
      if (source && target) {
        fetch('/api/links', {
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
    try {
      localStorage.setItem(LINKS_KEY, JSON.stringify(saved));
    } catch {}
  },

  loadLinks: () => {
    try {
      const raw = localStorage.getItem(LINKS_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
    return [];
  },
}));
