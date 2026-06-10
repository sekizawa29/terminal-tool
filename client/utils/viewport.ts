// Viewport geometry helpers shared by offscreen-attention (6.1) and the minimap
// (6.2). A window's world-space rect is projected to screen space via the
// canvas transform: screen = world * scale + offset.
import type { CanvasTransform } from '../hooks/useCanvas.js';
import type { TerminalWindow } from '../types.js';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Screen-space rect of a window under the current transform.
export function windowScreenRect(tw: TerminalWindow, t: CanvasTransform): Rect {
  const left = tw.x * t.scale + t.offsetX;
  const top = tw.y * t.scale + t.offsetY;
  return {
    left,
    top,
    right: left + tw.width * t.scale,
    bottom: top + tw.height * t.scale,
  };
}

// True when any part of the window is visible in the browser viewport.
export function isWindowInViewport(
  tw: TerminalWindow,
  t: CanvasTransform,
  vpWidth: number = window.innerWidth,
  vpHeight: number = window.innerHeight
): boolean {
  const r = windowScreenRect(tw, t);
  return r.right > 0 && r.left < vpWidth && r.bottom > 0 && r.top < vpHeight;
}

// Screen-space center point of a window under the current transform.
export function windowScreenCenter(tw: TerminalWindow, t: CanvasTransform): { x: number; y: number } {
  const r = windowScreenRect(tw, t);
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
}
