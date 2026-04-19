import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import type { CanvasTransform } from '../hooks/useCanvas.js';
import type { SessionStatus } from '../types.js';

interface SidebarProps {
  transform: CanvasTransform;
  onAddTerminal: () => void;
  onAddBrowser: () => void;
  onToggleExplorer: () => void;
  explorerOpen: boolean;
  onAddMemo: () => void;
  onDuplicateTerminal: (cwd: string, nearX: number, nearY: number) => void;
  onClaudeTerminal: (cwd: string, nearX: number, nearY: number) => void;
  onCodexTerminal: (cwd: string, nearX: number, nearY: number) => void;
  onPowershellTerminal: (nearX: number, nearY: number) => void;
  onFocusTerminal: (x: number, y: number, width: number, height: number) => void;
  onZoomToFit: () => void;
  onAutoLayout: () => void;
  onExpandChange?: (expanded: boolean) => void;
}

type Tone = 'default' | 'memo' | 'explorer' | 'browser';

const TONE_BG: Record<Tone, string> = {
  default: 'rgba(255, 255, 255, 0.04)',
  memo: 'rgba(187, 154, 247, 0.10)',
  explorer: 'rgba(224, 175, 104, 0.10)',
  browser: 'rgba(125, 207, 255, 0.10)',
};

const TONE_FG: Record<Tone, string> = {
  default: 'var(--accent-blue)',
  memo: '#bb9af7',
  explorer: 'var(--accent-yellow)',
  browser: 'var(--accent-cyan)',
};

const ClaudeIcon = () => (
  <svg height="11" width="11" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z" fill="#D97757" fillRule="nonzero"/>
  </svg>
);

const CodexIcon = () => (
  <svg height="11" width="11" viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg">
    <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/>
  </svg>
);

const PowerShellIcon = () => (
  <svg height="12" width="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.5 3L8.5 8L2.5 13" stroke="#4ea3ff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8.5 13H13.5" stroke="#4ea3ff" strokeWidth="1.8" strokeLinecap="round"/>
  </svg>
);

const TerminalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="3" width="12" height="10" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    <path d="M5 7l2 1.5L5 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const SessionsIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="3" y="5" width="10" height="8" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    <path d="M5 5V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1" stroke="currentColor" strokeWidth="1.3" fill="none"/>
  </svg>
);

const CaretIcon = ({ open }: { open: boolean }) => (
  <svg
    width="7"
    height="7"
    viewBox="0 0 8 8"
    fill="none"
    style={{
      transform: open ? 'rotate(180deg)' : 'rotate(0)',
      transition: 'transform 200ms var(--ease-out)',
    }}
  >
    <path d="M1.5 3L4 5.5L6.5 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const PlusIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
    <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
  </svg>
);

const FitIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const AutoLayoutIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
    <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
    <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
    <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.4" fill="none"/>
  </svg>
);

const ExplorerIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <path d="M2 4a1 1 0 011-1h3.586a1 1 0 01.707.293L8.414 4.414A1 1 0 009.121 4.7H13a1 1 0 011 1V12a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" fill="none"/>
  </svg>
);

const MemoIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
    <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" fill="none"/>
    <path d="M5 5h6M5 8h6M5 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
);

const CopyIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
    <rect x="5" y="5" width="9" height="9" rx="2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
    <path d="M11 5V3a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" stroke="currentColor" strokeWidth="1.4" fill="none"/>
  </svg>
);

const Logo = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 2px 0 0', flexShrink: 0 }}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="2" width="20" height="20" rx="5" stroke="var(--accent-blue)" strokeWidth="1.8" />
      <path d="M7 8l4 4-4 4" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13 16h4" stroke="var(--accent-blue)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
    <span
      style={{
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--text-primary)',
        letterSpacing: '-0.01em',
        lineHeight: 1,
      }}
    >
      tboard
    </span>
  </div>
);

const Divider = () => (
  <div
    style={{
      width: 1,
      height: 18,
      background: 'var(--border-hair)',
      flexShrink: 0,
      margin: '0 4px',
    }}
  />
);

interface ToolbarButtonProps {
  icon: React.ReactNode;
  hint: string;
  onClick: () => void;
  active?: boolean;
  tone?: Tone;
}

function ToolbarButton({ icon, hint, onClick, active = false, tone = 'default' }: ToolbarButtonProps) {
  const [hover, setHover] = useState(false);
  const bg = active
    ? TONE_BG[tone]
    : hover
      ? 'rgba(255, 255, 255, 0.04)'
      : 'transparent';
  const color = active
    ? TONE_FG[tone]
    : hover
      ? 'var(--text-secondary)'
      : 'var(--text-tertiary)';
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={hint}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        background: bg,
        color,
        border: 'none',
        borderRadius: 7,
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'all 140ms var(--ease-out)',
      }}
    >
      {icon}
    </button>
  );
}

