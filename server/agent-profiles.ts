// Agent TUI profiles.
//
// Busy-state, prompt, and noise detection used to be hard-coded to Claude Code's
// TUI inside pty-manager.ts, which meant any other agent (Codex) or a TUI update
// silently broke auto-inject timing and response extraction. A profile bundles
// those heuristics behind a stable interface so they can be swapped per session
// based on the foreground process name.

/**
 * Positional busy detection (shared across profiles).
 *
 * Why positional: a `some()`-style scan ("any busy affordance anywhere in the
 * tail ⇒ busy") regresses badly. After a short turn finishes, the agent's idle
 * input box returns at the bottom of the screen but the just-finished turn's
 * "esc to interrupt" / "(still processing...)" line is still sitting in the
 * 10-line tail as history, ABOVE the box. A `some()` scan then reports busy
 * forever even though the agent is plainly idle — and once `isBusy` is wired in
 * as a hard gate in canAutoInject, the dispatch outbox stops flushing for good.
 *
 * The fix keys off how these TUIs lay out the screen:
 *   - generating ⇒ the busy affordance is the bottom-most meaningful line; the
 *     idle input box is NOT drawn below it.
 *   - idle ⇒ the input box / prompt is the bottom-most line; any busy text is
 *     stale history scrolled up above it.
 *
 * So scan bottom-up and let whichever boundary we reach FIRST decide:
 *   - hit a busy line before any prompt line  ⇒ true  (generating now)
 *   - hit the current prompt line first       ⇒ false (idle; busy above is stale)
 *   - reach the top having seen neither       ⇒ null  (can't tell — defer to the
 *                                                       caller's quiet heuristic)
 *
 * Pure and side-effect free so it can be unit-tested directly (see
 * agent-profiles.test.ts). `isPromptLine`/`isBusyLine` are the per-profile
 * boundary predicates; they receive each tail line (already trimmed, newest
 * last) bottom-up.
 */
export function positionalBusy(
  tailLines: string[],
  isPromptLine: (line: string) => boolean,
  isBusyLine: (line: string) => boolean,
): boolean | null {
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!line) continue;
    // A busy affordance reached before the prompt boundary ⇒ generating now.
    if (isBusyLine(line)) return true;
    // The current prompt/input box reached first ⇒ idle; anything busy above it
    // is stale history and must be ignored.
    if (isPromptLine(line)) return false;
  }
  return null;
}

