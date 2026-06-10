# フェーズ 4: クライアント描画パフォーマンス

**現状の問題**: ウィンドウを1枚ドラッグすると全 N ウィンドウが毎 mousemove で再レンダーされる。原因は3層:

1. `TerminalWindow.tsx` 冒頭の `const { updateTerminal, removeTerminal, bringToFront, setActive, activeTerminalId, saveLayout } = useTerminalStore();` — **セレクタなしの全ストア購読**。直後のコメント「Subscribe to only the fields we need」付きのセレクタ群が無効化されている。
2. `App.tsx` の `const { setToken, addTerminal, loadLayout } = useTerminalStore();` — 同様。App 全体(Sidebar 含む)がドラッグ毎・2秒ポーリング毎に再レンダー。
3. パン/ズームの transform が `useCanvas.ts` の React state で、ホイール1ティック・パン1 mousemove ごとに全ツリー再レンダー。

加えて `TerminalWindow.tsx` のドラッグ処理は `tw.x += dx; tw.y += dy` と **store 所有オブジェクトを直接ミューテート**しており(stale closure 回避のためのハック)、React.memo 化の障害になる。

## 4.1 セレクタ購読への統一

**仕様**:
1. `grep -n "useTerminalStore()" client/` でセレクタなし購読を全て洗い出す。
2. zustand のアクションは store 生成時に一度だけ作られ参照が安定なので、`const updateTerminal = useTerminalStore((s) => s.updateTerminal);` の形で個別に取る。
3. `TerminalWindow.tsx` の `activeTerminalId` は `const isActive = useTerminalStore((s) => s.activeTerminalId === tw.id);` に変える(boolean 化で再レンダー最小化)。
4. `App.tsx` のマウント時にしか使わないもの(`loadLayout` 等)は `useTerminalStore.getState().loadLayout()` 直呼びでも良い。

## 4.2 ミューテーション排除(4.3 の前提)

**仕様**: `TerminalWindow.tsx` のドラッグ/リサイズで `tw` を直接書き換えている箇所を ref ベースに変更:

```ts
const posRef = useRef({ x: tw.x, y: tw.y });
// mousedown 時に posRef.current = { x: tw.x, y: tw.y } で初期化
// mousemove: posRef.current.x += dx/scale; updateTerminal(tw.id, { x: posRef.current.x, ... })
```

`ResizeHandle.tsx` 経由のリサイズも同様(サイズを ref に持つ)。store の `updateTerminal` は従来どおり毎 move 呼んで良い(4.3 後は自分のウィンドウしか再レンダーされない)。

## 4.3 ウィンドウ単位の購読 + React.memo

**仕様**:
1. `Canvas.tsx`: 現在 `terminals` Map を購読して `<TerminalWindow tw={tw} ...>` を列挙している。これを **id のみ**を渡す形に変更: `const ids = useTerminalStore(useShallow((s) => Array.from(s.terminals.keys())));`(`zustand/react/shallow` の `useShallow` を使用。追加・削除時のみ再レンダー)。
2. `TerminalWindow` は props で `id` を受け取り、自分のデータだけ購読: `const tw = useTerminalStore((s) => s.terminals.get(id));`(`updateTerminal` は新オブジェクトを set するので自ウィンドウの変更時のみ発火する)。`tw` が undefined なら null を返す。
3. `TerminalWindow` を `React.memo` でラップ。親から渡る関数 props(`onZoom`, `onOpenFile` 等)は `App.tsx` / `Canvas.tsx` 側で `useCallback` 安定化する。
4. `LinkLines.tsx` は全ウィンドウ座標が要るので `terminals` 購読のままで良い(SVG のみで軽い)。

**受け入れ基準**: React DevTools Profiler(または各コンポーネントに一時的な render カウント console.log)で、ウィンドウ A のドラッグ中にウィンドウ B の `TerminalWindow` が再レンダーされないこと。

## 4.4 パン/ズームの transform を React state から外す(CanvasController)

**仕様**: `useCanvas.ts` を「ref + 購読」モデルに書き換える。

```ts
export interface CanvasController {
  getTransform(): CanvasState;                  // { offsetX, offsetY, scale }
  subscribe(cb: () => void): () => void;        // transform 変更通知
  startPan / updatePan / endPan / panBy / zoom / setScale / focusOn / zoomToFit;
  // 既存 API は維持。内部実装だけ ref ベースに
  containerRef: RefObject<HTMLDivElement>;      // Canvas の transform 適用先
}
```