const WindowsBadge = () => (
  <span
    style={{
      fontSize: 9,
      fontWeight: 700,
      color: '#4ea3ff',
      background: 'rgba(78, 163, 255, 0.14)',
      padding: '1px 4px',
      borderRadius: 3,
      letterSpacing: '0.04em',
      lineHeight: '13px',
      flexShrink: 0,
    }}
  >
    WIN
  </span>
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

export default function Sidebar({
  transform,
  onAddTerminal,
  onToggleExplorer,
  explorerOpen,
  onAddMemo,
  onDuplicateTerminal,
  onClaudeTerminal,
  onCodexTerminal,
  onPowershellTerminal,
  onFocusTerminal,
  onZoomToFit,
  onAutoLayout,
  onExpandChange,
}: SidebarProps) {
  const terminals = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const statuses = useTerminalStore((s) => s.sessionStatuses);
  const { bringToFront, setActive, updateTerminal, setSessionStatuses } = useTerminalStore();
  const [expanded, setExpanded] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setSessionStatuses(map);
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
  }, [updateTerminal, setSessionStatuses]);

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

  const toggleExpanded = () => {
    setExpanded((p) => {
      const next = !p;
      onExpandChange?.(next);
      return next;
    });
  };

  const sessionPillBg = expanded ? 'var(--accent-soft)' : 'rgba(255, 255, 255, 0.03)';
  const sessionPillFg = expanded ? 'var(--accent-blue)' : 'var(--text-secondary)';

  return (
    <div
      style={{
        position: 'fixed',
        top: 14,
        left: 14,
        zIndex: 10000,
        userSelect: 'none',
        animation: 'scaleIn 300ms var(--ease-out) both',
      }}
    >
      <div
        style={{
          background: 'linear-gradient(180deg, #232540 0%, #1c1d2e 100%)',
          border: '1px solid rgba(122, 162, 247, 0.18)',
          borderRadius: 12,
          boxShadow: [
            '0 1px 0 rgba(255, 255, 255, 0.06) inset',
            '0 0 0 1px rgba(0, 0, 0, 0.4)',
            '0 14px 32px -8px rgba(0, 0, 0, 0.65)',
            '0 4px 10px -2px rgba(0, 0, 0, 0.45)',
          ].join(', '),
          width: 320,
          overflow: 'visible',
        }}
      >
        {/* Top row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 42,
            padding: '0 10px 0 12px',
            gap: 2,
          }}
        >
          <Logo />
          <Divider />

          {/* Session count pill */}
          <button
            type="button"
            onClick={toggleExpanded}
            title="Toggle sessions"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              height: 26,
              padding: '0 8px 0 7px',
              borderRadius: 7,
              background: sessionPillBg,
              color: sessionPillFg,
              border: 'none',
              cursor: 'pointer',
              fontSize: 11,
              fontWeight: 500,
              flexShrink: 0,
              transition: 'all 140ms var(--ease-out)',
            }}
          >
            <SessionsIcon />
            <span
              style={{
                fontVariantNumeric: 'tabular-nums',
                fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                minWidth: 10,
                textAlign: 'center',
                letterSpacing: '0.02em',
              }}
            >
              {terminals.size}
            </span>
            <CaretIcon open={expanded} />
          </button>

          {/* Add terminal — hover-hold dropdown */}
          <div
            style={{ position: 'relative', flexShrink: 0 }}
            onMouseEnter={() => {
              addMenuTimer.current = setTimeout(() => setAddMenuOpen(true), 500);
            }}
            onMouseLeave={() => {
              if (addMenuTimer.current) {
                clearTimeout(addMenuTimer.current);
                addMenuTimer.current = null;
              }
              setAddMenuOpen(false);
            }}
          >
            <ToolbarButton
              icon={<PlusIcon />}
              hint="New Terminal (Ctrl+Shift+N)"
              onClick={onAddTerminal}
            />
            {addMenuOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: '100%',
                  left: -4,
                  paddingTop: 6,
                  zIndex: 10002,
                }}
              >
                <div
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-default)',
                    borderRadius: 10,
                    boxShadow: '0 12px 32px rgba(0, 0, 0, 0.55)',
                    padding: 4,
                    minWidth: 180,
                    animation: 'slideInUp 140ms var(--ease-out) both',
                  }}
                >
                  <DropdownItem
                    icon={<TerminalIcon />}
                    label="Terminal"
                    hint="⌃⇧N"
                    onClick={() => {
                      setAddMenuOpen(false);
                      onAddTerminal();
                    }}
                  />
                  <DropdownItem
                    icon={<PowerShellIcon />}
                    label="PowerShell"
                    hint="WIN"
                    onClick={() => {
                      setAddMenuOpen(false);
                      const { offsetX, offsetY, scale } = transform;
                      const cx = (window.innerWidth / 2 - offsetX) / scale;
                      const cy = (window.innerHeight / 2 - offsetY) / scale;
                      onPowershellTerminal(cx - 350, cy - 225);
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <Divider />

          <ToolbarButton icon={<FitIcon />} hint="Zoom to Fit" onClick={onZoomToFit} />
          <ToolbarButton icon={<AutoLayoutIcon />} hint="Auto Layout" onClick={onAutoLayout} />
          <ToolbarButton
            icon={<ExplorerIcon />}
            hint="Toggle Explorer"
            onClick={onToggleExplorer}
            active={explorerOpen}
            tone="explorer"
          />
          <ToolbarButton icon={<MemoIcon />} hint="New Memo" onClick={onAddMemo} tone="memo" />
        </div>

        {/* Session list */}
        {expanded && (
          <div
            style={{
              borderTop: '1px solid var(--border-hair)',
              padding: 4,
              maxHeight: 240,
              overflowY: 'auto',
              animation: 'slideInUp 160ms var(--ease-out) both',
            }}
          >
            {Array.from(terminals.values()).map((tw) => {
              const isBrowser = tw.type === 'browser';
              const isMemo = tw.type === 'memo';
              const isNonTerminal = isBrowser || isMemo;
              const status = isNonTerminal ? undefined : statuses.get(tw.sessionId);
              const isActive = activeTerminalId === tw.id;
              const running = status?.isRunning ?? false;
              const processing = status?.isProcessing ?? false;
              const agent = status ? isAgentProcess(status.foregroundProcess) : false;
              const isWindows = status?.shellType === 'windows';
              const displayName = isNonTerminal ? (tw.title || tw.type || 'Panel') : getDisplayName(status);

              const dotColor = isBrowser
                ? 'var(--accent-cyan)'
                : isMemo
                  ? '#bb9af7'
                  : processing
                    ? 'var(--accent-yellow)'
                    : agent && running
                      ? 'var(--accent-green)'
                      : running
                        ? 'var(--accent-yellow)'
                        : 'var(--text-ghost)';

              const dotGlow = processing
                ? '0 0 6px rgba(224, 175, 104, 0.5)'
                : agent && running
                  ? '0 0 6px rgba(158, 206, 106, 0.5)'
                  : undefined;

              const isPulsing = !isNonTerminal && (processing || (agent && running));

              return (
                <SessionRow
                  key={tw.id}
                  active={isActive}
                  dotColor={dotColor}
                  dotGlow={dotGlow}
                  pulsing={isPulsing}
                  windows={isWindows}
                  title={displayName}
                  onClick={() => handleClick(tw.id)}
                  onClaude={() => onClaudeTerminal(status?.cwd || '', tw.x + 40, tw.y + 40)}
                  onCodex={() => onCodexTerminal(status?.cwd || '', tw.x + 40, tw.y + 40)}
                  onCopy={() => onDuplicateTerminal(status?.cwd || '', tw.x + 40, tw.y + 40)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface DropdownItemProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}

function DropdownItem({ icon, label, hint, onClick }: DropdownItemProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '7px 10px',
        background: hover ? 'rgba(255, 255, 255, 0.05)' : 'transparent',
        border: 'none',
        borderRadius: 6,
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        textAlign: 'left',
        fontSize: 12,
        transition: 'background 100ms',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0, color: 'var(--text-tertiary)' }}>
        {icon}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-ghost)',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          letterSpacing: '0.04em',
        }}
      >
        {hint}
      </span>
    </button>
  );
}

interface SessionRowProps {
  active: boolean;
  dotColor: string;
  dotGlow?: string;
  pulsing: boolean;
  windows: boolean;
  title: string;
  onClick: () => void;
  onClaude: () => void;
  onCodex: () => void;
  onCopy: () => void;
}

function SessionRow({
  active,
  dotColor,
  dotGlow,
  pulsing,
  windows,
  title,
  onClick,
  onClaude,
  onCodex,
  onCopy,
}: SessionRowProps) {
  const [hover, setHover] = useState(false);
  const bg = active
    ? 'var(--accent-soft)'
    : hover
      ? 'rgba(255, 255, 255, 0.035)'
      : 'transparent';
  const actionsOpacity = hover || active ? 1 : 0.35;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        borderRadius: 7,
        cursor: 'pointer',
        background: bg,
        transition: 'background 120ms',
      }}
    >
      <div
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: dotGlow,
          flexShrink: 0,
          animation: pulsing ? 'statusPulse 2s ease-in-out infinite' : undefined,
        }}
      />
      {windows && <WindowsBadge />}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12,
          fontWeight: 500,
          color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
          letterSpacing: '-0.005em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          opacity: actionsOpacity,
          transition: 'opacity 120ms',
          flexShrink: 0,
        }}
      >
        <RowAction icon={<ClaudeIcon />} hint="Open Claude here" onClick={onClaude} />
        <RowAction icon={<CodexIcon />} hint="Open Codex here" onClick={onCodex} />
        <RowAction icon={<CopyIcon />} hint="Duplicate" onClick={onCopy} />
      </div>
    </div>
  );
}

interface RowActionProps {
  icon: React.ReactNode;
  hint: string;
  onClick: () => void;
}

function RowAction({ icon, hint, onClick }: RowActionProps) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      title={hint}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        borderRadius: 5,
        background: hover ? 'rgba(255, 255, 255, 0.08)' : 'transparent',
        color: hover ? 'var(--text-secondary)' : 'var(--text-tertiary)',
        border: 'none',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'all 100ms',
      }}
    >
      {icon}
    </button>
  );
}