export interface AgentProfile {
  name: string;
  /** Foreground process names this profile applies to (normalized base names). */
  processNames: string[];
  /**
   * When true, `canAutoInject` skips all idle/busy/output heuristics and treats
   * the session as always injectable (after the human-typing guard).
   *
   * Grok-only: Grok repaints its TUI continuously (~10fps) even when idle, so an
   * injectable idle moment is never observable via output-activity or positional-
   * busy checks. Grok also serializes pushed input on its own side, so immediate
   * delivery is the most reliable strategy.
   *
   * NOTE: the isBusy / promptText / grokIsBusyLine logic on grokProfile is NOT
   * removed — it remains available for legacy/IPC response extraction. It is
   * simply no longer consulted for MAIN→Grok dispatch timing.
   */
  pushImmediately?: boolean;
  /**
   * The editable text at the prompt given the bottom-of-screen lines (already
   * trimmed, blanks removed, newest last). Three-valued:
   *   - ''   : an empty prompt is showing — idle, safe to inject
   *   - text : the prompt holds a draft — a human or the agent is typing
   *   - null : no recognizable prompt — caller falls back to its quiet-output heuristic
   */
  promptText(tailLines: string[]): string | null;
  /** Whether the screen looks like the agent is generating. Tri-state:
   *    - true : a busy affordance is the bottom-most boundary (generating now)
   *    - false: the current prompt/input box is at the bottom (idle — any busy
   *             text above it is stale history and is ignored)
   *    - null : neither boundary seen (can't tell — defer to the output-burst /
   *             30s-quiet heuristic)
   *  POSITIONAL, not a `some()` scan: see positionalBusy() for why. Wired into
   *  canAutoInject as a hard gate — only a `true` blocks; `false`/`null` defer to
   *  the prompt/quiet heuristics.
   *  NOTE for Grok: isBusy is not consulted for MAIN→Grok dispatch (see
   *  pushImmediately); it remains available for legacy/IPC response extraction. */
  isBusy(tailLines: string[]): boolean | null;
  /**
   * Submit strategy for pasteAndSubmit, all optional (defaults preserve the
   * historical Claude/Codex behavior: one `\r` after ~350ms, no extra enter):
   *   - submitDelayMs: ms to wait after the bracketed paste before the first
   *     Enter. Larger values give a big multi-line paste time to settle so the
   *     terminal/agent treats the following `\r` as submit, not a newline.
   *   - submitSequence: the keystrokes to send for the first submit attempt
   *     (default ['\r']). Sent in order with submitSequenceGapMs between them.
   *   - submitSequenceGapMs: ms between keystrokes within submitSequence.
   *   - extraEnterDelayMs: if set (>0), send one more `\r` this many ms after
   *     the first submit, unconditionally — a "double enter" for TUIs (Grok)
   *     where the first Enter after a paste can be swallowed. Independent of the
   *     needle-based retry, which still runs.
   */
  submitDelayMs?: number;
  submitSequence?: string[];
  submitSequenceGapMs?: number;
  extraEnterDelayMs?: number;
  /** True if this rendered line is TUI chrome that should be dropped. */
  isNoiseLine(line: string): boolean;
  /** Rewrite a decorated line (tool call / result) to plain text, or null. */
  rewriteLine(line: string): string | null;
  /** True if `line` (trimmed) is a prompt/echo line — used by the legacy IPC
   *  response extraction to locate the echoed command. */
  isPromptLine(line: string): boolean;
  /** Strip the prompt marker prefix from a prompt line, returning the text. */
  stripPromptMarker(line: string): string;
}

// ── Claude Code ────────────────────────────────────────────────────────
// The regex set below is the exact set that lived inline in pty-manager.ts;
// keep it authoritative for Claude so existing behavior is unchanged.

