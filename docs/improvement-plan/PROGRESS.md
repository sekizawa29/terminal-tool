# 改修進捗ハンドオフ

このファイルは実装セッション間の引き継ぎ用。`00-overview.md` の計画に対する実施状況を記録する。

## 完了フェーズ(コミット済み)

### フェーズ0: WIP差分のコミット ✅
- `f16ff2c` EADDRINUSE ハンドラ + PTY env から PORT/VITE_PORT 除去
- `public/logo.png` 削除と `.DS_Store` 等の untracked はユーザー判断待ちで未処理(`.gitignore` への `.DS_Store` 追加も未実施)

### フェーズ1: セキュリティ ✅(Codexレビュー済み・指摘1件修正済み)
- `27a2f18` 1.1 ループバックバインド(127.0.0.1)
- `d4f7434` 1.2+1.3 全 /api + WS のトークン認証(serverToken / Host チェック / 認証ミドルウェア / `client/api.ts` / bin/tt ヘッダ)。※1.2と1.3は相互依存のため1コミットに統合
- `3443c2f` 1.4 ファイルAPIパス封じ込め(`assertAllowedPath`、TBOARD_ALLOWED_ROOTS)
- `6eb8510` 1.5 POST /api/links のセッションID解決
- `7151314` レビュー指摘: ExplorerContent `fetchDirectory` の認証漏れ修正

### フェーズ2: 即効クライアント修正 ✅(Codexレビュー済み・P2修正済み)
- `13487dd` 2.1 panBy を Canvas に伝達(tsc エラーゼロ達成)
- `78187cd` 2.2 localStorage スキーマ版数化 v2 + cwd スナップショット
- `a924bfe` 2.4 キャンバス transform 永続化
- `ed26327` 2.3 WS 自動再接続 + 状態ドット
- `71c4717` レビュー指摘(P2): 再接続時の term.reset() を onopen まで遅延

### フェーズ3: メッセージング信頼性 ✅(Codexレビュー済み・P0+P2修正済み)
- `f972002` 3.1 配信アウトボックス(ビジー時キュー)+ タイマーリーク修正
- `75d75bc` 3.2 タスク配信状態 queued/delivered/unconfirmed
- `ee66ace` 3.3 エージェントプロファイル(`server/agent-profiles.ts`)
- `6d782ec` 3.5 セッション名の一意化
- `81b25e6` 3.4 リンク状態ドリフト解消
- `78c695a` レビュー指摘(P0): readCapture の getProfile(sessionId) ビルド破壊修正 / (P2): 拒否時のゴーストタスク防止(dispatchWouldOverflow 事前チェック)

### フェーズ4: 描画パフォーマンス ✅(Codexレビュー済み・指摘なし)
- `e521db5` 4.1 セレクタ購読への統一
- `0fce769` 4.2 ドラッグ/リサイズのミューテーション排除
- `bed6aa2` 4.3 ウィンドウ単位購読 + React.memo
- `f60a204` 4.4 CanvasController(transform を ref 化)
- `33cd52f` 4.5 リサイズfit 100ms デバウンス + 4.6 リスナーリーク修正
- `52d4b1e` 4.7 xterm パッチガード + バージョン固定
- **4.8(ビューポートカリング)はスキップ**(ドキュメント許容の任意ストレッチ項目)

## 残フェーズ

- **フェーズ5**: 補助機能の安全性とリファクタ(`05-aux-safety-refactor.md`)
  - 5.1 DOMPurify(**dompurify 未インストール。`npm i dompurify @types/dompurify` が必要**)
  - 5.2 エディタ競合検出、5.3 iframe sandbox、5.4 巨大コンポーネント分割、5.5 click/dblclick、5.6 サイドバー操作性
- **フェーズ6**: UX 新機能(`06-ux-features.md`)— 4.4 の CanvasController(getTransform/subscribe)と 2.2 のスキーマ版数に依存(両方完了済み)
- **フェーズ7**: 付録 小粒修正(`07-appendix-small-fixes.md`)

## 重要な注意点(次セッションへ)

1. **tsc は2系統**: `npx tsc --noEmit`(root, クライアントのみ)と `npx tsc -p tsconfig.server.json --noEmit`(サーバー)。**両方**確認すること。`npm run build` は両方を含むが、`&& echo ok` でのチェックは exit code を取りこぼすことがあるので `; echo $?` で明示確認する。
2. **ランタイム検証**: PORT=3099 で `npx tsx server/index.ts` を起動し、Unix ソケット(`$TMPDIR/tboard-3099.sock`)or `x-tboard-token` ヘッダで curl 検証する。停止前に必ず `pkill -f "tsx server/index.ts"` + `lsof -nP -iTCP:3099 -sTCP:LISTEN -t | xargs -r kill -9` でクリーンアップ(ゾンビサーバーが EADDRINUSE/誤テストの原因になる)。
3. **キーボードナビ(Cmd+1..9 / Cmd+K)はスコープ外**。実装しない。
4. **Codex レビュー**: 各フェーズ完了後 `codex review --base <前フェーズ最終コミット>` をバックグラウンド実行(`--base` と PROMPT は併用不可)。出力は `/tmp/codex-phaseN-review.txt`。10分前後かかる。最終所見は末尾の `codex` ロール行以降。
5. **4.4 は未ブラウザ検証**: pan/zoom/選択座標補正はヘッドレスでは目視確認できていない。型・ビルド・数式踏襲は確認済み。ブラウザでの動作確認が望ましい。
6. 新規依存の許可は dompurify(+types)と @xterm/addon-search のみ。xterm 本体アップグレード禁止(private API パッチあり)。
