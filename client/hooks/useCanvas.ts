import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { TerminalWindow } from '../types.js';
import { useSettings } from './useSettings.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 3.0;

const CANVAS_KEY = 'terminal-board-canvas';
const CANVAS_VERSION = 1;

export interface CanvasTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

const DEFAULT_TRANSFORM: CanvasTransform = { offsetX: 0, offsetY: 0, scale: 1 };

// The controller owns the pan/zoom transform in a ref and applies it to the DOM
// imperatively (no React state), so panning/zooming never re-renders the tree.
// Consumers that need to react to transform changes subscribe() (e.g. the zoom
// indicator, minimap, edge badges); event-time consumers just call getTransform().
export interface CanvasController {
  getTransform(): CanvasTransform;
  subscribe(cb: () => void): () => void;
  startPan(clientX: number, clientY: number): void;
  updatePan(clientX: number, clientY: number): void;
  endPan(): void;
  panBy(deltaX: number, deltaY: number): void;
  zoom(deltaY: number, clientX: number, clientY: number): void;
  setScale(scale: number, anchorX?: number, anchorY?: number): void;
  focusOn(x: number, y: number, width: number, height: number): void;
  zoomToFit(terminals: Map<string, TerminalWindow>): void;
  setSpaceDown(down: boolean): void;
  getIsSpaceDown(): boolean;
  getIsPanning(): boolean;
  // Attach to the transform container and the dot-grid background respectively.
  containerRef: RefObject<HTMLDivElement>;
  gridRef: RefObject<HTMLDivElement>;
}

function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function loadTransform(): CanvasTransform {
  try {
    const raw = localStorage.getItem(CANVAS_KEY);
    if (!raw) return DEFAULT_TRANSFORM;
    const p = JSON.parse(raw);
    if (p && typeof p === 'object' && p.version === CANVAS_VERSION
      && typeof p.offsetX === 'number' && typeof p.offsetY === 'number' && typeof p.scale === 'number') {
      return { offsetX: p.offsetX, offsetY: p.offsetY, scale: clampScale(p.scale) };
    }
  } catch {
    // corrupted
  }
  return DEFAULT_TRANSFORM;
}

