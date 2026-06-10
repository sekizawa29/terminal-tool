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

### フェーズ5: 補助機能の安全性とリファクタ ✅(Codexレビュー済み・P2/P3修正済み)
- `ea13e5f` 5.1 DOMPurify サニタイズ / `76a4595` 5.2 エディタ競合検出 + dirtyクローズガード
- `dc30763` 5.3 iframe sandbox + `/api/probe-frame` / `2e7259b`〜`f5b130c` 5.4 分割(api/icons/dirsApi/polling/sidebar/treeUtils/TreeRow/useExplorerDnD)+ `c714e0c` サーバー重複排除
- `51a0182` 5.5 click/dblclick 250ms / `38b15af` 5.6 ピン留め・閉じる・cwd2行目 / `c9f82e6` レビュー指摘(P2 409バイパス / P3 ローディング)

### フェーズ6: UX 新機能 ✅(Codexレビュー済み・P2×3修正済み)
- `0da9659` 基盤(agents/viewport)/ `821bbe4` 6.1 注意喚起 / `b9e32f2` 6.2 ミニマップ
- `686ae0a`+`428ae08` 6.3 検索 / `7c7edbd` 6.4 死亡セッション復元 / `75bd160`+`d7dda50`+`fa63b1f` 6.5 ファイル操作
- `8739fe4` 6.8 ブラウザ完成 / `7fe3268` 6.7 リンクUX / `204f8b9` 6.6 メモ永続化+CLI/MCP / `3e446ae` レビュー指摘(P2: メモflush/ミニマップref/サイドバーDELETE)

### フェーズ7: 付録 小粒修正 ✅(Codexレビュー実行中)
- `88e107e` 7.3 スクロールバック行頭境界 + 7.6 reduce / `594e1fb` 7.4 プロンプト検出注入 + 7.5 デッドコード除去
- `c1fd10f` 7.1 スクショパス安全ペースト / `635ae3a` 7.2 findTaskById 負キャッシュ+走査スロットル
- **7.7 はコード変更不要**(saveLayout 21箇所が全経路を網羅、cwd 永続化・dead は復元時に再導出を確認)
- **7.8 はスキップ**(任意項目。recent-dirs ポーリングは実害小で仕様上スキップ可)

## 完了
全フェーズ(0〜7)完了。スコープ外のキーボードナビ(Cmd+1..9 / Cmd+K)は未実装。

## 重要な注意点(次セッションへ)

1. **tsc は2系統**: `npx tsc --noEmit`(root, クライアントのみ)と `npx tsc -p tsconfig.server.json --noEmit`(サーバー)。**両方**確認すること。`npm run build` は両方を含むが、`&& echo ok` でのチェックは exit code を取りこぼすことがあるので `; echo $?` で明示確認する。
2. **ランタイム検証**: PORT=3099 で `npx tsx server/index.ts` を起動し、Unix ソケット(`$TMPDIR/tboard-3099.sock`)or `x-tboard-token` ヘッダで curl 検証する。停止前に必ず `pkill -f "tsx server/index.ts"` + `lsof -nP -iTCP:3099 -sTCP:LISTEN -t | xargs -r kill -9` でクリーンアップ(ゾンビサーバーが EADDRINUSE/誤テストの原因になる)。
3. **キーボードナビ(Cmd+1..9 / Cmd+K)はスコープ外**。実装しない。
4. **Codex レビュー**: 各フェーズ完了後 `codex review --base <前フェーズ最終コミット>` をバックグラウンド実行(`--base` と PROMPT は併用不可)。出力は `/tmp/codex-phaseN-review.txt`。10分前後かかる。最終所見は末尾の `codex` ロール行以降。
5. **4.4 は未ブラウザ検証**: pan/zoom/選択座標補正はヘッドレスでは目視確認できていない。型・ビルド・数式踏襲は確認済み。ブラウザでの動作確認が望ましい。
6. 新規依存の許可は dompurify(+types)と @xterm/addon-search のみ。xterm 本体アップグレード禁止(private API パッチあり)。
