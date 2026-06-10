# フェーズ 2: 即効性のあるクライアント修正

## 2.1 ホイールパンのクラッシュ修正(1行)

**背景**: `Canvas.tsx` は必須 prop `panBy` を宣言し(`interface` と分割代入、および非 Ctrl ホイールハンドラ内 `panBy(-e.deltaX, -e.deltaY)`)、`useCanvas.ts` は `panBy` を返しているが、**`App.tsx` の `<Canvas ...>` に渡されていない**。背景上の二本指スクロールが毎回 `TypeError: panBy is not a function` で落ちる。`npx tsc --noEmit` でも TS2741 が出る。

**仕様**: `App.tsx` の `<Canvas>` props に `panBy={canvas.panBy}` を追加。

**受け入れ基準**: `npx tsc --noEmit` がエラーゼロ(他のエラーが出たらそれもこのタスクで潰す)。背景上のトラックパッドスクロールでボードがパンする。

## 2.2 localStorage スキーマの版数付け

**背景**: レイアウト(`terminal-board-layout`)とリンク(`terminal-board-links`)は素の配列で保存されており(`useTerminalStore.ts` の `LAYOUT_KEY` / `LINKS_KEY`, `SavedLayout` / `SavedLink`)、形式変更の互換手段がない。フェーズ 6 で形式を拡張するため、先に版数を入れる。

**仕様**:
1. 保存形式を `{ version: 2, items: SavedLayout[] }` / `{ version: 2, items: SavedLink[] }` に変更。
2. `loadLayout` / `loadLinks` は: パース結果が配列なら v1 とみなしそのまま items として扱う(マイグレーション)。`version` 付きオブジェクトなら `items` を返す。未知 version は空配列。
3. `SavedLayout` に `cwd?: string` を追加(保存時に `sessionStatuses` から対応セッションの `cwd` を転記。フェーズ 6.4 で使用)。
4. キャンバス transform 用に新キー `terminal-board-canvas` を追加: `{ version: 1, offsetX, offsetY, scale }`。

**受け入れ基準**: 旧形式の localStorage を持った状態でリロードしてもボードが復元される。保存→リロードで新形式になっている。

## 2.3 WebSocket 自動再接続

**背景**: `TerminalContent.tsx` の `ws.onclose` は `[Connection closed]` を表示するだけ。サーバー再起動・スリープ復帰で全ターミナルが死に、ページリロードしか復帰手段がない。サーバー側ではセッションが生きており、再アタッチ時にスクロールバックを再送する機構(`pty-manager.ts` の `attach` のバッファリプレイ)が既にある。

**仕様**:
1. `TerminalContent.tsx` の WS 接続処理を `connect()` 関数に切り出し、再接続ループを実装:
   - `onclose` 時、以下のいずれかなら**再接続しない**: (a) コンポーネントのクリーンアップによる close(unmount フラグ ref で判定)、(b) 直前に `exit` 制御メッセージを受信済み(既存の `onExit` 経路)、(c) close code が 4001/4003/4004(トークン無効・origin 不正・セッション消滅)。
   - それ以外は指数バックオフで無限リトライ: 1s, 2s, 4s, 8s, 15s(上限15s固定)。
   - 再接続成功時はサーバーがバッファをリプレイするので、**新しい WS を開く直前に `term.reset()`** して二重描画を防ぐ。
   - `onopen` で既存どおり resize 制御フレームを送る。
2. 接続状態を親へ通知: prop `onConnectionChange?: (state: 'connected' | 'reconnecting' | 'closed') => void` を追加。
3. `TerminalWindow.tsx`: タイトルバー左端に状態ドットを表示(connected=緑 `#3fb950`、reconnecting=琥珀 `#d29922` + pulse、closed=赤 `#f85149`)。`type === 'terminal'` のときのみ。reconnecting 中はタイトル横に小さく「再接続中…」。
4. 再接続待機中にユーザーがウィンドウを閉じたらタイマーを必ず clear(unmount クリーンアップで `clearTimeout`)。

**注意**: StrictMode(dev)の二重マウントで `connect()` が2回走る。既存コードは effect のクリーンアップで ws.close している前提を踏襲し、クリーンアップで unmount フラグを立ててから close すること(立てないと旧 effect の onclose が再接続ループを起動し、二重接続でサーバー側が古いソケットを蹴る無限ループになる)。

**受け入れ基準**: `npm run dev` 中にバックエンドプロセスだけ kill → 再起動すると、開いていたターミナルが自動復帰しスクロールバックが(二重描画なしで)戻る。`exit` でシェルを終了したウィンドウは従来どおり閉じる。

## 2.4 キャンバス transform の永続化

**背景**: パン/ズーム位置(`useCanvas.ts` の `transform` state)はリロードで毎回原点 100% に戻る。

**仕様**:
1. `useCanvas.ts`: 初期 state を `terminal-board-canvas`(2.2 のキー)から読む。なければ従来のデフォルト。
2. 変更のたびに 500ms デバウンスで保存(パン終了・ズーム操作後にまとまって書かれれば良い)。
3. `scale` は復元時に既存の clamp(0.1〜3.0)を通す。

**注意**: フェーズ 4.4 で transform は ref ベースに変わる。保存ロジックは「transform が変わったら debounce 保存」という形にしておけば 4.4 でもそのまま移植できる。

**受け入れ基準**: パン/ズームしてリロードすると同じ視点に戻る。
