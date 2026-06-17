import pkg from '@xterm/headless';
const { Terminal } = pkg;

const WIDEN = [[0x2150,0x218f],[0x2460,0x24ff]];
const inWiden = cp => WIDEN.some(([a,b]) => cp>=a && cp<=b);
const cpv = (s,w,j) => ((s&0xffffff)<<3)|((w&3)<<1)|(j?1:0);
const ew = v => (v>>1)&0x3;
function makeProvider(base){
  const wcwidth = n => { const w = base.wcwidth(n); return w===1 && inWiden(n) ? 2 : w; };
  return { version:'cjk-ambiguous-wide', wcwidth,
    charProperties(cp,prec){ let w=wcwidth(cp); let j=w===0&&prec!==0; if(j){const o=ew(prec); if(o===0)j=false; else if(o>w)w=o;} return cpv(0,w,j);} };
}

const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
const us = term._core?.unicodeService;
const base = us?._providers?.['6'] ?? us?._activeProvider;
console.log('unicodeService found:', !!us);
console.log('base provider found:', !!base, 'version:', base?.version);
console.log('BEFORE  ① width:', us.wcwidth(0x2460));

term.unicode.register(makeProvider(base));
term.unicode.activeVersion = 'cjk-ambiguous-wide';

console.log('versions:', term.unicode.versions, 'active:', term.unicode.activeVersion);
console.log('AFTER   ① width:', us.wcwidth(0x2460), '(expect 2)');
console.log('AFTER   Ⅲ(2162):', us.wcwidth(0x2162), '(expect 2)');
console.log('AFTER   A width:', us.wcwidth(0x41), '(expect 1)');
console.log('AFTER   あ width:', us.wcwidth(0x3042), '(expect 2)');
console.log('AFTER   box ─(2500):', us.wcwidth(0x2500), '(expect 1 - TUI safe)');
console.log('AFTER   block ▏(258f):', us.wcwidth(0x258f), '(expect 1 - TUI safe)');
console.log('getStringCellWidth("①②③"):', us.getStringCellWidth('①②③'), '(expect 6)');
console.log('getStringCellWidth("あい"):', us.getStringCellWidth('あい'), '(expect 4)');
