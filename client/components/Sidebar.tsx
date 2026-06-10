import { useCallback, useEffect, useRef, useState } from 'react';
import { useTerminalStore } from '../hooks/useTerminalStore.js';
import { getDisplayName } from '../hooks/useSessionPolling.js';
import { apiFetch } from '../api.js';
import { isAgentProcess } from '../utils/agents.js';
import type { CanvasController } from '../hooks/useCanvas.js';
import { pinDir, unpinDir } from '../api/dirsApi.js';
import {
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
  LogoMark,
} from './icons.js';
import { SectionLabel } from './sidebar/SectionLabel.js';
import { DropdownItem } from './sidebar/DropdownItem.js';
import { RecentDirItem } from './sidebar/RecentDirItem.js';
import { SessionRow } from './sidebar/SessionRow.js';

const SIDEBAR_PINNED_KEY = 'terminal-board-sidebar-pinned';

interface SearchHit {
  sessionId: string;
  name: string;
  lineText: string;
  lineIndex: number;
}

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
  const removeTerminal = useTerminalStore((s) => s.removeTerminal);
  const attention = useTerminalStore((s) => s.attention);
  const dirsState = useTerminalStore((s) => s.dirsState);
  const setDirsState = useTerminalStore((s) => s.setDirsState);
  const [expanded, setExpanded] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [starMenuOpen, setStarMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_PINNED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchHit[]>([]);
  const addMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const starWrapperRef = useRef<HTMLDivElement | null>(null);

  // Panel is open while hovered or pinned-open.
  const isOpen = hovered || pinned;

  // Cross-terminal search: 300ms debounce against /api/search.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSearchResults(Array.isArray(data.results) ? data.results : []);
      } catch {
        if (!cancelled) setSearchResults([]);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [searchQuery]);

  const jumpToSession = useCallback((sessionId: string) => {
    const tw = Array.from(useTerminalStore.getState().terminals.values()).find(
      (w) => w.sessionId === sessionId
    );
    if (!tw) return;
    bringToFront(tw.id);
    setActive(tw.id);
    onFocusTerminal(tw.x, tw.y, tw.width, tw.height);
  }, [bringToFront, setActive, onFocusTerminal]);

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
      if (pinned) return; // stay open while pinned
      setHovered(false);
      setAddMenuOpen(false);
    }, 80);
  };

  const togglePinned = () => {
    setPinned((p) => {
      const next = !p;
      try {
        localStorage.setItem(SIDEBAR_PINNED_KEY, next ? '1' : '0');
      } catch { /* storage unavailable */ }
      if (next) setHovered(true);
      return next;
    });
  };

  const handleCloseSession = useCallback((id: string) => {
    const tw = useTerminalStore.getState().terminals.get(id);
    if (!tw) return;
    const dirty = useTerminalStore.getState().dirtyWindows.has(id);
    const message = dirty
      ? '未保存の変更があります。閉じますか?'
      : 'このセッションを終了しますか?';
    if (!window.confirm(message)) return;
    const isNonTerminal = tw.type === 'browser' || tw.type === 'memo';
    if (!isNonTerminal) {
      apiFetch(`/api/terminals/${tw.sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    removeTerminal(id);
  }, [removeTerminal]);

  const handleTogglePin = useCallback(async (cwd: string) => {
    const isPinned = useTerminalStore.getState().dirsState.pinned.includes(cwd);
    const updated = isPinned ? await unpinDir(cwd) : await pinDir(cwd);
    if (updated) setDirsState(updated);
  }, [setDirsState]);

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
  const contentTransition = isOpen
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
          width: isOpen ? expandedWidth : collapsedWidth,
          overflow: isOpen ? 'visible' : 'hidden',
          transition: `width ${motionMs}ms ${ease}, overflow 0s linear ${isOpen ? motionMs : 0}ms`,
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
            onClick={togglePinned}
            aria-label={pinned ? 'サイドバーのピン留めを解除' : 'サイドバーをピン留め'}
            title={pinned ? 'ピン留めを解除' : 'ピン留め'}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 18,
              height: 18,
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              flexShrink: 0,
              opacity: pinned ? 1 : 0.85,
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
              opacity: isOpen ? 1 : 0,
              transform: isOpen ? 'translateX(0)' : 'translateX(-6px)',
              transition: contentTransition,
              pointerEvents: isOpen ? 'auto' : 'none',
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
            {attention.size > 0 && (
              <span
                title={`${attention.size} 件が完了/入力待ち`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minWidth: 15,
                  height: 15,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: 'var(--accent-yellow)',
                  color: '#1a1b26',
                  fontSize: 9,
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  animation: 'statusPulse 2s ease-in-out infinite',
                }}
              >
                {attention.size}
              </span>
            )}
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

        {/* Cross-terminal search */}
        {isOpen && (
          <div
            style={{
              borderTop: '1px solid var(--border-hair)',
              padding: '6px 8px',
            }}
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ターミナルを検索..."
              style={{
                width: '100%',
                height: 26,
                padding: '0 8px',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                borderRadius: 6,
                color: 'var(--text-secondary)',
                fontSize: 11.5,
                fontFamily: 'inherit',
                outline: 'none',
                boxSizing: 'border-box',
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Escape') setSearchQuery('');
              }}
            />
            {searchQuery.trim() && (
              <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto' }}>
                {searchResults.length === 0 ? (
                  <div style={{ padding: '6px 4px', fontSize: 10.5, color: 'var(--text-ghost)' }}>
                    一致なし
                  </div>
                ) : (
                  searchResults.map((hit, i) => (
                    <button
                      key={`${hit.sessionId}-${hit.lineIndex}-${i}`}
                      type="button"
                      onClick={() => jumpToSession(hit.sessionId)}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 1,
                        width: '100%',
                        textAlign: 'left',
                        padding: '5px 7px',
                        borderRadius: 6,
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--text-secondary)',
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--accent-blue)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {hit.name}
                      </span>
                      <span style={{ fontSize: 10, color: 'var(--text-ghost)', fontFamily: "'JetBrains Mono', 'SF Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {hit.lineText}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Session list */}
        {isOpen && expanded && (
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

              const subtitle = status
                ? [status.cwdShort, status.foregroundProcess].filter(Boolean).join(' · ')
                : undefined;

              return (
                <SessionRow
                  key={tw.id}
                  active={isActive}
                  dotColor={dotColor}
                  dotGlow={dotGlow}
                  pulsing={isPulsing}
                  windows={isWindows}
                  title={displayName}
                  subtitle={subtitle}
                  attention={attention.has(tw.id)}
                  onClick={() => handleClick(tw.id)}
                  onClaude={() => onClaudeTerminal(status?.cwd || '', tw.x + 40, tw.y + 40)}
                  onCodex={() => onCodexTerminal(status?.cwd || '', tw.x + 40, tw.y + 40)}
                  onCopy={() => onDuplicateTerminal(status?.cwd || '', tw.x + 40, tw.y + 40)}
                  onClose={() => handleCloseSession(tw.id)}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