function claudeIsNoiseLine(trimmed: string): boolean {
  if (/esctointerrupt/i.test(trimmed) || /auto\s*mode\s*(temporarily\s*)?unavailable/i.test(trimmed)) return true;
  if (/^esc\s+to\s+interrupt/i.test(trimmed)) return true;
  if (/^Tip:/i.test(trimmed)) return true;
  if (/^Press\s+Ctrl/i.test(trimmed)) return true;
  if (/^\(\d+s\s*·\s*timeout\b/.test(trimmed)) return true;
  // Spinner/loading glyph + word
  if (/^[✶✻✽✢✹✷✸✺✼✾✿❀●○⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏*·]+\s*[A-Za-z]+.*/.test(trimmed)) return true;
  if (/^[A-Z][a-z]+ing…?\s*$/.test(trimmed)) return true;
  if (/^\(?thinking\s+with\s+(high|medium|low)\s+effort\)?$/i.test(trimmed)) return true;
  if (/^[─━═]{5,}$/.test(trimmed)) return true;
  if (/^❯/.test(trimmed)) return true;
  if (/\?\s+(for shortcuts|for help)/i.test(trimmed)) return true;
  if (/^●\s*(high|medium|low)\s*·\s*\//.test(trimmed)) return true;
  if (trimmed.length === 1 && /[✶✻✽✢✹✷✸✺✼✾✿❀●○·*⎿⎡⎤⎣⎦╭╮╰╯│]/.test(trimmed)) return true;
  if (/^\(ctrl\+[a-z] to \w+\)$/i.test(trimmed)) return true;
  if (/^Running…$/.test(trimmed)) return true;
  if (/\(running \w+ hook\)/i.test(trimmed)) return true;
  if (/^…\s*\+\d+ lines/.test(trimmed)) return true;
  if (/^[✶✻✽✢✹✷✸✺✼✾✿❀●○·*]\s*Cooked\s+for\b/i.test(trimmed)) return true;
  return false;
}

function claudeStatusLine(text: string): boolean {
  if (/image\s+in\s+clipboard\s*[·•]\s*ctrl\+v\s+to\s+paste/i.test(text)) return true;
  if (/\b(?:Opus|Sonnet|Haiku)\b.*\bcontext\b/i.test(text)) return true;
  if (/^[¥$]\s*[\d,.]+.*\b(session|today)\b/i.test(text)) return true;
  if (/\bauto\s*mode\b/i.test(text)) return true;
  if (/\bfor\s+agents\b/i.test(text)) return true;
  if (/^[^\s|]+\s+\|\s+(?:main|master|develop|dev|[\w./-]+)\s*$/i.test(text)) return true;
  return false;
}

function claudeRewriteLine(trimmed: string): string | null {
  const toolCallMatch = trimmed.match(/^●\s*(\w+)\((.+)\)\s*$/);
  if (toolCallMatch) return `[${toolCallMatch[1]}] ${toolCallMatch[2]}`;
  const bareResult = trimmed.match(/^●\s*(.+)$/);
  if (bareResult && !bareResult[1].includes('(')) return bareResult[1];
  const resultPrefix = trimmed.match(/^⎿\s+(.+)$/);
  if (resultPrefix) return resultPrefix[1];
  return null;
}

// Lines skipped specifically while hunting for the prompt at the bottom of the
// screen (mirrors the original getPromptTextAtEnd skip list).
function claudePromptSkip(text: string): boolean {
  if (/^[─━═]{5,}$/.test(text)) return true;
  if (/esc\s+to\s+interrupt/i.test(text)) return true;
  if (/^Tip:/i.test(text)) return true;
  if (/^Press\s+Ctrl/i.test(text)) return true;
  if (/^\(ctrl\+[a-z] to \w+\)$/i.test(text)) return true;
  if (/\?\s+(for shortcuts|for help)/i.test(text)) return true;
  if (/^●\s*(high|medium|low)\s*·\s*\//i.test(text)) return true;
  if (/auto\s*mode/i.test(text)) return true;
  if (claudeStatusLine(text)) return true;
  return false;
}

export const claudeProfile: AgentProfile = {
  name: 'claude',
  processNames: ['claude', 'claude-code'],
  promptText(tailLines) {
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const text = tailLines[i];
      if (!text) continue;
      if (claudePromptSkip(text)) continue;
      if (/^❯/.test(text)) return text.replace(/^❯\s*/, '').trim();
      return null; // hit a non-prompt, non-skippable line
    }
    return null;
  },
  isBusy(tailLines) {
    // Positional: an "esc to interrupt" affordance only counts as busy when it is
    // below the current `❯` input box (i.e. reached first scanning bottom-up). A
    // stale one left in history above the returned idle box must NOT block.
    return positionalBusy(tailLines, claudeProfile.isPromptLine, claudeIsBusyLine);
  },
  isNoiseLine: claudeIsNoiseLine,
  rewriteLine: claudeRewriteLine,
  isPromptLine(line) {
    return /^❯/.test(line);
  },
  stripPromptMarker(line) {
    return line.replace(/^❯\s*/, '').trim();
  },
};

// Claude's "working" affordance. The `❯` input box is not drawn while generating;
// it returns at the bottom once the turn ends. So `esc to interrupt` is busy only
// when it is the bottom-most boundary (positionalBusy handles the ordering).
function claudeIsBusyLine(text: string): boolean {
  return /esc\s+to\s+interrupt/i.test(text);
}

// ── Codex CLI ──────────────────────────────────────────────────────────
// Best-effort. Codex shows an "Esc to interrupt" affordance while working and a
// bottom input box. We keep the regexes conservative and let isBusy defer to the
// burst heuristic (null) where we are unsure.

export const codexProfile: AgentProfile = {
  name: 'codex',
  processNames: ['codex'],
  promptText(tailLines) {
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const text = tailLines[i];
      if (!text) continue;
      if (/^[─━═]{5,}$/.test(text)) continue;
      if (/esc\s+to\s+interrupt/i.test(text)) continue;
      if (/^[▌│▎┃]\s*/.test(text)) {
        // Input-box line: text after the box glyph is the draft.
        return text.replace(/^[▌│▎┃]\s*/, '').trim();
      }
      return null;
    }
    return null;
  },
  isBusy(tailLines) {
    // Positional: Codex shows "esc to interrupt" while working and a `▌`/`│` input
    // box when idle. A finished turn's busy line sitting above the returned box
    // must not read as busy — only count it when reached before the box bottom-up.
    return positionalBusy(tailLines, codexProfile.isPromptLine, codexIsBusyLine);
  },
  isNoiseLine(trimmed) {
    if (/esc\s+to\s+interrupt/i.test(trimmed)) return true;
    if (/^[─━═]{5,}$/.test(trimmed)) return true;
    return false;
  },
  rewriteLine() {
    return null;
  },
  isPromptLine(line) {
    return /^[▌│▎┃]/.test(line);
  },
  stripPromptMarker(line) {
    return line.replace(/^[▌│▎┃]\s*/, '').trim();
  },
};

// Codex's "working" affordance, kept as a free function so isBusy/isNoiseLine
// agree on what counts as busy chrome.
function codexIsBusyLine(text: string): boolean {
  return /esc\s+to\s+interrupt/i.test(text);
}

// ── Grok CLI ───────────────────────────────────────────────────────────
// Grok's TUI draws a bordered input box. When idle it shows the box with a
// placeholder ("Build anything") after a `❯` marker, e.g. (lines already
// trimmed of the leading two-space gutter by the caller):
//
//   │ ❯ Build anything                                                    │
//   ╰─────────────────────────────────────────────── Composer 2.5 Fast ─╯
//   Space:prompt  │  Enter:open  │  Ctrl+e:expand thinking  │  Ctrl+.:shortcuts
//
// The generic profile mistook "❯ Build anything … │" for a human draft, so the
// box never read as idle and queued tasks were never injected. This profile
// strips the left/right box borders and the `❯` marker, then treats the
// placeholder (and an empty box) as idle ('' → safe to inject). While Grok is
// generating it shows a "(still processing...)" / "esc to interrupt" affordance,
// which isBusy detects.

// Placeholder text Grok shows in an empty input box. Matched after the box
// borders and `❯` marker have been stripped; an exact-ish match means idle.
//
// NOTE: this is the literal placeholder string Grok renders (verified against
// grok 0.2.59). It is locale/version dependent — if Grok changes the empty-box
// copy or ships a localized build, an idle box will stop reading as '' and tasks
// will queue forever. When that happens, update this list (and the fixtures in
// agent-profiles.test.ts) rather than widening the box-character match, which
// would risk treating a real human draft as idle.
const GROK_PLACEHOLDERS = [
  /^build anything$/i,
];

// Sentinel returned by promptText to mean "something non-idle is on the prompt
// (a busy affordance or an unrecognized box/continuation row) — do NOT inject"
// without claiming to know the actual draft text. It is deliberately a single
// non-whitespace glyph so it is non-empty (canAutoInject only injects on '' or a
// 30s-quiet null) yet can never collide with real user input. (U+FFFC OBJECT
// REPLACEMENT CHARACTER.)
const GROK_NONEMPTY_SENTINEL = '￼';

// The footer (`… Composer 2.5 Fast ─╯`) and the shortcut hint row
// (`Space:prompt │ Enter:open │ …`) are chrome, not a draft — skip them while
// hunting for the prompt so they don't shadow the input box above.
function grokIsChromeLine(text: string): boolean {
  // Box top/bottom borders: ╭───╮ / ╰───╯ optionally carrying a label.
  if (/^[╭╰][─━═]/.test(text)) return true;
  if (/[─━═][╮╯]$/.test(text)) return true;
  // Footer label line, e.g. "… Composer 2.5 Fast ─╯".
  if (/Composer\b.*\bFast\b/i.test(text)) return true;
  // Shortcut hint row: "Space:prompt │ Enter:open │ Ctrl+e:… │ Ctrl+.:…".
  if (/(?:Space:prompt|Enter:open|Ctrl\+[a-z.]:)/i.test(text)) return true;
  if (/^[─━═]{5,}$/.test(text)) return true;
  return false;
}

// Pull the editable text out of a Grok input-box line. Returns the inner text
// (possibly '') when `text` is a box row containing a `❯` marker, or null when
// the line isn't an input-box row.
function grokBoxInner(text: string): string | null {
  // Must look like a bordered row that carries the prompt marker. The left
  // border is a vertical box char (│ ▌ ▎ ┃ ▐) possibly followed by `❯`.
  if (!/^[│▌▎┃▐]/.test(text)) return null;
  if (!text.includes('❯')) return null;
  let inner = text;
  // Drop the leading left border.
  inner = inner.replace(/^[│▌▎┃▐]\s*/, '');
  // Drop the `❯` marker.
  inner = inner.replace(/^❯\s*/, '');
  // Drop the trailing right border.
  inner = inner.replace(/\s*[│▌▎┃▐]\s*$/, '');
  return inner.trim();
}

export const grokProfile: AgentProfile = {
  name: 'grok',
  processNames: ['grok', 'grok-macos-aarch', 'grok-cli'],
  // Grok repaints its TUI continuously (~10fps) even when idle, so canAutoInject's
  // output-activity and positional-busy heuristics can never confirm an injectable
  // idle moment. Grok also serializes pushed input on its own side, so immediate
  // delivery is the most reliable strategy for MAIN→Grok dispatch.
  pushImmediately: true,
  // Submit tuning for Grok's ratatui/crossterm TUI. Grok submits on a plain
  // `Enter` (a bare CR). After a large bracketed paste the very first `\r` can be
  // missed/absorbed (the textarea is still ingesting the multi-line Event::Paste,
  // or the CR races the paste terminator), leaving the task pasted-but-unsent.
  // So: wait longer for the paste to settle before the first Enter, then send a
  // second Enter shortly after as an unconditional belt-and-suspenders. Grok has
  // no paste debounce of its own (verified against grok 0.2.59), so a second CR
  // on an already-submitted/empty box is a harmless no-op. The needle-based
  // retry in pasteAndSubmit still runs on top of this.
  submitDelayMs: 600,
  extraEnterDelayMs: 250,
  promptText(tailLines) {
    // POSITIONAL (single bottom-up pass — must agree with isBusy):
    //   - A busy affordance reached BEFORE the input box ⇒ Grok is generating
    //     (the box may still be drawn above). Return the non-empty sentinel so
    //     canAutoInject blocks injection — never report '' (idle) here.
    //   - The input box reached first ⇒ idle/draft as usual; a stale busy line
    //     sitting ABOVE the box is history and is simply never reached, so the box
    //     reports idle. (A whole-tail `some()` busy scan would mis-block here.)
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const text = tailLines[i];
      if (!text) continue;
      // Busy affordance below the box ⇒ generating; fail closed with the sentinel.
      if (grokIsBusyLine(text)) return GROK_NONEMPTY_SENTINEL;
      if (grokIsChromeLine(text)) continue;
      const inner = grokBoxInner(text);
      if (inner !== null) {
        // Input box found. Empty box or the placeholder ⇒ idle (safe to inject).
        if (inner.length === 0) return '';
        if (GROK_PLACEHOLDERS.some((re) => re.test(inner))) return '';
        // A real draft is showing — never inject.
        return inner;
      }
      // A vertical box line WITHOUT a `❯` marker is a wrapped/continuation row of
      // a multi-line draft (the `❯` only renders on the first row). Bottom-up we
      // hit it before the marker row, so returning null here would let the 30s
      // quiet fallback fire and clobber a human's in-progress multi-line draft.
      // Fail closed: a non-empty sentinel reads as "draft present, do not inject"
      // in canAutoInject (which only injects on '' / a 30s-quiet null).
      if (/^[│▌▎┃▐]/.test(text) && !text.includes('❯')) return GROK_NONEMPTY_SENTINEL;
      // Hit a non-box, non-chrome line: no recognizable prompt at the bottom.
      return null;
    }
    return null;
  },
  isBusy(tailLines) {
    // Positional: Grok keeps drawing its input box while "(still processing...)" /
    // "esc to interrupt" shows below it during a turn, and the box returns to the
    // bottom once idle. So the busy affordance only counts when it is reached
    // before the `❯` box row scanning bottom-up; a stale one left above the idle
    // box (e.g. after a short answer) must NOT block injection.
    return positionalBusy(tailLines, grokProfile.isPromptLine, grokIsBusyLine);
  },
  isNoiseLine(trimmed) {
    if (grokIsBusyLine(trimmed)) return true;
    if (grokIsChromeLine(trimmed)) return true;
    return false;
  },
  rewriteLine() {
    return null;
  },
  isPromptLine(line) {
    // A box row carrying the `❯` marker is the prompt/echo line.
    return /^[│▌▎┃▐]/.test(line) && line.includes('❯');
  },
  stripPromptMarker(line) {
    return grokBoxInner(line) ?? line.replace(/^[│▌▎┃▐]\s*/, '').replace(/^❯\s*/, '').trim();
  },
};

