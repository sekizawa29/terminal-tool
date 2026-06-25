// Regression tests for the agent TUI profiles, with an emphasis on the Grok
// parser (added in the grok-cli support work) and on profile selection.
//
// Run:  npm test   (executes this file with tsx, an existing dev dependency —
// no build step or extra packages needed; node:test + node:assert are built in).
// Excluded from the server build (tsconfig.server.json) so it never ships in
// dist/.
//
// IMPORTANT: the Grok fixtures below encode the *actual* strings Grok's TUI
// renders (verified against grok 0.2.59). They are the canary for version/locale
// drift — if Grok changes its empty-box placeholder ("Build anything"), its
// footer ("Composer 2.5 Fast"), or its busy affordance ("(still processing...)"),
// these tests will fail and BOTH the fixtures here and the matchers in
// agent-profiles.ts must be updated together. Do not "fix" a failure by widening
// the box-character match in promptText — that risks treating a real human draft
// as an idle prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  profileForProcess,
  positionalBusy,
  grokProfile,
  claudeProfile,
  codexProfile,
  genericProfile,
} from './agent-profiles.js';

// The non-empty sentinel promptText returns for "not idle, but I don't know the
// draft" (busy affordance, or an unrecognized vertical-box / continuation row).
// Kept here as a literal so the tests assert the exact contract canAutoInject
// relies on: any non-'' / non-null promptText blocks injection.
const SENTINEL = '￼'; // ￼  U+FFFC OBJECT REPLACEMENT CHARACTER

// The caller (getTailLines) hands profiles already-trimmed, blank-free lines,
// newest last. Fixtures follow that contract.

// ── Grok: promptText (the auto-inject gate) ────────────────────────────────

test('grok: empty input box reads as idle ("")', () => {
  // Bordered empty box with just the marker.
  const tail = [
    '╭──────────────────────────────────────────────╮',
    '│ ❯                                            │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
    'Space:prompt  │  Enter:open  │  Ctrl+.:shortcuts',
  ];
  assert.equal(grokProfile.promptText(tail), '');
});

test('grok: "Build anything" placeholder reads as idle ("")', () => {
  const tail = [
    '╭──────────────────────────────────────────────╮',
    '│ ❯ Build anything                             │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
    'Space:prompt  │  Enter:open  │  Ctrl+.:shortcuts',
  ];
  assert.equal(grokProfile.promptText(tail), '');
});

test('grok: single-line draft returns the draft text (never inject)', () => {
  const tail = [
    '╭──────────────────────────────────────────────╮',
    '│ ❯ hello there                                │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
  ];
  assert.equal(grokProfile.promptText(tail), 'hello there');
});

test('grok: wrapped multi-line draft — continuation row fails closed (sentinel)', () => {
  // A long draft wraps: the `❯` only renders on the FIRST box row; the wrapped
  // row is a bare vertical box with no marker and is hit FIRST (bottom-up). It
  // must NOT return null (which would let the 30s-quiet fallback clobber the
  // human's draft) — it returns the non-empty sentinel.
  const tail = [
    '╭──────────────────────────────────────────────╮',
    '│ ❯ this is a very long first line of a draft  │',
    '│ that has wrapped onto a second visual row    │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
  ];
  const got = grokProfile.promptText(tail);
  assert.notEqual(got, '');   // not idle
  assert.notEqual(got, null); // not the quiet-fallback path
  assert.equal(got, SENTINEL);
});

test('grok: box-only continuation row with no marker fails closed (sentinel)', () => {
  // Pathological: a vertical-box row with no `❯` anywhere above it in the tail.
  const tail = [
    '│ leftover wrapped content                     │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
  ];
  assert.equal(grokProfile.promptText(tail), SENTINEL);
});

test('grok: footer + hint chrome alone yields no recognizable prompt (null)', () => {
  // Only chrome, no input box in view → null (caller defers to quiet heuristic).
  const tail = [
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
    'Space:prompt  │  Enter:open  │  Ctrl+.:shortcuts',
  ];
  assert.equal(grokProfile.promptText(tail), null);
});