export function useCanvas(): CanvasController {
  const transformRef = useRef<CanvasTransform>(loadTransform());
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const listenersRef = useRef<Set<() => void>>(new Set());

  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const spaceDown = useRef(false);

  // Accumulated wheel scroll (px) and the time of the last wheel event, used to
  // turn a noisy stream of wheel events into discrete fixed zoom steps. See zoom().
  const wheelAccum = useRef(0);
  const lastWheelTs = useRef(0);

  // Build the controller exactly once; every method closes over stable refs.
  const controllerRef = useRef<CanvasController | null>(null);
  if (controllerRef.current === null) {
    const applyToDom = () => {
      const t = transformRef.current;
      const c = containerRef.current;
      if (c) {
        c.style.transform = `translate(${t.offsetX}px, ${t.offsetY}px) scale(${t.scale})`;
      }
      const g = gridRef.current;
      if (g) {
        const dotOpacity = Math.min(0.28, 0.15 + t.scale * 0.06);
        g.style.backgroundImage = `radial-gradient(circle, rgba(192, 202, 245, ${dotOpacity}) 0.8px, transparent 0.8px)`;
        g.style.backgroundSize = `${20 * t.scale}px ${20 * t.scale}px`;
        g.style.backgroundPosition = `${t.offsetX}px ${t.offsetY}px`;
      }
    };

    const commit = () => {
      applyToDom();
      for (const cb of listenersRef.current) {
        try { cb(); } catch { /* listener error shouldn't break panning */ }
      }
    };

    controllerRef.current = {
      getTransform: () => transformRef.current,
      subscribe(cb) {
        listenersRef.current.add(cb);
        return () => { listenersRef.current.delete(cb); };
      },
      startPan(clientX, clientY) {
        isPanning.current = true;
        panStart.current = { x: clientX, y: clientY };
        panOffset.current = { x: transformRef.current.offsetX, y: transformRef.current.offsetY };
        if (containerRef.current?.parentElement) containerRef.current.parentElement.style.cursor = 'grabbing';
      },
      updatePan(clientX, clientY) {
        if (!isPanning.current) return;
        const dx = clientX - panStart.current.x;
        const dy = clientY - panStart.current.y;
        transformRef.current = {
          ...transformRef.current,
          offsetX: panOffset.current.x + dx,
          offsetY: panOffset.current.y + dy,
        };
        commit();
      },
      endPan() {
        isPanning.current = false;
        if (containerRef.current?.parentElement) {
          containerRef.current.parentElement.style.cursor = 'grab';
        }
      },
      panBy(deltaX, deltaY) {
        if (deltaX === 0 && deltaY === 0) return;
        const t = transformRef.current;
        transformRef.current = { ...t, offsetX: t.offsetX + deltaX, offsetY: t.offsetY + deltaY };
        commit();
      },
      zoom(deltaY, clientX, clientY) {
        if (deltaY === 0) return;
        const { zoomStepPercent, zoomNotchSize } = useSettings.getState();
        const now = performance.now();

        // Decouple the zoom from the OS scroll-speed setting. macOS (especially
        // with a high system scroll amount + inertia) fires many wheel events
        // per physical notch, so applying a fixed step per *event* makes zoom
        // wildly over-sensitive. Instead we accumulate scroll distance and apply
        // one fixed step every `zoomNotchSize` pixels — independent of how many
        // events the OS emits. Reset the accumulator when the gesture pauses or
        // reverses so leftover scroll never bleeds into the next gesture.
        if (now - lastWheelTs.current > 250) wheelAccum.current = 0;
        if (wheelAccum.current !== 0 && Math.sign(deltaY) !== Math.sign(wheelAccum.current)) {
          wheelAccum.current = 0;
        }
        lastWheelTs.current = now;
        wheelAccum.current += deltaY;

        const notch = Math.max(1, zoomNotchSize);
        while (Math.abs(wheelAccum.current) >= notch) {
          const sign = wheelAccum.current > 0 ? 1 : -1;
          wheelAccum.current -= sign * notch;
          // deltaY > 0 (scroll down / toward the user) zooms out.
          const dir = -sign;
          const t = transformRef.current;
          const newScale = clampScale((t.scale * 100 + dir * zoomStepPercent) / 100);
          if (newScale === t.scale) continue;
          const scaleChange = newScale / t.scale;
          transformRef.current = {
            offsetX: clientX - (clientX - t.offsetX) * scaleChange,
            offsetY: clientY - (clientY - t.offsetY) * scaleChange,
            scale: newScale,
          };
          commit();
        }
      },
      setScale(newScale, anchorX, anchorY) {
        const t = transformRef.current;
        const clamped = clampScale(newScale);
        if (clamped === t.scale) return;
        const ax = anchorX ?? window.innerWidth / 2;
        const ay = anchorY ?? window.innerHeight / 2;
        const scaleChange = clamped / t.scale;
        transformRef.current = {
          offsetX: ax - (ax - t.offsetX) * scaleChange,
          offsetY: ay - (ay - t.offsetY) * scaleChange,
          scale: clamped,
        };
        commit();
      },
      focusOn(x, y, width, height) {
        const t = transformRef.current;
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        transformRef.current = {
          ...t,
          offsetX: window.innerWidth / 2 - centerX * t.scale,
          offsetY: window.innerHeight / 2 - centerY * t.scale,
        };
        commit();
      },
      zoomToFit(terminals) {
        if (terminals.size === 0) return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const tw of terminals.values()) {
          minX = Math.min(minX, tw.x);
          minY = Math.min(minY, tw.y);
          maxX = Math.max(maxX, tw.x + tw.width);
          maxY = Math.max(maxY, tw.y + tw.height);
        }
        const padding = 60;
        const bboxW = maxX - minX;
        const bboxH = maxY - minY;
        const vpW = window.innerWidth;
        const vpH = window.innerHeight;
        const scaleX = (vpW - padding * 2) / bboxW;
        const scaleY = (vpH - padding * 2) / bboxH;
        const newScale = clampScale(Math.min(scaleX, scaleY));
        const bboxCenterX = (minX + maxX) / 2;
        const bboxCenterY = (minY + maxY) / 2;
        transformRef.current = {
          scale: newScale,
          offsetX: vpW / 2 - bboxCenterX * newScale,
          offsetY: vpH / 2 - bboxCenterY * newScale,
        };
        commit();
      },
      setSpaceDown(down) { spaceDown.current = down; },
      getIsSpaceDown: () => spaceDown.current,
      getIsPanning: () => isPanning.current,
      containerRef,
      gridRef,
    };
  }

  const controller = controllerRef.current;

  // Apply the restored transform to the DOM once the refs are attached.
  useEffect(() => {
    const t = transformRef.current;
    const c = containerRef.current;
    if (c) c.style.transform = `translate(${t.offsetX}px, ${t.offsetY}px) scale(${t.scale})`;
    const g = gridRef.current;
    if (g) {
      const dotOpacity = Math.min(0.28, 0.15 + t.scale * 0.06);
      g.style.backgroundImage = `radial-gradient(circle, rgba(192, 202, 245, ${dotOpacity}) 0.8px, transparent 0.8px)`;
      g.style.backgroundSize = `${20 * t.scale}px ${20 * t.scale}px`;
      g.style.backgroundPosition = `${t.offsetX}px ${t.offsetY}px`;
    }
  }, []);

  // Persist pan/zoom 500ms after the last change (debounced via subscribe).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = controller.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          localStorage.setItem(CANVAS_KEY, JSON.stringify({ version: CANVAS_VERSION, ...transformRef.current }));
        } catch {
          // quota exceeded
        }
      }, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [controller]);

  return controller;
}

export { MIN_SCALE, MAX_SCALE };