// Grok's "working" affordances. Kept as a free function so promptText, isBusy
// and isNoiseLine all agree on what counts as busy chrome.
function grokIsBusyLine(text: string): boolean {
  if (/\(still\s+processing/i.test(text)) return true;
  if (/esc\s+to\s+interrupt/i.test(text)) return true;
  if (/\besc\b.*\binterrupt\b/i.test(text)) return true;
  return false;
}

// ── Generic shell fallback ─────────────────────────────────────────────
// A plain shell prompt typically ends in one of $ % # > ❯. If the last line is
// just a prompt (nothing after the symbol) it's idle; if there's text after the
// symbol the user is typing. Anything else is unknown (null → quiet heuristic).

export const genericProfile: AgentProfile = {
  name: 'generic',
  processNames: [],
  promptText(tailLines) {
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const text = tailLines[i];
      if (!text) continue;
      // Empty prompt: ends with a prompt symbol (optionally trailing space).
      if (/[$%#>❯]$/.test(text)) return '';
      // Prompt with a draft: "...<symbol> some text"
      const m = text.match(/[$%#>❯]\s+(\S.*)$/);
      if (m) return m[1];
      return null;
    }
    return null;
  },
  isBusy() {
    return null;
  },
  isNoiseLine(trimmed) {
    return /^[─━═]{5,}$/.test(trimmed);
  },
  rewriteLine() {
    return null;
  },
  isPromptLine(line) {
    // A shell prompt symbol at the start (rare) or a "...<symbol> text" echo.
    return /^[$%#>❯]/.test(line) || /[$%#>❯]\s+\S/.test(line);
  },
  stripPromptMarker(line) {
    return line.replace(/^.*?[$%#>❯]\s*/, '').trim();
  },
};

const PROFILES = [claudeProfile, codexProfile, grokProfile];

/**
 * Does the foreground process name `actual` belong to a profile whose declared
 * names include `candidate`?
 *
 * Exact match OR a `<candidate>-…` / `<candidate>.…` prefix. The prefix arm is
 * the load-bearing one: grok's native binary sets its process *title* to its
 * version (e.g. `grok-0.2.64`, verified against grok 0.2.64), and bumps it on
 * every release. An exact-only match against `['grok', …]` therefore silently
 * stopped selecting grokProfile the moment grok shipped a new version — the
 * foreground name became `grok-0.2.64`, fell through to genericProfile, and the
 * generic prompt heuristic misread grok's idle box (`│ ❯ … │`) as a draft, so
 * canAutoInject went permanently false and MAIN→Grok task dispatch never
 * injected (the c2abf80 regression, by a different door).
 *
 * The `-`/`.` separator requirement keeps this from over-matching unrelated
 * commands (`grokking` does NOT match `grok`); only a real variant/version
 * suffix does. Names arrive already normalized (basename, no leading `-`, no
 * `.exe`) via normalizeProcessName, so `.` here only ever introduces a version
 * tail, never a real extension.
 */
function processNameMatches(actual: string, candidate: string): boolean {
  if (actual === candidate) return true;
  return actual.startsWith(`${candidate}-`) || actual.startsWith(`${candidate}.`);
}

/** Pick a profile by foreground process name; generic shell fallback otherwise. */
export function profileForProcess(processName: string | undefined): AgentProfile {
  if (!processName) return genericProfile;
  const lower = processName.toLowerCase();
  for (const p of PROFILES) {
    if (p.processNames.some((name) => processNameMatches(lower, name))) return p;
  }
  return genericProfile;
}
