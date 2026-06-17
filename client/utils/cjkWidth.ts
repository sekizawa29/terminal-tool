import type { IUnicodeVersionProvider } from '@xterm/xterm';

// East Asian "Ambiguous"-width characters that monospace/CJK fonts commonly
// render at FULL width but that xterm's default (UnicodeV6) counts as 1 cell.
// When the glyph is ~2 cells wide but the buffer reserves 1, the glyph spills
// into the next cell and visually overlaps the following character (the classic
// "①②③ / 環境依存文字 が重なる" complaint).
//
// We widen ONLY content-bearing ranges here. Box-drawing (U+2500-257F), block
// elements (U+2580-259F), geometric shapes (U+25A0-25FF), arrows, and dingbats
// are deliberately LEFT at width 1 — TUIs (Claude Code, vim, etc.) use them for
// layout/status UI at one cell, and widening them would break their alignment.
const WIDEN_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x2010, 0x2016], // Hyphen/dash/parallel marks often rendered by CJK fallback.
  [0x2020, 0x2027], // Dagger/bullet/two-dot leader.
  [0x2030, 0x203b], // Per mille, primes, reference mark (※).
  [0x203e, 0x203e], // Overline.
  [0x2103, 0x2103], // ℃
  [0x212b, 0x212b], // Å
  [0x2150, 0x218f], // Number Forms: ½ ⅓ ⅔ Ⅰ Ⅱ Ⅲ …
  [0x2460, 0x24ff], // Enclosed Alphanumerics: ① ② ③ ⑴ ⒈ ⓐ …
];

function inWidenRange(cp: number): boolean {
  for (const [lo, hi] of WIDEN_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

// Stable id for term.unicode.register / activeVersion.
export const CJK_UNICODE_VERSION = 'cjk-ambiguous-wide';

// Bit layout mirrors xterm's UnicodeService.createPropertyValue / extractWidth
// (state<<3 | width<<1 | shouldJoin). Replicated here so the provider stays
// self-contained and doesn't reach into another private API.
const createPropertyValue = (state: number, width: number, shouldJoin: boolean): number =>
  ((state & 0xffffff) << 3) | ((width & 3) << 1) | (shouldJoin ? 1 : 0);
const extractWidth = (value: number): 0 | 1 | 2 => ((value >> 1) & 0x3) as 0 | 1 | 2;

// Build a Unicode provider that delegates every width decision to xterm's
// built-in provider (`base`, the registered UnicodeV6 instance), only promoting
// the curated ambiguous ranges from 1 → 2 cells. charProperties mirrors
// UnicodeV6's combining-mark joining logic against the widened width.
export function makeCjkWideProvider(base: IUnicodeVersionProvider): IUnicodeVersionProvider {
  const wcwidth = (num: number): 0 | 1 | 2 => {
    const w = base.wcwidth(num);
    return w === 1 && inWidenRange(num) ? 2 : w;
  };
  return {
    version: CJK_UNICODE_VERSION,
    wcwidth,
    charProperties(codepoint: number, preceding: number): number {
      let width = wcwidth(codepoint);
      let shouldJoin = width === 0 && preceding !== 0;
      if (shouldJoin) {
        const oldWidth = extractWidth(preceding);
        if (oldWidth === 0) shouldJoin = false;
        else if (oldWidth > width) width = oldWidth;
      }
      return createPropertyValue(0, width, shouldJoin);
    },
  };
}
