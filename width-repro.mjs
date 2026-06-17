import pkg from '@xterm/headless';
const { Terminal } = pkg;

// --- replicate Codex's makeCjkWideProvider ---
const WIDEN = [[0x2010,0x2016],[0x2020,0x2027],[0x2030,0x203b],[0x203e,0x203e],
  [0x2103,0x2103],[0x212b,0x212b],[0x2150,0x218f],[0x2460,0x24ff]];
const inWiden = cp => WIDEN.some(([a,b]) => cp>=a && cp<=b);
const cpv=(s,w,j)=>((s&0xffffff)<<3)|((w&3)<<1)|(j?1:0);
const ew=v=>(v>>1)&0x3;
function makeProvider(base){
  const wcwidth=n=>{const w=base.wcwidth(n);return w===1&&inWiden(n)?2:w;};
  return {version:'cjk-ambiguous-wide',wcwidth,
    charProperties(cp,prec){let w=wcwidth(cp);let j=w===0&&prec!==0;if(j){const o=ew(prec);if(o===0)j=false;else if(o>w)w=o;}return cpv(0,w,j);}};
}

function us(useProvider) {
  const t = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  if (useProvider) {
    const u = t._core?.unicodeService;
    const base = u?._providers?.['6'] ?? u?._activeProvider;
    t.unicode.register(makeProvider(base)); t.unicode.activeVersion='cjk-ambiguous-wide';
  }
  return t._core.unicodeService;
}

const plain = us(false);
const codex = us(true);

const samples = {
  'em dash —  U+2014': '—',
  'arrow →   U+2192': '→',
  'ref mark ※ U+203B': '※',
  'circled ① U+2460': '①',
  'roman Ⅲ   U+2162': 'Ⅲ',
  'half ½    U+00BD': '½',
  'kanji 推': '推',
  'box ─    U+2500': '─',
};
console.log('char                | default | codex-widened');
for (const [name, ch] of Object.entries(samples)) {
  const cp = ch.codePointAt(0);
  console.log(name.padEnd(20), '|', String(plain.wcwidth(cp)).padStart(7), '|', String(codex.wcwidth(cp)).padStart(7));
}

const line = 'Q5 推奨 — 7,387→7,388 は四捨五入差1円なので、まず継続割引を固定割引額820円に変更（8,208-820=7,388、端数なし）';
console.log('\nString cell-width of the screenshot line:');
console.log('  default (what the program/Claude Code assumes):', plain.getStringCellWidth(line));
console.log('  codex   (what the client now renders):         ', codex.getStringCellWidth(line));
console.log('  => mismatch of', codex.getStringCellWidth(line) - plain.getStringCellWidth(line), 'columns on THIS ONE LINE');
