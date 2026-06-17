// Agent TUI profiles.
//
// Busy-state, prompt, and noise detection used to be hard-coded to Claude Code's
// TUI inside pty-manager.ts, which meant any other agent (Codex) or a TUI update
// silently broke auto-inject timing and response extraction. A profile bundles
// those heuristics behind a stable interface so they can be swapped per session
// based on the foreground process name.

export interface AgentProfile {
  name: string;
  /** Foreground process names this profile applies to (normalized base names). */
  processNames: string[];
  /**
   * The editable text at the prompt given the bottom-of-screen lines (already
   * trimmed, blanks removed, newest last). Three-valued:
   *   - ''   : an empty prompt is showing — idle, safe to inject
   *   - text : the prompt holds a draft — a human or the agent is typing
   *   - null : no recognizable prompt — caller falls back to its quiet-output heuristic
   */
  promptText(tailLines: string[]): string | null;
  /** Whether the screen looks like the agent is generating. null = can't tell
   *  (defer to the output-burst heuristic). Currently advisory only. */
  isBusy(tailLines: string[]): boolean | null;
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
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (/esc\s+to\s+interrupt/i.test(tailLines[i])) return true;
    }
    return null;
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
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (/esc\s+to\s+interrupt/i.test(tailLines[i])) return true;
    }
    return null;
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

const PROFILES = [claudeProfile, codexProfile];

/** Pick a profile by foreground process name; generic shell fallback otherwise. */
export function profileForProcess(processName: string | undefined): AgentProfile {
  if (!processName) return genericProfile;
  const lower = processName.toLowerCase();
  for (const p of PROFILES) {
    if (p.processNames.includes(lower)) return p;
  }
  return genericProfile;
}
