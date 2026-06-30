import { create } from 'zustand';

// App-level UI preferences (not tied to terminals/layout). Persisted to
// localStorage so they survive reloads. Read non-reactively at event time via
// useSettings.getState() in hot paths (e.g. the canvas pan/zoom handlers);
// subscribe in React for the settings toggle UI.
const SETTINGS_KEY = 'terminal-board-settings';
const SETTINGS_VERSION = 1;

// Bounds for the wheel-zoom tuning knobs (exported for the settings UI).
export const ZOOM_STEP_MIN = 1;
export const ZOOM_STEP_MAX = 50;
export const ZOOM_NOTCH_MIN = 10;
export const ZOOM_NOTCH_MAX = 1000;

export interface AppSettings {
  // When on, a drag that starts over a terminal pans the board instead of
  // selecting text. This lets the macOS three-finger-drag gesture move the
  // board even while the pointer is over a terminal. Turn off to select text.
  panOverTerminals: boolean;

  // Ctrl/⌘+wheel board zoom feel. The zoom is deliberately decoupled from the
  // OS scroll-speed setting: deltaY is accumulated and every time it crosses
  // `zoomNotchSize` pixels exactly one fixed step of `zoomStepPercent`
  // percentage points is applied. So one logical "notch" always changes the
  // zoom by the same amount regardless of how many wheel events the OS emits.
  //   zoomStepPercent — how many % one step changes the zoom (e.g. 5 → +5%).
  //   zoomNotchSize   — how much wheel scroll (px) makes one step. Raise this
  //                     if a single notch zooms too far (common on macOS with a
  //                     high system scroll speed); lower it for more sensitivity.
  zoomStepPercent: number;
  zoomNotchSize: number;
}

const DEFAULTS: AppSettings = {
  // Off by default so a plain drag keeps selecting/copying terminal text.
  // Turn on to make drags over a terminal pan the board instead.
  panOverTerminals: false,
  zoomStepPercent: 5,
  zoomNotchSize: 100,
};

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object'
      && parsed.version === SETTINGS_VERSION
      && parsed.settings && typeof parsed.settings === 'object'
    ) {
      // Spread defaults first so a partial/older blob still gets new keys,
      // then clamp the numeric knobs in case the stored blob is out of range.
      const merged = { ...DEFAULTS, ...parsed.settings };
      return {
        ...merged,
        zoomStepPercent: clampNum(merged.zoomStepPercent, ZOOM_STEP_MIN, ZOOM_STEP_MAX, DEFAULTS.zoomStepPercent),
        zoomNotchSize: clampNum(merged.zoomNotchSize, ZOOM_NOTCH_MIN, ZOOM_NOTCH_MAX, DEFAULTS.zoomNotchSize),
      };
    }
  } catch {
    // corrupted
  }
  return DEFAULTS;
}

function persistSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, settings }));
  } catch {
    // quota exceeded
  }
}

interface SettingsState extends AppSettings {
  setPanOverTerminals: (value: boolean) => void;
  togglePanOverTerminals: () => void;
  setZoomStepPercent: (value: number) => void;
  setZoomNotchSize: (value: number) => void;
}

export const useSettings = create<SettingsState>((set, get) => {
  const save = () => persistSettings({
    panOverTerminals: get().panOverTerminals,
    zoomStepPercent: get().zoomStepPercent,
    zoomNotchSize: get().zoomNotchSize,
  });
  return {
    ...loadSettings(),
    setPanOverTerminals: (value) => { set({ panOverTerminals: value }); save(); },
    togglePanOverTerminals: () => { set({ panOverTerminals: !get().panOverTerminals }); save(); },
    setZoomStepPercent: (value) => {
      set({ zoomStepPercent: clampNum(value, ZOOM_STEP_MIN, ZOOM_STEP_MAX, DEFAULTS.zoomStepPercent) });
      save();
    },
    setZoomNotchSize: (value) => {
      set({ zoomNotchSize: clampNum(value, ZOOM_NOTCH_MIN, ZOOM_NOTCH_MAX, DEFAULTS.zoomNotchSize) });
      save();
    },
  };
});