test('grok: busy but input box still visible → NOT idle (sentinel, fail closed)', () => {
  // The "(still processing...)" affordance is present while the (empty) box is
  // still drawn. promptText must NOT report '' here, or canAutoInject would
  // inject mid-generation. It returns the sentinel; isBusy also returns true.
  const tail = [
    '│ ❯                                            │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
    '(still processing... esc to interrupt)',
  ];
  assert.equal(grokProfile.promptText(tail), SENTINEL);
  assert.equal(grokProfile.isBusy(tail), true);
});

test('grok: esc-to-interrupt affordance also reads busy', () => {
  const tail = [
    'Thinking…',
    'esc to interrupt',
  ];
  assert.equal(grokProfile.isBusy(tail), true);
  // And promptText must not call it idle.
  assert.notEqual(grokProfile.promptText(tail), '');
});

test('grok: unknown placeholder is treated as a draft (conservative)', () => {
  // If Grok ships a new/localized empty-box copy we don't recognize, we must err
  // toward "draft present" (block injection), not idle. This is the failure that
  // signals GROK_PLACEHOLDERS needs updating.
  const tail = [
    '│ ❯ Frag irgendwas                             │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
  ];
  const got = grokProfile.promptText(tail);
  assert.notEqual(got, '');
  assert.equal(got, 'Frag irgendwas');
});

test('grok: idle when nothing is busy', () => {
  const tail = [
    '│ ❯ Build anything                             │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
  ];
  // Positional: the `❯` input box is at the bottom and no busy affordance sits
  // below it, so isBusy is a definitive `false` (idle), not `null`. (Previously a
  // `some()` scan returned `null` here; `false` is strictly stronger and equally
  // non-blocking in canAutoInject — only `true` blocks.)
  assert.equal(grokProfile.isBusy(tail), false);
  assert.equal(grokProfile.promptText(tail), '');
});

// ── Positional busy: stale busy text above a returned idle prompt (the Major
//    regression). A finished turn leaves its "esc to interrupt" /
//    "(still processing...)" line in the 10-line tail, but the idle input box is
//    back at the BOTTOM. A `some()` scan reported busy forever and froze the
//    dispatch outbox; the positional check ignores the stale line. ───────────────

test('grok: stale busy ABOVE idle box → NOT busy, promptText idle (regression)', () => {
  // Exactly the sub-1 fixture: a leftover "esc to interrupt" sits above the
  // returned idle box. The box is the bottom-most boundary ⇒ idle.
  const tail = [
    'esc to interrupt',
    '│ ❯ Build anything                             │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
    'Space:prompt  │  Enter:open  │  Ctrl+.:shortcuts',
  ];
  assert.equal(grokProfile.isBusy(tail), false);      // stale busy ignored
  assert.equal(grokProfile.promptText(tail), '');     // idle, safe to inject
});

test('grok: still-generating (busy below box, no idle box at bottom) → busy', () => {
  // The box scrolled up; the busy affordance is the bottom-most line ⇒ generating.
  const tail = [
    '│ ❯ Build anything                             │',
    '╰─────────────────────────── Composer 2.5 Fast ─╯',
    '(still processing... esc to interrupt)',
  ];
  assert.equal(grokProfile.isBusy(tail), true);
  assert.equal(grokProfile.promptText(tail), SENTINEL); // never idle while busy
});

test('claude: stale busy ABOVE idle ❯ prompt → NOT busy (regression)', () => {
  // A finished short turn: "esc to interrupt" lingers in history, the idle `❯`
  // box has returned at the bottom. Previously a `some()` scan froze injection.
  const tail = [
    'esc to interrupt',
    'Done — here is the answer.',
    '❯',
  ];
  assert.equal(claudeProfile.isBusy(tail), false);
  assert.equal(claudeProfile.promptText(tail), ''); // idle
});

