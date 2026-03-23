import { useRef, useEffect, useCallback } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';

interface MemoContentProps {
  windowId: string;
  isActive: boolean;
}

export default function MemoContent({ windowId, isActive }: MemoContentProps) {
  const text = useTerminalStore((s) => s.terminals.get(windowId)?.memoText ?? '');
  const { updateTerminal, saveLayout } = useTerminalStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus on creation
  useEffect(() => {
    if (isActive) {
      textareaRef.current?.focus();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    updateTerminal(windowId, { memoText: e.target.value });
    saveLayout();
  }, [windowId, updateTerminal, saveLayout]);

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
