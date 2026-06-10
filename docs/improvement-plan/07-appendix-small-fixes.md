# フェーズ 7: 付録 — 小粒の修正群

優先度は低いが監査で確認済みの問題。各フェーズの合間や最後にまとめて。1項目 = 1コミット。

## 7.1 スクリーンショットパスの安全なペースト

**場所**: `server/index.ts` の `POST /api/terminals/:id/screenshot` ハンドラ末尾。

**問題**: 保存パスを `ptyManager.write` で生のまま入力行に書く。クォートはスペース対応のみで、シングルクォート等のシェルメタ文字を含む cwd で壊れる。アイドル検査もなく実行中の入力行に割り込む。

**修正**: POSIX 側は `'...'` で囲み内部の `'` を `'\''` にエスケープ。書き込みは `pasteAndSubmit` ではなく**送信なしのブラケットペースト**(ペーストのみ・Enter なし)に変更し、`canAutoInject` が false の間は通知キューと同様に遅延する(3.1 の outbox に `submit: false` オプションを足すのが素直)。

## 7.2 `findTaskById` の tmpdir 全走査抑制

**場所**: `server/pty-manager.ts` の `findTaskById`。

**問題**: キャッシュミスのたびに `readdirSync(tmpdir())` + ネスト走査。未知 taskId の連打で CPU 増幅。

**修正**: (a) 負キャッシュ(見つからなかった taskId を 60 秒記憶)、(b) 起動時と `registerTask` 時に `taskId → dir` のインデックス Map を養生し、フォールバック走査は Map ミス時のみ・最短 10 秒間隔に制限。

## 7.3 スクロールバック切断境界

**場所**: `pty-manager.ts` のバッファ制限処理(`session.buffer.slice(-SCROLLBACK_BUFFER_LIMIT)` 形の箇所)。

**問題**: 文字数境界で切るためエスケープシーケンスやサロゲートペアの途中で切れ、再接続リプレイ時に一瞬表示が乱れる。

**修正**: スライス後、最初の `\n` まで読み飛ばしてから保持する(行頭境界に揃える)。完全な ANSI パースは不要。

## 7.4 Claude/Codex 自動起動の 500ms 固定待ち

**場所**: `client/App.tsx` の `claudeTerminal` / `codexTerminal`(setTimeout 500ms 後にコマンド文字列を write)。

**問題**: nvm/conda 等でシェル初期化が遅いとキー入力が失われる。

**修正**: WS 接続後、**最初の PTY 出力を受信してから** 300ms 後に送る方式に変更。`TerminalContent` に「初回出力時に一度だけ発火するコールバック」prop を追加するか、`POST /api/terminals` に `initialCommand` パラメータを追加してサーバー側でプロンプト検出後に注入する(後者の方が堅牢で、`canAutoInject` を流用できる。推奨)。

## 7.5 App.tsx のデッドコード掃除

- `tokenVal` のチェックなど、フェッチ済みトークンを REST に使っていない名残(フェーズ 1 で `apiFetch` に統一した後に残骸がないか確認)。
- `addNewTerminal` の stale transform(4.4 で `getTransform()` 化により解消済みのはず — 残っていれば修正)。

## 7.6 `markNotificationsRead` の `Math.max(...spread)`

**場所**: `pty-manager.ts`。キュー上限 50 なので実害はないが、`reduce` に置き換えてキャップ依存をなくす。

## 7.7 レイアウト保存の網羅性確認

`saveLayout` の呼び出し箇所(作成/ドラッグ終了/リサイズ終了/close/rename/beforeunload)を grep で再点検し、フェーズ 6 で追加した状態(dead フラグ、cwd)が全経路で保存されることを確認する。

## 7.8 (任意)recent-dirs のサーバープッシュ化

**現状**: サイドバーが 2 秒ポーリングで cwd 差分を検出してサーバーへ POST し返す回りくどい構造。高速な `cd a && cd b` を取りこぼす。

**修正案**: サーバーは status 計算時に cwd を既に取得しているので、変化検出とrecent-dirs への追加をサーバー側(`pty-manager` の status 更新時)で完結させ、クライアントの差分検出 + POST を削除する。`/api/dirs` の GET はそのまま。実施しない場合はスキップで良い(挙動上の実害は小さい)。
