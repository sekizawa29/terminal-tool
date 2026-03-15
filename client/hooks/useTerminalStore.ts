import { create } from 'zustand';
import type { TerminalWindow } from '../types.js';

const LAYOUT_KEY = 'terminal-board-layout';

interface SavedLayout {
  sessionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

interface TerminalState {
  terminals: Map<string, TerminalWindow>;
  activeTerminalId: string | null;
  nextZIndex: number;
  token: string | null;

  setToken: (token: string) => void;
  addTerminal: (tw: TerminalWindow) => void;
  removeTerminal: (id: string) => void;
  updateTerminal: (id: string, updates: Partial<TerminalWindow>) => void;
  bringToFront: (id: string) => void;
  setActive: (id: string | null) => void;
  saveLayout: () => void;
  loadLayout: () => SavedLayout[];
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminals: new Map(),
  activeTerminalId: null,
  nextZIndex: 1,
  token: null,

  setToken: (token) => set({ token }),

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
      const activeTerminalId = state.activeTerminalId === id ? null : state.activeTerminalId;
      return { terminals, activeTerminalId };
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
}));
