import { useEffect, useRef } from 'react';
import { useTerminalStore } from './useTerminalStore.js';
import { fetchDirsState, pushRecentDir } from '../api/dirsApi.js';
import { apiFetch } from '../api.js';
import { isAgentProcess } from '../utils/agents.js';
import { isWindowInViewport } from '../utils/viewport.js';
import type { CanvasController } from './useCanvas.js';
import type { SessionStatus } from '../types.js';

// Derive the label shown for a session: explicit name, else the last path
// segment of its short cwd.
export function getDisplayName(status: SessionStatus | undefined): string {
  if (!status) return 'Terminal';
  if (status.name) return status.name;
  const parts = status.cwdShort.split('/');
  return parts[parts.length - 1] || status.cwdShort;
}

// Polls /api/terminals/status every 2s, mirrors statuses + derived titles into
// the store, and pushes newly-seen cwds to the recent-dirs list. Mounted once
// (in App) — it owns no UI, only store side effects, so the sidebar can mount
// and unmount freely without restarting the poll.
export function useSessionPolling(controller: CanvasController): void {
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const setSessionStatuses = useTerminalStore((s) => s.setSessionStatuses);
  const setDirsState = useTerminalStore((s) => s.setDirsState);
  const lastCwdBySession = useRef<Map<string, string>>(new Map());
  const prevProcessing = useRef<Map<string, boolean>>(new Map());

  useEffect(() => {
    let active = true;
    // Pull initial persisted dirs so the menu is hydrated before the first cwd-diff.
    fetchDirsState().then((state) => {
      if (active && state) setDirsState(state);
    });
    const poll = async () => {
      try {
        const res = await apiFetch('/api/terminals/status');
        const data = await res.json();
        if (!active) return;
        const map = new Map<string, SessionStatus>();
        for (const s of data.statuses as SessionStatus[]) {
          map.set(s.sessionId, s);
        }
        setSessionStatuses(map);
        const store = useTerminalStore.getState();
        const windowBySession = new Map<string, string>();
        for (const tw of store.terminals.values()) {
          windowBySession.set(tw.sessionId, tw.id);
          const status = map.get(tw.sessionId);
          if (status) {
            const name = getDisplayName(status);
            if (tw.title !== name) {
              updateTerminal(tw.id, { title: name });
            }
          }
        }

        // Offscreen attention: an agent session that was processing and just
        // went idle (finished/awaiting input) earns an attention marker unless
        // its window is already on screen with the tab focused.
        for (const s of data.statuses as SessionStatus[]) {
          const wasProcessing = prevProcessing.current.get(s.sessionId) ?? false;
          prevProcessing.current.set(s.sessionId, s.isProcessing);
          const finished = wasProcessing && !s.isProcessing && isAgentProcess(s.foregroundProcess);
          if (!finished) continue;
          const windowId = windowBySession.get(s.sessionId);
          if (!windowId) continue;
          const tw = store.terminals.get(windowId);
          if (!tw) continue;
          const onScreen =
            document.visibilityState === 'visible' &&
            isWindowInViewport(tw, controller.getTransform());
          if (onScreen || store.activeTerminalId === windowId) continue;
          useTerminalStore.getState().setAttention(windowId, { kind: 'finished', at: Date.now() });
        }

        const liveIds = new Set<string>();
        const newCwds: string[] = [];
        for (const s of data.statuses as SessionStatus[]) {
          liveIds.add(s.sessionId);
          if (!s.cwd) continue;
          if (lastCwdBySession.current.get(s.sessionId) === s.cwd) continue;
          lastCwdBySession.current.set(s.sessionId, s.cwd);
          if (useTerminalStore.getState().dirsState.recent[0] === s.cwd) continue;
          newCwds.push(s.cwd);
        }
        for (const id of lastCwdBySession.current.keys()) {
          if (!liveIds.has(id)) lastCwdBySession.current.delete(id);
        }
        for (const id of prevProcessing.current.keys()) {
          if (!liveIds.has(id)) prevProcessing.current.delete(id);
        }
        // Push each new cwd to the server in order; server enforces the dedupe + 5-cap.
        for (const cwd of newCwds) {
          const updated = await pushRecentDir(cwd);
          if (!active) return;
          if (updated) setDirsState(updated);
        }
      } catch { /* server unavailable */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [updateTerminal, setSessionStatuses, setDirsState, controller]);
}
