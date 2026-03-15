import { useCallback, useRef, useState } from 'react';
import type { TerminalWindow } from '../types.js';

const MIN_SCALE = 0.1;
const MAX_SCALE = 3.0;

export interface CanvasTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export function useCanvas() {
  const [transform, setTransform] = useState<CanvasTransform>({
    offsetX: 0,
    offsetY: 0,
    scale: 1,
  });

  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOffset = useRef({ x: 0, y: 0 });
  const spaceDown = useRef(false);

  const startPan = useCallback((clientX: number, clientY: number) => {
    isPanning.current = true;
    panStart.current = { x: clientX, y: clientY };
    panOffset.current = { x: transform.offsetX, y: transform.offsetY };
  }, [transform.offsetX, transform.offsetY]);

  const updatePan = useCallback((clientX: number, clientY: number) => {
    if (!isPanning.current) return;
    const dx = clientX - panStart.current.x;
    const dy = clientY - panStart.current.y;
    setTransform(t => ({
      ...t,
      offsetX: panOffset.current.x + dx,
      offsetY: panOffset.current.y + dy,
    }));
  }, []);

  const endPan = useCallback(() => {
    isPanning.current = false;
  }, []);

  const zoom = useCallback((deltaY: number, clientX: number, clientY: number) => {
    setTransform(t => {
      const factor = deltaY < 0 ? 1.1 : 0.9;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, t.scale * factor));
      const scaleChange = newScale / t.scale;
      const newOffsetX = clientX - (clientX - t.offsetX) * scaleChange;
      const newOffsetY = clientY - (clientY - t.offsetY) * scaleChange;
      return { offsetX: newOffsetX, offsetY: newOffsetY, scale: newScale };
    });
  }, []);

  const setSpaceDown = useCallback((down: boolean) => {
    spaceDown.current = down;
  }, []);

  const getIsSpaceDown = useCallback(() => spaceDown.current, []);
  const getIsPanning = useCallback(() => isPanning.current, []);

  // Pan canvas so that a given terminal (x, y, w, h) is centered in the viewport
  const focusOn = useCallback((x: number, y: number, width: number, height: number) => {
    setTransform(t => {
      const centerX = x + width / 2;
      const centerY = y + height / 2;
      return {
        ...t,
        offsetX: window.innerWidth / 2 - centerX * t.scale,
        offsetY: window.innerHeight / 2 - centerY * t.scale,
      };
    });
  }, []);

  const zoomToFit = useCallback((terminals: Map<string, TerminalWindow>) => {
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
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(scaleX, scaleY)));

    const bboxCenterX = (minX + maxX) / 2;
    const bboxCenterY = (minY + maxY) / 2;

    setTransform({
      scale: newScale,
      offsetX: vpW / 2 - bboxCenterX * newScale,
      offsetY: vpH / 2 - bboxCenterY * newScale,
    });
  }, []);

  return {
    transform,
    startPan,
    updatePan,
    endPan,
    zoom,
    focusOn,
    zoomToFit,
    setSpaceDown,
    getIsSpaceDown,
    getIsPanning,
  };
}
