import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { MIN_SCALE, MAX_SCALE } from '../hooks/useCanvas.js';
import type { CanvasController } from '../hooks/useCanvas.js';
import {
  useSettings,
  ZOOM_STEP_MIN, ZOOM_STEP_MAX,
  ZOOM_NOTCH_MIN, ZOOM_NOTCH_MAX,
} from '../hooks/useSettings.js';

interface ZoomIndicatorProps {
  controller: CanvasController;
}

const MIN_PCT = Math.round(MIN_SCALE * 100);
const MAX_PCT = Math.round(MAX_SCALE * 100);
const STEP_PCT = 10;

export default function ZoomIndicator({ controller }: ZoomIndicatorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Wheel-zoom tuning (see useSettings). Subscribe reactively so the popover
  // reflects current values; the hot wheel path reads these via getState().
  const zoomStepPercent = useSettings((s) => s.zoomStepPercent);
  const zoomNotchSize = useSettings((s) => s.zoomNotchSize);
  const setZoomStepPercent = useSettings((s) => s.setZoomStepPercent);
  const setZoomNotchSize = useSettings((s) => s.setZoomNotchSize);

  // Re-render only this small component when the zoom changes (controller drives
  // transform imperatively otherwise).
  const scale = useSyncExternalStore(controller.subscribe, () => controller.getTransform().scale);
  const setScale = controller.setScale;

  const currentPct = Math.round(scale * 100);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = (raw: string) => {
    const n = parseInt(raw.replace(/[^\d-]/g, ''), 10);
    if (!Number.isNaN(n)) {
      const clamped = Math.min(MAX_PCT, Math.max(MIN_PCT, n));
      setScale(clamped / 100);
    }
    setEditing(false);
  };

  const stepBy = (deltaPct: number) => {
    const next = Math.min(MAX_PCT, Math.max(MIN_PCT, currentPct + deltaPct));
    setScale(next / 100);
  };

  const btnStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    lineHeight: 1,
    padding: 0,
    fontFamily: 'inherit',
  };

  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 6px',
        background: 'var(--glass-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: 8,
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.35)',
        zIndex: 100,
        userSelect: 'none',
        fontFamily: 'inherit',
      }}
    >
      {showSettings && (
        <ZoomSettingsPopover
          stepPercent={zoomStepPercent}
          notchSize={zoomNotchSize}
          onStepPercent={setZoomStepPercent}
          onNotchSize={setZoomNotchSize}
        />
      )}

      <button
        type="button"
        onClick={() => setShowSettings((v) => !v)}
        style={{ ...btnStyle, color: showSettings ? 'var(--text-primary)' : 'var(--text-secondary)', background: showSettings ? 'rgba(255,255,255,0.06)' : 'transparent' }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = showSettings ? 'rgba(255,255,255,0.06)' : 'transparent'; }}
        title="ホイールズームの感度設定"
        aria-label="ホイールズームの感度設定"
      >
        <GearIcon />
      </button>

      <button
        type="button"
        onClick={() => stepBy(-STEP_PCT)}
        disabled={currentPct <= MIN_PCT}
        style={{ ...btnStyle, opacity: currentPct <= MIN_PCT ? 0.35 : 1 }}
        onMouseEnter={(e) => { if (currentPct > MIN_PCT) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        title="Zoom out (10%)"
      >
        −
      </button>

      {editing ? (
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          defaultValue={String(currentPct)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
          style={{
            width: 46,
            textAlign: 'center',
            background: 'rgba(122, 162, 247, 0.10)',
            border: '1px solid var(--border-accent)',
            borderRadius: 4,
            color: 'var(--text-primary)',
            fontSize: 11.5,
            fontWeight: 600,
            padding: '3px 2px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(String(currentPct));
            setEditing(true);
          }}
          style={{
            minWidth: 46,
            height: 22,
            background: 'transparent',
            border: 'none',
            color: 'var(--text-primary)',
            cursor: 'text',
            fontSize: 11.5,
            fontWeight: 600,
            padding: '0 6px',
            borderRadius: 4,
            fontFamily: 'inherit',
            letterSpacing: '0.02em',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          title="Click to edit zoom %"
        >
          {currentPct}%
        </button>
      )}

      <button
        type="button"
        onClick={() => stepBy(STEP_PCT)}
        disabled={currentPct >= MAX_PCT}
        style={{ ...btnStyle, opacity: currentPct >= MAX_PCT ? 0.35 : 1 }}
        onMouseEnter={(e) => { if (currentPct < MAX_PCT) e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
        title="Zoom in (10%)"
      >
        +
      </button>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

interface StepperProps {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}

function Stepper({ label, hint, value, min, max, step, suffix, onChange }: StepperProps) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const sBtn: React.CSSProperties = {
    width: 22,
    height: 22,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid var(--glass-border)',
    color: 'var(--text-secondary)',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    lineHeight: 1,
    padding: 0,
    fontFamily: 'inherit',
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</div>
      {hint && <div style={{ fontSize: 9.5, color: 'var(--text-ghost)', lineHeight: 1.3 }}>{hint}</div>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          type="button"
          style={{ ...sBtn, opacity: value <= min ? 0.35 : 1 }}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - step))}
        >
          −
        </button>
        <div style={{
          minWidth: 52,
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {value}{suffix ?? ''}
        </div>
        <button
          type="button"
          style={{ ...sBtn, opacity: value >= max ? 0.35 : 1 }}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + step))}
        >
          +
        </button>
      </div>
    </div>
  );
}

interface ZoomSettingsPopoverProps {
  stepPercent: number;
  notchSize: number;
  onStepPercent: (value: number) => void;
  onNotchSize: (value: number) => void;
}

function ZoomSettingsPopover({ stepPercent, notchSize, onStepPercent, onNotchSize }: ZoomSettingsPopoverProps) {
  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        bottom: '100%',
        marginBottom: 8,
        width: 210,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '12px 14px',
        background: 'var(--glass-bg)',
        border: '1px solid var(--glass-border)',
        borderRadius: 10,
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45)',
        cursor: 'default',
      }}
    >
      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>
        ホイールズーム
      </div>
      <Stepper
        label="1目盛りの変化量"
        value={stepPercent}
        min={ZOOM_STEP_MIN}
        max={ZOOM_STEP_MAX}
        step={1}
        suffix="%"
        onChange={onStepPercent}
      />
      <Stepper
        label="感度"
        hint="1目盛りに必要なスクロール量。大きいほど鈍く（効きすぎ防止）。"
        value={notchSize}
        min={ZOOM_NOTCH_MIN}
        max={ZOOM_NOTCH_MAX}
        step={10}
        onChange={onNotchSize}
      />
    </div>
  );
}