1. transform は `useRef<CanvasState>` に保持。変更関数は ref を更新し、`containerRef.current.style.transform = translate(...) scale(...)` を**直接書き**、リスナーへ通知する。React の再レンダーは発生させない。
2. `Canvas.tsx`: transform を props で受けるのをやめ、controller を受け取り `containerRef` を transform 対象 div に張る。カーソル(`grab`/`grabbing`)もパン開始/終了時に `style.cursor` を直接書く(現状の「render 時に ref を読む」バグも同時に解消)。
3. `ZoomIndicator.tsx`: `useSyncExternalStore(controller.subscribe, () => controller.getTransform().scale)` で % 表示を購読。
4. イベント時に transform が要る箇所(`Sidebar` の focus 計算、`App.tsx` の `addNewTerminal` の中央配置計算など、`canvas.transform` を参照している全箇所を grep)は `controller.getTransform()` 呼び出しに置換。**これにより `addNewTerminal` が await 前にキャプチャした stale transform を使うバグも自然解消**(await 後に getTransform を呼ぶ形にする)。
5. 2.4 の永続化は「subscribe + 500ms デバウンス保存」に載せ替え。
6. `LinkLines` / ウィンドウ群は transform 適用 div の**内側**にあるので何も変わらない。ミニマップ/エッジバッジ(フェーズ 6)はこの subscribe API を使う。

**注意**: `focusOn` / `zoomToFit` はアニメーションなしの即時ジャンプで現状維持。スムーズ化はスコープ外。

**受け入れ基準**: パン/ズーム中に React 再レンダーが発生しない(Profiler 確認)。ズーム %、focus、zoom-to-fit、auto-layout、ウィンドウ中央生成が全て従来どおり動く。

## 4.5 リサイズの SIGWINCH 抑制

**背景**: 手動リサイズ中、mousemove ごとに `updateTerminal` → ResizeObserver → `fit()` → cols/rows が変わるたび WS resize フレーム送信、で TUI に再描画ストームが起きる。

**仕様**: `TerminalContent.tsx` の ResizeObserver ハンドラに 100ms の trailing デバウンスを入れる(最後のリサイズから 100ms 後に1回 fit)。既存の「cols/rows 不変なら送らない」チェックは維持。

**受け入れ基準**: Claude Code 実行中のウィンドウをドラッグでリサイズしても、リサイズ完了後に1回だけ再描画される。

## 4.6 ドラッグ中アンマウントのリスナーリーク修正

**背景**: `TerminalWindow.tsx`(ドラッグ)と `ResizeHandle.tsx` は `document` に mousemove/mouseup リスナーを張り、mouseup でしか外さない。ドラッグ中に PTY exit などでウィンドウがアンマウントされるとリスナーがページ寿命で残る。

**仕様**: アクティブなリスナーを ref に記録し、`useEffect(() => () => { /* remove */ }, [])` のクリーンアップで必ず外す。

## 4.7 xterm モンキーパッチのガード

**背景**: `TerminalContent.tsx` はズーム時の座標補正のため `(term as any)._core._mouseService.getCoords` をパッチしている。xterm 更新で静かに壊れる。

**仕様**:
1. パッチ前に `_core?._mouseService?.getCoords` の存在を検査し、無ければ `console.warn` 1回でスキップ(クラッシュではなく「ズーム≠100%時の選択座標ずれ」への劣化に留める)。
2. `package.json` の `@xterm/xterm` / addon 群をキャレットなしの完全固定バージョンにピン留めし、パッチ箇所に「xterm を更新する場合はこのパッチの動作確認必須」とコメントを残す。

## 4.8 (ストレッチ)ビューポートカリング

余力があれば: `Canvas.tsx` で各ウィンドウ矩形とビューポート(transform から逆算、マージン 500px)の交差判定を行い、画面外ウィンドウのコンテンツ部分(xterm を含む div)を `visibility: hidden` にする。**アンマウントはしない**(xterm の状態とWS を保つ)。タイトルバーと枠は描画したままで良い。効果計測(Profiler)とセットで。やらない判断も可 — その場合この項を「未実施」とどこかに記録すること。
