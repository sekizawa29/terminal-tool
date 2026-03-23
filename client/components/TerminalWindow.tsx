import { useCallback, useRef, useState } from 'react';
import TerminalContent from './TerminalContent.js';
import BrowserContent from './BrowserContent.js';
import ExplorerContent from './ExplorerContent.js';
import EditorContent from './EditorContent.js';
import MemoContent from './MemoContent.js';
import ResizeHandle from './ResizeHandle.js';
import type { TerminalWindow as TWType } from '../types.js';
import { useTerminalStore } from '../hooks/useTerminalStore.js';

const AGENT_PROCESSES = new Set([
  'claude', 'codex', 'aider', 'cursor', 'copilot',
  'cline', 'roo',
]);

interface TerminalWindowProps {
  tw: TWType;
  token: string;
  scale: number;
  onZoom: (deltaY: number, clientX: number, clientY: number) => void;
  onOpenFile?: (filePath: string, fileName: string, nearX: number, nearY: number) => void;
}

const MIN_WIDTH = 300;
const MIN_HEIGHT = 200;

export default function TerminalWindow({ tw, token, scale, onZoom, onOpenFile }: TerminalWindowProps) {
  const { updateTerminal, removeTerminal, bringToFront, setActive, activeTerminalId, saveLayout } =
    useTerminalStore();

  // Subscribe to only the fields we need (avoid re-render on every mousemove)
  const linkDragActive = useTerminalStore((s) => s.linkDrag.active);
  const linkDragSourceId = useTerminalStore((s) => s.linkDrag.sourceId);
  const startLinkDrag = useTerminalStore((s) => s.startLinkDrag);
  const addLink = useTerminalStore((s) => s.addLink);
  const endLinkDrag = useTerminalStore((s) => s.endLinkDrag);

  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const [closeHovered, setCloseHovered] = useState(false);
  const [connectorHovered, setConnectorHovered] = useState(false);

  const isBrowser = tw.type === 'browser';
  const isExplorer = tw.type === 'explorer';
  const isEditor = tw.type === 'editor';
  const isMemo = tw.type === 'memo';
  const status = useTerminalStore((s) => s.sessionStatuses.get(tw.sessionId));
  const isWindows = status?.shellType === 'windows';
  const isAgentProcessing = !!(
    !isBrowser &&
    status &&
    status.isRunning &&
    AGENT_PROCESSES.has(status.foregroundProcess) &&
    status.isProcessing
  );

  const isActive = activeTerminalId === tw.id;
  const isDropTarget = linkDragActive && linkDragSourceId !== tw.id;

  const onTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging.current = true;
      dragStart.current = { x: e.clientX, y: e.clientY };
      bringToFront(tw.id);
      setActive(tw.id);

      const onMouseMove = (e: MouseEvent) => {
        if (!dragging.current) return;
        const dx = (e.clientX - dragStart.current.x) / scale;
        const dy = (e.clientY - dragStart.current.y) / scale;
        dragStart.current = { x: e.clientX, y: e.clientY };
        updateTerminal(tw.id, { x: tw.x + dx, y: tw.y + dy });
        tw.x += dx;
        tw.y += dy;
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        saveLayout();
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [tw, scale, updateTerminal, bringToFront, setActive, saveLayout]
  );

  const onResize = useCallback(
    (dx: number, dy: number) => {
      const newWidth = Math.max(MIN_WIDTH, tw.width + dx);
      const newHeight = Math.max(MIN_HEIGHT, tw.height + dy);
      updateTerminal(tw.id, { width: newWidth, height: newHeight });
      tw.width = newWidth;
      tw.height = newHeight;
    },
    [tw, updateTerminal]
  );

  const onResizeEnd = useCallback(() => {
    saveLayout();
  }, [saveLayout]);

  const onWindowClick = useCallback(() => {
    bringToFront(tw.id);
    setActive(tw.id);
  }, [tw.id, bringToFront, setActive]);

  const onClose = useCallback(() => {
    if (!isBrowser && !isMemo) {
      fetch(`/api/terminals/${tw.sessionId}`, { method: 'DELETE' }).catch(() => {});
    }
    removeTerminal(tw.id);
    saveLayout();
  }, [tw.id, tw.sessionId, isBrowser, isMemo, removeTerminal, saveLayout]);

  const onUrlChange = useCallback((url: string) => {
    updateTerminal(tw.id, { url, title: url.replace(/^https?:\/\//, '').split('/')[0] || url });
    saveLayout();
  }, [tw.id, updateTerminal, saveLayout]);

  // Link connector: start drag
  const onStartConnector = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      bringToFront(tw.id);
      setActive(tw.id);
      startLinkDrag(tw.id);
    },
    [tw.id, bringToFront, setActive, startLinkDrag]
  );

  // Link drop target: complete link on mouseUp
  const onDropLink = useCallback(
    (e: React.MouseEvent) => {
      if (linkDragActive && linkDragSourceId && linkDragSourceId !== tw.id) {
        e.stopPropagation();
        addLink(linkDragSourceId, tw.id);
        endLinkDrag();
      }
    },
    [linkDragActive, linkDragSourceId, tw.id, addLink, endLinkDrag]
  );

  return (
    <div
      className="terminal-window-enter"
      onMouseDown={onWindowClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseUp={onDropLink}
      style={{
        position: 'absolute',
        left: tw.x,
        top: tw.y,
        width: tw.width,
        height: tw.height,
        zIndex: tw.zIndex,
        overflow: 'visible',
      }}
    >
      {/* Inner window container — rendered FIRST so connectors are on top */}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          position: 'relative',
          zIndex: 1,
          border: isDropTarget
            ? '1px solid rgba(187, 154, 247, 0.6)'
            : isAgentProcessing
            ? '1px solid rgba(224, 175, 104, 0.6)'
            : isActive
            ? '1px solid rgba(122, 162, 247, 0.5)'
            : isHovered
            ? '1px solid var(--border-strong)'
            : '1px solid var(--border-subtle)',
          boxShadow: isDropTarget
            ? '0 0 24px rgba(187, 154, 247, 0.15), var(--shadow-window)'
            : isAgentProcessing
            ? '0 0 0 1px rgba(224, 175, 104, 0.5), 0 0 20px rgba(224, 175, 104, 0.15), 0 0 40px rgba(224, 175, 104, 0.08), 0 8px 32px rgba(0, 0, 0, 0.5)'
            : isActive
            ? 'var(--shadow-glow)'
            : isHovered
            ? 'var(--shadow-lg)'
            : 'var(--shadow-window)',
          animation: isAgentProcessing ? 'borderGlowPulse 2s ease-in-out infinite' : undefined,
          transition:
            'border-color var(--duration-normal) var(--ease-out), box-shadow var(--duration-slow) var(--ease-out)',
        }}
      >
        {/* Title bar — macOS-inspired */}
        <div
          onMouseDown={onTitleMouseDown}
          style={{
            height: 36,
            background: isActive
              ? 'linear-gradient(180deg, #1f2033 0%, #1a1b2a 100%)'
              : 'linear-gradient(180deg, #1a1b28 0%, #16171f 100%)',
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            cursor: 'grab',
            userSelect: 'none',
            flexShrink: 0,
            gap: 10,
            borderBottom: '1px solid rgba(0, 0, 0, 0.3)',
            transition: 'background var(--duration-normal)',
          }}
        >
          {/* Traffic light — close button */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              width: 12,
            }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              onMouseEnter={() => setCloseHovered(true)}
              onMouseLeave={() => setCloseHovered(false)}
              style={{
                width: 12,
                height: 12,
                borderRadius: '50%',
                border: 'none',
                background: closeHovered
                  ? 'var(--accent-red)'
                  : isActive
                  ? 'rgba(247, 118, 142, 0.4)'
                  : 'var(--border-default)',
                cursor: 'pointer',
                padding: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all var(--duration-fast) var(--ease-out)',
                boxShadow: closeHovered ? '0 0 6px rgba(247, 118, 142, 0.4)' : 'none',
              }}
            >
              {closeHovered && (
                <svg width="6" height="6" viewBox="0 0 6 6" fill="none">
                  <path
                    d="M1 1l4 4M5 1l-4 4"
                    stroke="#1a1b26"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              )}
            </button>
          </div>

          {/* Title */}
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              overflow: 'hidden',
            }}
          >
            {isWindows && (
              <span style={{
                fontSize: 8.5,
                fontWeight: 700,
                color: '#0078D4',
                background: 'rgba(0, 120, 212, 0.15)',
                padding: '1px 4px',
                borderRadius: 3,
                letterSpacing: '0.02em',
                lineHeight: '13px',
                flexShrink: 0,
              }}>
                WIN
              </span>
            )}
            <span
              style={{
                fontSize: 11.5,
                fontWeight: 500,
                color: isActive ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                letterSpacing: '0.2px',
                transition: 'color var(--duration-normal)',
              }}
            >
              {tw.title}
            </span>
          </div>

          {/* Right spacer to balance the close button */}
          <div style={{ width: 12 }} />
        </div>

        {/* Content */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {isBrowser ? (
            <BrowserContent
              url={tw.url || 'about:blank'}
              isActive={isActive}
              onUrlChange={onUrlChange}
            />
          ) : isExplorer ? (
            <ExplorerContent
              rootPath={tw.explorerRoot || '/'}
              isActive={isActive}
              onOpenFile={(filePath, fileName) => {
                onOpenFile?.(filePath, fileName, tw.x + tw.width + 20, tw.y);
              }}
              onNavigate={(newRoot) => {
                updateTerminal(tw.id, { explorerRoot: newRoot, title: newRoot.split('/').pop() || 'Explorer' });
                saveLayout();
              }}
            />
          ) : isEditor ? (
            <EditorContent
              filePath={tw.filePath || ''}
              isActive={isActive}
            />
          ) : isMemo ? (
            <MemoContent
              windowId={tw.id}
              isActive={isActive}
            />
          ) : (
            <TerminalContent
              sessionId={tw.sessionId}
              token={token}
              isActive={isActive}
              scale={scale}
              onZoom={onZoom}
              onExit={onClose}
            />
          )}
          <ResizeHandle onResize={onResize} onResizeEnd={onResizeEnd} scale={scale} />
        </div>
      </div>

      {/* Right connector — drag source (only for terminals) */}
      {!isBrowser && !isExplorer && !isEditor && !isMemo && (
        <div
          onMouseDown={onStartConnector}
          onMouseEnter={() => setConnectorHovered(true)}
          onMouseLeave={() => setConnectorHovered(false)}
          style={{
            position: 'absolute',
            right: -7,
            top: '50%',
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: connectorHovered ? '#7dcfff' : 'rgba(125, 207, 255, 0.5)',
            border: '2px solid var(--bg-base)',
            cursor: 'crosshair',
            zIndex: 20,
            opacity: isHovered || linkDragActive ? 1 : 0,
            transition: 'opacity 0.2s, background 0.15s',
            transform: connectorHovered
              ? 'translateY(-50%) scale(1.3)'
              : 'translateY(-50%)',
            boxShadow: connectorHovered
              ? '0 0 10px rgba(125, 207, 255, 0.5)'
              : '0 0 4px rgba(125, 207, 255, 0.2)',
          }}
        />
      )}

      {/* Left connector — target indicator during link drag (only for terminals) */}
      {isDropTarget && !isBrowser && !isExplorer && !isEditor && (
        <div
          style={{
            position: 'absolute',
            left: -7,
            top: '50%',
            transform: 'translateY(-50%)',
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: 'rgba(187, 154, 247, 0.6)',
            border: '2px solid var(--bg-base)',
            zIndex: 20,
            boxShadow: '0 0 8px rgba(187, 154, 247, 0.4)',
            animation: 'breathe 1.5s ease-in-out infinite',
          }}
        />
      )}
    </div>
  );
}
