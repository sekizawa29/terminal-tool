import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import { apiFetch } from '../api.js';
import type { CanvasController } from '../hooks/useCanvas.js';
import type { SessionStatus } from '../types.js';
import {
  type DirsState,
  EMPTY_DIRS_STATE,
  fetchDirsState,
  pushRecentDir,
  pinDir,
  unpinDir,
} from '../api/dirsApi.js';
import {
  ClaudeIcon,
  CodexIcon,
  PowerShellIcon,
  TerminalIcon,
  SessionsIcon,
  CaretIcon,
  PlusIcon,
  FitIcon,
  AutoLayoutIcon,
  ExplorerIcon,
  MemoIcon,
  StarIcon,
  PinIcon,
  CopyIcon,
  LogoMark,
} from './icons.js';

interface SidebarProps {
  controller: CanvasController;
  onAddTerminal: () => void;
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

function shortDirLabel(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

const Logo = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 2px 0 0', flexShrink: 0 }}>
    <LogoMark />
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
  controller,
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
  const bringToFront = useTerminalStore((s) => s.bringToFront);
  const setActive = useTerminalStore((s) => s.setActive);
  const updateTerminal = useTerminalStore((s) => s.updateTerminal);
  const setSessionStatuses = useTerminalStore((s) => s.setSessionStatuses);
  const [expanded, setExpanded] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [starMenuOpen, setStarMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [dirsState, setDirsStateLocal] = useState<DirsState>(EMPTY_DIRS_STATE);
  const lastCwdBySession = useRef<Map<string, string>>(new Map());
  const dirsStateRef = useRef<DirsState>(EMPTY_DIRS_STATE);
  dirsStateRef.current = dirsState;
  const addMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const starWrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return () => {
      if (collapseTimer.current) clearTimeout(collapseTimer.current);
      if (addMenuTimer.current) clearTimeout(addMenuTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!starMenuOpen) return;
    const handlePointer = (e: MouseEvent) => {
      if (!starWrapperRef.current) return;
      if (starWrapperRef.current.contains(e.target as Node)) return;
      setStarMenuOpen(false);
    };
    document.addEventListener('mousedown', handlePointer);
    return () => document.removeEventListener('mousedown', handlePointer);
  }, [starMenuOpen]);

  const handleWrapperEnter = () => {
    if (collapseTimer.current) {
      clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    setHovered(true);
  };

  const handleWrapperLeave = () => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      if (starMenuOpen) return;
      setHovered(false);
      setAddMenuOpen(false);
    }, 80);
  };

  useEffect(() => {
    let active = true;
    // Pull initial persisted dirs so the menu is hydrated before the first cwd-diff.
    fetchDirsState().then((state) => {
      if (active && state) setDirsStateLocal(state);
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
        for (const tw of store.terminals.values()) {
          const status = map.get(tw.sessionId);
          if (status) {
            const name = getDisplayName(status);
            if (tw.title !== name) {
              updateTerminal(tw.id, { title: name });
            }
          }
        }
        const liveIds = new Set<string>();
        const newCwds: string[] = [];
        for (const s of data.statuses as SessionStatus[]) {
          liveIds.add(s.sessionId);
          if (!s.cwd) continue;
          if (lastCwdBySession.current.get(s.sessionId) === s.cwd) continue;
          lastCwdBySession.current.set(s.sessionId, s.cwd);
          if (dirsStateRef.current.recent[0] === s.cwd) continue;
          newCwds.push(s.cwd);
        }
        for (const id of lastCwdBySession.current.keys()) {
          if (!liveIds.has(id)) lastCwdBySession.current.delete(id);
        }
        // Push each new cwd to the server in order; server enforces the dedupe + 5-cap.
        for (const cwd of newCwds) {
          const updated = await pushRecentDir(cwd);
          if (!active) return;
          if (updated) setDirsStateLocal(updated);
        }
      } catch { /* server unavailable */ }
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => { active = false; clearInterval(interval); };
  }, [updateTerminal, setSessionStatuses]);

  const handleTogglePin = useCallback(async (cwd: string) => {
    const isPinned = dirsStateRef.current.pinned.includes(cwd);
    const updated = isPinned ? await unpinDir(cwd) : await pinDir(cwd);
    if (updated) setDirsStateLocal(updated);
  }, []);

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

  const panelShadow = [
    '0 1px 0 rgba(255, 255, 255, 0.06) inset',
    '0 0 0 1px rgba(0, 0, 0, 0.4)',
    '0 14px 32px -8px rgba(0, 0, 0, 0.65)',
    '0 4px 10px -2px rgba(0, 0, 0, 0.45)',
  ].join(', ');

  const ease = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const motionMs = 460;

  const collapsedWidth = 42;
  const expandedWidth = 348;
  const contentTransition = hovered
    ? `opacity ${Math.round(motionMs * 0.55)}ms ${ease} ${Math.round(motionMs * 0.4)}ms, transform ${Math.round(motionMs * 0.55)}ms ${ease} ${Math.round(motionMs * 0.4)}ms`
    : `opacity ${Math.round(motionMs * 0.35)}ms ${ease} 0ms, transform ${Math.round(motionMs * 0.45)}ms ${ease} 0ms`;

  return (
    <div
      onMouseEnter={handleWrapperEnter}
      onMouseLeave={handleWrapperLeave}
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
          boxShadow: panelShadow,
          width: hovered ? expandedWidth : collapsedWidth,
          overflow: hovered ? 'visible' : 'hidden',
          transition: `width ${motionMs}ms ${ease}, overflow 0s linear ${hovered ? motionMs : 0}ms`,
          willChange: 'width',
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
          {/* Always-visible logo icon */}
          <button
            type="button"
            onClick={handleWrapperEnter}
            aria-label="tboardメニューを開く"
            title="tboard"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: hovered ? 'default' : 'pointer',
              flexShrink: 0,
            }}
          >
            <LogoMark />
          </button>

          {/* Right-side cluster — fades in after the box widens */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              marginLeft: 7,
              opacity: hovered ? 1 : 0,
              transform: hovered ? 'translateX(0)' : 'translateX(-6px)',
              transition: contentTransition,
              pointerEvents: hovered ? 'auto' : 'none',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-primary)',
                letterSpacing: '-0.01em',
                lineHeight: 1,
                paddingRight: 2,
                flexShrink: 0,
              }}
            >
              tboard
            </span>
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
                  zIndex: 10010,
                }}
              >
                <div
                  style={{
                    background: 'linear-gradient(180deg, #232540 0%, #1c1d2e 100%)',
                    border: '1px solid rgba(122, 162, 247, 0.18)',
                    borderRadius: 12,
                    boxShadow: panelShadow,
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
                      const { offsetX, offsetY, scale } = controller.getTransform();
                      const cx = (window.innerWidth / 2 - offsetX) / scale;
                      const cy = (window.innerHeight / 2 - offsetY) / scale;
                      onPowershellTerminal(cx - 350, cy - 225);
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Pinned + recent directories — star dropdown */}
          <div ref={starWrapperRef} style={{ position: 'relative', flexShrink: 0 }}>
            {(() => {
              const pinnedSet = new Set(dirsState.pinned);
              const recentOnly = dirsState.recent.filter((d) => !pinnedSet.has(d));
              const hasAny = dirsState.pinned.length > 0 || recentOnly.length > 0;
              const hintText = hasAny
                ? 'ピン / 最近のディレクトリ'
                : 'ピン / 最近のディレクトリ (履歴なし)';
              const spawn = (dir: string, kind: 'terminal' | 'claude' | 'codex') => {
                setStarMenuOpen(false);
                const { offsetX, offsetY, scale } = controller.getTransform();
                const cx = (window.innerWidth / 2 - offsetX) / scale;
                const cy = (window.innerHeight / 2 - offsetY) / scale;
                const x = cx - 350;
                const y = cy - 225;
                if (kind === 'claude') onClaudeTerminal(dir, x, y);
                else if (kind === 'codex') onCodexTerminal(dir, x, y);
                else onDuplicateTerminal(dir, x, y);
              };
              return (
                <>
                  <ToolbarButton
                    icon={<StarIcon />}
                    hint={hintText}
                    onClick={() => {
                      if (!hasAny) return;
                      setStarMenuOpen((p) => !p);
                    }}
                    active={starMenuOpen}
                    tone="explorer"
                  />
                  {starMenuOpen && hasAny && (
                    <div
                      style={{
                        position: 'absolute',
                        top: '100%',
                        left: -4,
                        paddingTop: 6,
                        zIndex: 10010,
                      }}
                    >
                      <div
                        style={{
                          background: 'linear-gradient(180deg, #232540 0%, #1c1d2e 100%)',
                          border: '1px solid rgba(122, 162, 247, 0.18)',
                          borderRadius: 12,
                          boxShadow: panelShadow,
                          padding: 4,
                          minWidth: 280,
                          maxWidth: 380,
                          animation: 'slideInUp 140ms var(--ease-out) both',
                        }}
                      >
                        {dirsState.pinned.length > 0 && (
                          <>
                            <SectionLabel text="ピン留め" />
                            {dirsState.pinned.map((dir) => (
                              <RecentDirItem
                                key={`pinned-${dir}`}
                                cwd={dir}
                                pinned
                                onOpenTerminal={() => spawn(dir, 'terminal')}
                                onOpenClaude={() => spawn(dir, 'claude')}
                                onOpenCodex={() => spawn(dir, 'codex')}
                                onTogglePin={() => handleTogglePin(dir)}
                              />
                            ))}
                          </>
                        )}
                        {recentOnly.length > 0 && (
                          <>
                            <SectionLabel text="最近" />
                            {recentOnly.map((dir) => (
                              <RecentDirItem
                                key={`recent-${dir}`}
                                cwd={dir}
                                pinned={false}
                                onOpenTerminal={() => spawn(dir, 'terminal')}
                                onOpenClaude={() => spawn(dir, 'claude')}
                                onOpenCodex={() => spawn(dir, 'codex')}
                                onTogglePin={() => handleTogglePin(dir)}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
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
        </div>

        {/* Session list */}
        {hovered && expanded && (
          <div
            style={{
              position: 'relative',
              zIndex: 0,
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

interface RecentDirItemProps {
  cwd: string;
  pinned: boolean;
  onOpenTerminal: () => void;
  onOpenClaude: () => void;
  onOpenCodex: () => void;
  onTogglePin: () => void;
}

function SectionLabel({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: '6px 10px 4px',
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-ghost)',
      }}
    >
      {text}
    </div>
  );
}

function RecentDirItem({ cwd, pinned, onOpenTerminal, onOpenClaude, onOpenCodex, onTogglePin }: RecentDirItemProps) {
  const [hover, setHover] = useState(false);
  const name = shortDirLabel(cwd);
  return (
    <div
      onClick={onOpenTerminal}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={cwd}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        borderRadius: 7,
        cursor: 'pointer',
        background: hover ? 'rgba(255, 255, 255, 0.035)' : 'transparent',
        transition: 'background 120ms',
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          color: pinned ? 'var(--accent-yellow)' : 'var(--text-ghost)',
        }}
      >
        <StarIcon filled={pinned} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            color: 'var(--text-primary)',
            fontWeight: 500,
            fontSize: 12,
            letterSpacing: '-0.005em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        <span
          style={{
            color: 'var(--text-ghost)',
            fontSize: 10,
            fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {cwd}
        </span>
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          opacity: hover ? 1 : 0.35,
          transition: 'opacity 120ms',
          flexShrink: 0,
        }}
      >
        <RowAction
          icon={<PinIcon filled={pinned} />}
          hint={pinned ? 'ピン留めを解除' : 'ピン留めする'}
          onClick={onTogglePin}
          activeColor={pinned ? 'var(--accent-yellow)' : undefined}
        />
        <RowAction icon={<ClaudeIcon />} hint="このディレクトリで Claude を開く" onClick={onOpenClaude} />
        <RowAction icon={<CodexIcon />} hint="このディレクトリで Codex を開く" onClick={onOpenCodex} />
        <RowAction icon={<TerminalIcon />} hint="このディレクトリで Terminal を開く" onClick={onOpenTerminal} />
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
  activeColor?: string;
}

function RowAction({ icon, hint, onClick, activeColor }: RowActionProps) {
  const [hover, setHover] = useState(false);
  const color = activeColor
    ? activeColor
    : hover
      ? 'var(--text-secondary)'
      : 'var(--text-tertiary)';
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
        color,
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
