import { useRef, useEffect, useCallback, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import { apiFetch } from '../api.js';

interface MemoContentProps {
  windowId: string;
  isActive: boolean;
}

export default function MemoContent({ windowId, isActive }: MemoContentProps) {
  // The memo's server key is the window's stable pseudo-sessionId.
  const memoId = useTerminalStore((s) => s.terminals.get(windowId)?.sessionId ?? '');
  const title = useTerminalStore((s) => s.terminals.get(windowId)?.title ?? 'Memo');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [hydrated, setHydrated] = useState(false);
  // Mirror the latest text/id/title and a dirty flag so a flush on unmount or
  // page reload (within the debounce window) doesn't drop the last edit.
  const latestRef = useRef({ text: '', memoId: '', title: 'Memo', dirty: false });
  latestRef.current.memoId = memoId;
  latestRef.current.title = title;

  const flushMemo = useCallback(() => {
    const { text: t, memoId: id, title: ti, dirty } = latestRef.current;
    if (!dirty || !id) return;
    latestRef.current.dirty = false;
    // keepalive lets the request finish even as the page unloads.
    apiFetch(`/api/memos/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: t, title: ti }),
      keepalive: true,
    }).catch(() => {});
  }, []);

  // Auto-focus on creation
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate from the server (source of truth). One-time migration: if the server
  // has no record but the restored layout carried local text, push it up.
  useEffect(() => {
    if (!memoId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/memos');
        const list = res.ok ? await res.json() : [];
        if (cancelled) return;
        const found = Array.isArray(list) ? list.find((m: { id: string }) => m.id === memoId) : null;
        if (found) {
          setText(found.text ?? '');
        } else {
          const local = useTerminalStore.getState().terminals.get(windowId)?.memoText ?? '';
          setText(local);
          if (local) {
            apiFetch(`/api/memos/${encodeURIComponent(memoId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: local, title }),
            }).catch(() => {});
          }
        }
      } catch {
        if (!cancelled) setText(useTerminalStore.getState().terminals.get(windowId)?.memoText ?? '');
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [memoId, windowId, title]);

  // Persist edits 500ms after the last keystroke (replaces the old per-keystroke
  // saveLayout()).
  useEffect(() => {
    if (!hydrated || !memoId) return;
    const timer = setTimeout(() => {
      latestRef.current.dirty = false;
      apiFetch(`/api/memos/${encodeURIComponent(memoId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, title }),
      }).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [text, hydrated, memoId, title]);

  // Flush any pending edit on reload / tab close (within the debounce window).
  // NOT on React unmount: explicit window close DELETEs the memo first, and
  // flushing there would resurrect it on the server.
  useEffect(() => {
    window.addEventListener('beforeunload', flushMemo);
    return () => window.removeEventListener('beforeunload', flushMemo);
  }, [flushMemo]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    latestRef.current.text = v;
    latestRef.current.dirty = true;
    setText(v);
  }, []);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text);
  }, [text]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'var(--bg-surface)',
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        height: 28,
        padding: '0 6px',
        borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
        flexShrink: 0,
        justifyContent: 'flex-end',
      }}>
        <button
          onClick={handleCopy}
          title="Copy all"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            background: 'none',
            border: 'none',
            color: 'var(--text-tertiary)',
            cursor: 'pointer',
            borderRadius: 5,
            transition: 'background 120ms, color 120ms',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
            <path d="M11 5V3a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
          </svg>
        </button>
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        value={text}
        onChange={handleChange}
        placeholder="Type here ..."
        spellCheck={false}
        style={{
          flex: 1,
          display: 'block',
          width: '100%',
          background: 'none',
          border: 'none',
          outline: 'none',
          resize: 'none',
          color: 'var(--text-primary)',
          fontSize: 12.5,
          fontFamily: 'var(--font-mono, "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace)',
          lineHeight: 1.6,
          padding: '10px 12px',
          overflow: 'auto',
          boxSizing: 'border-box',
        }}
      />
    </div>
  );
}
