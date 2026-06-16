import { create } from 'zustand';

// App-level UI preferences (not tied to terminals/layout). Persisted to
// localStorage so they survive reloads. Read non-reactively at event time via
// useSettings.getState() in hot paths (e.g. the canvas pan handler); subscribe
// in React for the settings toggle UI.
const SETTINGS_KEY = 'terminal-board-settings';
const SETTINGS_VERSION = 1;

export interface AppSettings {
  // When on, a drag that starts over a terminal pans the board instead of
  // selecting text. This lets the macOS three-finger-drag gesture move the
  // board even while the pointer is over a terminal. Turn off to select text.
  panOverTerminals: boolean;
}

const DEFAULTS: AppSettings = {
  // Off by default so a plain drag keeps selecting/copying terminal text.
  // Turn on to make drags over a terminal pan the board instead.
  panOverTerminals: false,
};

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
      // Spread defaults first so a partial/older blob still gets new keys.
      return { ...DEFAULTS, ...parsed.settings };
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
}

export const useSettings = create<SettingsState>((set, get) => {
  const save = () => persistSettings({ panOverTerminals: get().panOverTerminals });
  return {
    ...loadSettings(),
    setPanOverTerminals: (value) => { set({ panOverTerminals: value }); save(); },
    togglePanOverTerminals: () => { set({ panOverTerminals: !get().panOverTerminals }); save(); },
  };
});