test('claude: generating (esc-to-interrupt at bottom, no ❯ box) → busy', () => {
  const tail = [
    'Thinking about your request…',
    '✶ Cooking… (esc to interrupt)',
  ];
  assert.equal(claudeProfile.isBusy(tail), true);
});

test('codex: stale busy ABOVE idle input box → NOT busy (regression)', () => {
  const tail = [
    'esc to interrupt',
    'patch applied.',
    '▌ ',
  ];
  assert.equal(codexProfile.isBusy(tail), false);
  assert.equal(codexProfile.promptText(tail), ''); // idle box → idle
});

test('codex: generating (esc-to-interrupt at bottom, no input box) → busy', () => {
  const tail = [
    'Working on the change…',
    'esc to interrupt',
  ];
  assert.equal(codexProfile.isBusy(tail), true);
});

// ── positionalBusy: the pure helper, tested directly (sub-1 Minor). Fixes the
//    "busy is before fallback" and "sentinel is non-empty" safety contracts so
//    they can't silently regress. ─────────────────────────────────────────────

test('positionalBusy: busy reached before the prompt boundary → true', () => {
  const isPrompt = (l: string) => l === 'PROMPT';
  const isBusy = (l: string) => l === 'BUSY';
  // bottom-up: BUSY hit first ⇒ true.
  assert.equal(positionalBusy(['PROMPT', 'BUSY'], isPrompt, isBusy), true);
});

test('positionalBusy: prompt reached before any busy → false (stale busy ignored)', () => {
  const isPrompt = (l: string) => l === 'PROMPT';
  const isBusy = (l: string) => l === 'BUSY';
  // bottom-up: PROMPT hit first; the BUSY above it is history ⇒ false.
  assert.equal(positionalBusy(['BUSY', 'PROMPT'], isPrompt, isBusy), false);
});

test('positionalBusy: neither boundary seen → null (defer to quiet heuristic)', () => {
  const isPrompt = (l: string) => l === 'PROMPT';
  const isBusy = (l: string) => l === 'BUSY';
  assert.equal(positionalBusy(['just', 'some', 'output'], isPrompt, isBusy), null);
  assert.equal(positionalBusy([], isPrompt, isBusy), null);
});

test('positionalBusy: blank lines are skipped, not treated as boundaries', () => {
  const isPrompt = (l: string) => l === 'PROMPT';
  const isBusy = (l: string) => l === 'BUSY';
  assert.equal(positionalBusy(['BUSY', '', 'PROMPT', ''], isPrompt, isBusy), false);
});

test('grok sentinel is non-empty so canAutoInject treats it as "do not inject"', () => {
  // The sentinel must never be '' (which would read as idle) — canAutoInject only
  // injects on '' or a 30s-quiet null. Pin the contract the manager relies on.
  assert.notEqual(SENTINEL, '');
  assert.ok(SENTINEL.length > 0);
  assert.equal(SENTINEL.trim(), SENTINEL); // a single non-whitespace glyph
});

// ── Grok: submit strategy contract (Fix B) ─────────────────────────────────

test('grok: declares a profile-aware submit strategy (settle delay + double enter)', () => {
  // pasteAndSubmit reads these off the profile. Grok needs a longer settle than
  // the 350ms default and an unconditional second Enter.
  //
  // NOTE: this unit test only asserts the profile FIELDS. Whether the double
  // Enter actually submits a large bracketed paste in Grok's ratatui textarea
  // (vs. landing as a newline, or the paste still being ingested) is a timing
  // property of the live TUI and CANNOT be verified here — it needs a live
  // smoke test against a real grok session. See the grokProfile comment.
  assert.ok((grokProfile.submitDelayMs ?? 0) > 350, 'grok submitDelayMs should exceed the 350ms default');
  assert.ok((grokProfile.extraEnterDelayMs ?? 0) > 0, 'grok should request a second Enter');
});

