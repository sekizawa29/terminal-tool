import { useCallback, useEffect, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import type { CanvasTransform } from '../hooks/useCanvas.js';

interface SessionStatus {
  sessionId: string;
  pid: number;
  cwd: string;
  cwdShort: string;
  foregroundProcess: string;
  isRunning: boolean;
  isProcessing: boolean;
  name?: string;
}

interface SidebarProps {
  transform: CanvasTransform;
  onAddTerminal: () => void;
  onDuplicateTerminal: (cwd: string, nearX: number, nearY: number) => void;
  onClaudeTerminal: (cwd: string, nearX: number, nearY: number) => void;
  onFocusTerminal: (x: number, y: number, width: number, height: number) => void;
  onZoomToFit: () => void;
  onAutoLayout: () => void;
}

const ClaudeIcon = () => (
  <svg height="11" width="11" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fillRule="nonzero"/>
  </svg>
);

const AGENT_PROCESSES = new Set([
  'claude', 'codex', 'aider', 'cursor', 'copilot',
  'cline', 'roo',
]);

function getDisplayName(status: SessionStatus | undefined): string {
  if (!status) return 'Terminal';
  if (status.name) return status.name;
  const parts = status.cwdShort.split('/');
  return parts[parts.length - 1] || status.cwdShort;
}

function isAgentProcess(process: string): boolean {
  return AGENT_PROCESSES.has(process);
}

export default function Sidebar({ transform, onAddTerminal, onDuplicateTerminal, onClaudeTerminal, onFocusTerminal, onZoomToFit, onAutoLayout }: SidebarProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const { bringToFront, setActive, updateTerminal } = useTerminalStore();
  const [statuses, setStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [expanded, setExpanded] = useState(false);

  const zoomPercent = Math.round(transform.scale * 100);

  // Poll terminal statuses
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const res = await fetch('/api/terminals/status');
        const data = await res.json();
        if (!active) return;
        const map = new Map<string, SessionStatus>();
        for (const s of data.statuses as SessionStatus[]) {
          map.set(s.sessionId, s);
        }
        setStatuses(map);
        const store = useTerminalStore.getState();
        for (const tw of store.terminals.values()) {
          const status = map.get(tw.sessionId);
          if (status) {
            const name = getDisplayName(status);
            if (tw.title !== name) {
              updateTerminal(tw.id, { title: name });
            }
          }
        }
      } catch { /* server unavailable */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [updateTerminal]);

  const handleClick = useCallback(
    (id: string) => {
      const tw = useTerminalStore.getState().terminals.get(id);
      bringToFront(id);
      setActive(id);
      if (tw) {
        onFocusTerminal(tw.x, tw.y, tw.width, tw.height);
      }
    },
    [bringToFront, setActive, onFocusTerminal]
  );

  // Figma-style icon button base
  const iconBtn: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    background: 'none',
    border: 'none',
    color: 'var(--text-tertiary)',
    cursor: 'pointer',
    flexShrink: 0,
    borderRadius: 6,
    transition: 'background 120ms, color 120ms',
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 12,
        left: 12,
        zIndex: 10000,
        userSelect: 'none',
        animation: 'scaleIn 0.25s var(--ease-out) both',
      }}
    >
      {/* Floating toolbar */}
      <div
        style={{
          background: 'rgba(22, 22, 30, 0.88)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.06)',
          borderRadius: 10,
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(0, 0, 0, 0.15)',
          overflow: 'hidden',
          minWidth: expanded ? 260 : undefined,
          transition: 'min-width 200ms var(--ease-out), box-shadow 200ms',
        }}
      >
        {/* Toolbar row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 36,
            padding: '0 4px',
            gap: 1,
          }}
        >
          {/* Logo */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 6px 0 6px',
              cursor: 'default',
              flexShrink: 0,
            }}
          >
            <img
              src="/logo.svg"
              alt="tboard"
              style={{ height: 16, flexShrink: 0, opacity: 0.9 }}
            />
          </div>

          {/* Separator */}
          <div style={{ width: 1, height: 16, background: 'rgba(255, 255, 255, 0.06)', flexShrink: 0, margin: '0 2px' }} />

          {/* Session toggle */}
          <button
            onClick={() => setExpanded((p) => !p)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '0 8px',
              height: 28,
              background: expanded ? 'rgba(255, 255, 255, 0.06)' : 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
              whiteSpace: 'nowrap',
              borderRadius: 6,
              transition: 'background 120ms, color 120ms',
              letterSpacing: '-0.01em',
            }}
            title="Toggle sessions"
            onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)'; }}
            onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.background = 'none'; }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6 }}>
              <rect x="4" y="4" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
              <path d="M12 4V3a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" stroke="currentColor" strokeWidth="1.4" fill="none"/>
            </svg>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{terminals.size}</span>
            <svg
              width="7"
              height="7"
              viewBox="0 0 8 8"
              fill="none"
              style={{
                transform: expanded ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 200ms var(--ease-out)',
                opacity: 0.4,
              }}
            >
              <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {/* Separator */}
          <div style={{ width: 1, height: 16, background: 'rgba(255, 255, 255, 0.06)', flexShrink: 0, margin: '0 2px' }} />

          {/* Zoom */}
          <span
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: 'var(--text-tertiary)',
              padding: '0 6px',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.01em',
            }}
          >
            {zoomPercent}%
          </span>

          {/* Zoom to Fit */}
          <button
            onClick={onZoomToFit}
            title="Zoom to Fit"
            style={iconBtn}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {/* Auto Layout */}
          <button
            onClick={onAutoLayout}
            title="Auto Layout"
            style={iconBtn}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
              <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
              <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
              <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
            </svg>
          </button>

          {/* Separator */}
          <div style={{ width: 1, height: 16, background: 'rgba(255, 255, 255, 0.06)', flexShrink: 0, margin: '0 2px' }} />

          {/* Add terminal */}
          <button
            onClick={onAddTerminal}
            title="New Terminal (Ctrl+Shift+N)"
            style={iconBtn}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(122, 162, 247, 0.12)'; e.currentTarget.style.color = 'var(--accent-blue)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = 'var(--text-tertiary)'; }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {/* Session list (Figma layers panel style) */}
        {expanded && (
          <div
            style={{
              borderTop: '1px solid rgba(255, 255, 255, 0.06)',
              maxHeight: 300,
              overflowY: 'auto',
              padding: 3,
              animation: 'slideInUp 0.15s var(--ease-out) both',
            }}
          >
            {Array.from(terminals.values()).map((tw) => {
              const status = statuses.get(tw.sessionId);
              const isActive = activeTerminalId === tw.id;
              const running = status?.isRunning ?? false;
              const processing = status?.isProcessing ?? false;
              const agent = status ? isAgentProcess(status.foregroundProcess) : false;
              const displayName = getDisplayName(status);
              const processName = status?.foregroundProcess ?? 'bash';

              const dotColor = running && agent && processing
                ? 'var(--accent-yellow)'
                : running && agent
                ? 'var(--accent-green)'
                : running
                ? 'var(--accent-yellow)'
                : 'var(--text-ghost)';

              const dotGlow = running && agent && !processing
                ? '0 0 6px rgba(158, 206, 106, 0.5)'
                : running && processing
                ? '0 0 6px rgba(224, 175, 104, 0.5)'
                : undefined;

              const processColor = running && agent && processing
                ? 'var(--accent-yellow)'
                : running && agent
                ? 'var(--accent-green)'
                : running
                ? 'var(--accent-yellow)'
                : 'var(--text-tertiary)';

              const isPulsing = running && (agent || processing);

              return (
                <div
                  key={tw.id}
                  className="sidebar-terminal-row"
                  onClick={() => handleClick(tw.id)}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: isActive ? 'rgba(122, 162, 247, 0.1)' : 'transparent',
                    position: 'relative',
                    transition: 'background 100ms',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {isActive && (
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 5,
                        bottom: 5,
                        width: 2,
                        background: 'var(--accent-blue)',
                        borderRadius: 1,
                      }}
                    />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: dotColor,
                        boxShadow: dotGlow,
                        flexShrink: 0,
                        animation: isPulsing ? 'statusPulse 2s ease-in-out infinite' : undefined,
                      }}
                    />
                    <span
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {displayName}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onClaudeTerminal(status?.cwd || '', tw.x + 40, tw.y + 40);
                      }}
                      title="Open Claude here"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 3,
                        lineHeight: 1,
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        opacity: 0.4,
                        transition: 'opacity 100ms, background 100ms',
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; e.currentTarget.style.background = 'none'; }}
                    >
                      <ClaudeIcon />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDuplicateTerminal(status?.cwd || '', tw.x + 40, tw.y + 40);
                      }}
                      title="Duplicate"
                      className="duplicate-btn"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-tertiary)',
                        cursor: 'pointer',
                        padding: 3,
                        lineHeight: 1,
                        flexShrink: 0,
                        opacity: 0.4,
                        transition: 'opacity 100ms, background 100ms',
                        borderRadius: 4,
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.background = 'rgba(255, 255, 255, 0.06)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.4'; e.currentTarget.style.background = 'none'; }}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                        <rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                        <path d="M11 5V3a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                      </svg>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