test('claude/codex keep default submit behavior (no overrides)', () => {
  // Unchanged: undefined → pasteAndSubmit falls back to 350ms / single \r.
  for (const p of [claudeProfile, codexProfile]) {
    assert.equal(p.submitDelayMs, undefined);
    assert.equal(p.extraEnterDelayMs, undefined);
    assert.equal(p.submitSequence, undefined);
  }
});

// ── Profile selection ──────────────────────────────────────────────────────

test('profileForProcess: grok-macos-aarch → grok', () => {
  assert.equal(profileForProcess('grok-macos-aarch').name, 'grok');
});

test('profileForProcess: grok / grok-cli → grok (incl. case-insensitive)', () => {
  assert.equal(profileForProcess('grok').name, 'grok');
  assert.equal(profileForProcess('grok-cli').name, 'grok');
  assert.equal(profileForProcess('GROK').name, 'grok');
});

test('profileForProcess: "grokish" does NOT match grok (no substring matching)', () => {
  assert.equal(profileForProcess('grokish').name, 'generic');
  assert.equal(profileForProcess('mygrok').name, 'generic');
});

// REGRESSION: grok's native binary sets its process title to its version, e.g.
// `grok-0.2.64` (verified against the installed grok 0.2.64). Exact-name matching
// stopped selecting grokProfile the moment grok bumped its version, so the box
// fell back to genericProfile and MAIN→Grok dispatch silently queued forever.
// A `grok-<version>` foreground name MUST still resolve to grokProfile.
test('profileForProcess: versioned grok title (grok-0.2.64) → grok', () => {
  assert.equal(profileForProcess('grok-0.2.64').name, 'grok');
  assert.equal(profileForProcess('grok-0.2.65').name, 'grok');
  assert.equal(profileForProcess('grok-1.0.0').name, 'grok');
  // Case-insensitive, matching the lowercasing in profileForProcess.
  assert.equal(profileForProcess('GROK-0.2.64').name, 'grok');
});

test('profileForProcess: claude / codex / zsh unchanged', () => {
  assert.equal(profileForProcess('claude').name, 'claude');
  assert.equal(profileForProcess('claude-code').name, 'claude');
  assert.equal(profileForProcess('codex').name, 'codex');
  assert.equal(profileForProcess('zsh').name, 'generic');
  assert.equal(profileForProcess(undefined).name, 'generic');
});

// ── A light cross-check that the generic/claude/codex prompt parsers still work,
//    so this file doubles as a smoke test of the shared interface. ────────────

test('claude: empty ❯ prompt is idle; draft is not', () => {
  assert.equal(claudeProfile.promptText(['❯']), '');
  assert.equal(claudeProfile.promptText(['❯ write a haiku']), 'write a haiku');
});

test('generic: shell prompt idle vs draft', () => {
  assert.equal(genericProfile.promptText(['user@host ~ %']), '');
  assert.equal(genericProfile.promptText(['user@host ~ % ls -la']), 'ls -la');
});

// ── pushImmediately flag: Grok-only, all others falsy ──────────────────────

test('grok: pushImmediately is true (Grok skips idle/busy heuristics in canAutoInject)', () => {
  // Grok repaints its TUI continuously so an idle moment is never observable.
  // canAutoInject returns true for any non-typing moment when this flag is set.
  assert.equal(grokProfile.pushImmediately, true);
});

test('claude/codex/generic: pushImmediately is falsy (unchanged heuristics apply)', () => {
  // Zero behavior change for all non-Grok profiles: the pushImmediately early
  // return in canAutoInject must never fire for these agents.
  assert.ok(!claudeProfile.pushImmediately, 'claude must not have pushImmediately set');
  assert.ok(!codexProfile.pushImmediately, 'codex must not have pushImmediately set');
  assert.ok(!genericProfile.pushImmediately, 'generic must not have pushImmediately set');
});
