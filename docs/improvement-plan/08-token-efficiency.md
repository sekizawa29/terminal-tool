# フェーズ8: トークン効率化 — 報告書ファースト・中央省略・ノイズ畳み込み・計測

作成: 2026-06-10（コード実査に基づく。基準＝`e259f4b` 時点）
目的: **MAIN エージェントの文脈に入るバイト数を構造的に減らす**。tboard で MAIN が SUB をオーケストレーションするとき、最大のトークン消費源は「MAIN が SUB の生出力（キャプチャ/レンダリングバッファ）を読むこと」。情報は常に全文ファイルに残し（欠落なし）、**MAIN が読む量を段階的に選べる**ようにする。

`00-overview.md` の実装ルール（シンボル名で grep・タスク単位コミット・`npx tsc --noEmit`＋`npm run build` 通過・既存スタイル踏襲・新規依存なし）に従うこと。**行番号は参考値、コードが正**。

## 設計原則（全タスク共通）

1. **3層プロトコル**: manifest.json（機械可読・極小）→ report.md（要約・~2KB目安）→ 詳細ファイル（全文・必要時のみ読む）。
2. **生ログ読み（`tt read`）は残す**。異常時デバッグ用のフォールバック。ただし既定で安く（中央省略・ノイズ畳み込み）。
3. **サーバー側で情報を破壊しない**。切り詰めは「読み出し時の表現」だけ。キャプチャ/レポートのファイル本体は常に全文。省略時は必ず「何が省略されたか＋全文の取得方法」を出力内に明示する。
4. 後方互換: 既存フラグ（`--full` / `--since-send` / `--all` / `--buffer`）の意味は変えない。新しい既定動作からの脱出ハッチを必ず用意する。

## 実装順序

**8.2 → 8.1 → 8.3 → 8.4**（8.1 が 8.2 のヘルパーを使うため。8.3 / 8.4 は独立）。

---

## 8.2 中央省略ヘルパー（middle elision）

**背景**: 長い出力（ビルドログ等）はエラーが冒頭・結論が末尾に出ることが多く、現状の「末尾 N 行」だと冒頭が消え、エージェントが `--all` での全文読みに逃げてトークンを浪費する。Claude Code 本体のツール結果と同じ「先頭＋末尾を残し中間を省略」を導入する。

**仕様**:
1. `server/pty-manager.ts` にモジュールレベルのピュア関数を追加:
   ```ts
   function elideMiddle(text: string, maxBytes: number): { text: string; elided: boolean; omittedLines: number; omittedBytes: number }
   ```
   - `Buffer.byteLength(text) <= maxBytes` ならそのまま返す。
   - 超過時は**行境界で**先頭 ~40% / 末尾 ~60%（バイト配分）を残し、中間を1行のマーカーで置換:
     `… [tboard: {omittedLines} lines / {omittedKB} KB omitted — full output available via --all] …`
   - マルチバイト文字を壊さない（行単位で積むので自然に満たせる）。1行が maxBytes を超える病的ケースは、その行自体を先頭/末尾スライスで切ってよい。
2. 読み出し系に適用（いずれも**読み出し時のみ**。保存データは不変）:
   - `GET /api/terminals/:sessionId/rendered`（`server/index.ts`、ハンドラは `getRenderedBuffer` / `getRenderedBufferSinceSend` 呼び出し箇所）: クエリ `maxBytes` を追加。**指定なしの既定 = 32768**。`maxBytes=0` で無制限。レスポンス JSON に `elided: boolean`（と省略統計）を追加。
   - `GET /api/captures/latest/:source/:target` と `readCapture`（taskId 指定の読み出し経路）: 同様に `maxBytes` クエリ（既定 32768、`0` で無制限）。
3. `bin/tt` 側:
   - `tt read`: `--all` / `--full` 指定時は `maxBytes=0`（全文＝従来通り）。それ以外（既定・`[lines]`・`--since-send`）は server 既定の 32KB 省略に乗る。新フラグ `--max-bytes <n>` を追加。
   - 省略が起きたとき、stderr に1行ヒント（例: `[tt] output elided (… KB omitted). Use --all for full output.`）。stdout は本文のみ（パイプ利用を壊さない）。
4. ヘルプ文字列（`tt read` の Usage、README の tt CLI 表）を更新。

**注意**:
- `rendered?lines=N` と `maxBytes` は併用される（行数で切ってからバイトで省略）。
- `sinceSend` 経路・capture 経路・通常経路の3つすべてに漏れなく適用すること（`readOutput` 内に分岐が3つある）。
- WS/クライアント UI（ブラウザの xterm 表示）には**一切影響させない**。HTTP 読み出し API のみ。

**受け入れ基準**:
- `npx tsc --noEmit` / `npm run build` 通過。
- 一時サーバー（`PORT=3299 npx tsx server/index.ts` 等、稼働中の本番 tboard と別ポート）で: 100KB 超の出力を持つセッションに対し (a) 既定読み出しが ~32KB・先頭と末尾の両方を含む・マーカー行を含む、(b) `--all` で全文、(c) 32KB 未満の出力では `elided=false` かつ本文が完全一致、を curl で確認。
- ピュア関数 `elideMiddle` 自体を `npx tsx -e` のワンライナー（または使い捨てスクリプト）で直接検証（境界: ちょうど maxBytes、1行が巨大、空文字列）。

---

## 8.1 報告書ファースト読み出し（`tt read --wait` の既定を manifest＋report に）

**背景**: タスク完了プロトコル（manifest.json＋report ファイル＋`tt task report/manifest` API）は既に実装済みだが、MAIN の典型動線 `tt send → tt read <target> --wait` は**完了後にキャプチャ（生出力）を返す**ため、せっかくの報告書が使われずキャプチャ全文が MAIN の文脈に入る。既定を逆転させる。

**仕様**:
1. `bin/tt` の `readOutput`（`--wait` フロー）: 待機完了後、対象タスクに manifest が存在する場合の**既定の返却を以下に変更**:
   ```
   [tboard task <task_id>] status=done summary="..."
   changed: f1, f2
   unresolved: (none)
   --- report (report.md) ---
   <report ファイル本文>
   ```
   - report ファイルが無い場合: manifest ブロック＋従来のキャプチャ（8.2 の省略適用）にフォールバック。
   - manifest 自体が無い場合（レガシー/異常終了）: 完全に従来動作（キャプチャ、8.2 適用）。
   - 新フラグ `--capture` で従来動作（キャプチャ読み）を明示的に選択可能。`--full` / `--since-send` が明示されたときも従来どおりキャプチャを返す(既存の意味を保持)。
2. report 読み出しの安全弁（`server/index.ts` の `GET /api/tasks/by-id/:taskId/report`）:
   - `maxBytes` クエリを追加し、`elideMiddle` を適用。**既定 65536**（report は要約想定なので通常は無傷で通る）。`0` で無制限。
   - ファイルサイズのハードリミット **10MB** を追加（超過時は 413 とサイズ・パスを返す。読み込み前に `stat` で判定）。
   - `tt task report` にも `--max-bytes` / `--all` を対応させる。
3. SUB への注入文（`server/index.ts` のリンク確立時 SYSTEM NOTIFICATION、`REPORTING` セクション）に**3層プロトコルの規約**を追記:
   - report.md は**エグゼクティブサマリー（目安 2KB 以内）**: 結論・件数・重要度・次アクション。
   - 量の多い成果物（レビュー全文・テストログ・diff 等）は **task dir 配下の別ファイル**に全文保存し、report.md からファイル名＋1行説明で参照する（例: `details: review.md (12 findings: P0x1 P1x4)`）。
   - 長い出力をターミナルに paste しない（ファイルに書く）。
   - ※強制切断はしない。規約はプロンプトで誘導し、超過は 8.4 の計測で可視化する方針。
4. ヘルプ・README 更新（`tt read` / `tt task report` / REPORTING 規約の説明）。

**注意**:
- `tt last --wait`（`readLast`）は「最後の応答プレビュー」という別用途なので**変更しない**。
- MCP ツール（`tboard_task_report` 等）は既に報告書ファーストの形なので挙動変更不要。ただし report API に入れる maxBytes 既定がMCP 経由の読み出しにも効くことを確認し、ツール description に一言追記。
- manifest ブロックの整形は `tt notifications` のタスクサマリー表示など既存の整形ロジックがあれば流用する。

**受け入れ基準**:
- 一時サーバー＋ダミーセッション2つで: タスク送信→SUB 側で `tt task complete --summary ... --report report.md` →MAIN 側 `tt read <target> --wait` が manifest＋report 本文を返し、**キャプチャ全文を返さない**こと。`--capture` で従来のキャプチャが読めること。report 無しタスクでフォールバックすること。
- 70KB の report で elide が効くこと（マーカー行確認）。
- `npx tsc --noEmit` / `npm run build` 通過。

---

## 8.3 連続類似行の畳み込み（progress run collapse）

**背景**: `\r` 上書き系のスピナーは headless xterm の最終フレーム化と `stripAgentNoise` で既に消えるが、**改行で流れる進捗**（`[12/500] compiling …`、ダウンロード進捗、テストの行連打など）はそのまま残り、生ログ読みを膨らませる。

**仕様**:
1. `server/pty-manager.ts` の clean パス（`stripAgentNoise` の後段、または同関数内の最終段）に畳み込みを追加:
   - 連続する **4 行以上**が「類似」なら、最初の1行＋最後の1行＋マーカー `… [tboard: {k} similar lines collapsed] …` に置換。
   - 「類似」の定義（シンプルに保つ）: 行から数字・パーセント・経過時間らしきトークン（`\d+`、`\d+%`、`\d+(\.\d+)?s` 等）を `#` に正規化した結果が一致する、または正規化後の先頭 32 文字が一致する。
   - ピュア関数 `collapseSimilarLines(lines: string[]): string[]` として切り出し、`clean=true` の読み出しでのみ適用。
2. 既存の「空行3連→2行」圧縮と順序が干渉しないよう、畳み込み→空行圧縮の順に適用。

**注意**:
- 過剰畳み込みのリスク: 表・整形済みリスト（例: `tt ls` の出力、ファイル一覧）が「先頭32文字一致」で潰れないか必ず手で確認する。リスクが高ければ「数字正規化後の完全一致」のみに絞る（保守的に始めること。**迷ったら畳み込まない**）。
- `clean=false`（`--buffer` / raw 経路）には適用しない。
- diff 表示(`+`/`-` 行)はプレフィックスが同一になりやすい。正規化規則に「行頭 `+`/`-`/`|` で始まる行は畳み込み対象外」を入れる。

**受け入れ基準**:
- ワンライナー検証: 進捗 50 行＋通常行のフィクスチャで「first＋last＋マーカー」になること、diff 風 20 行・ファイル一覧 20 行が**畳み込まれない**こと。
- 一時サーバーで `tt read` の clean 出力に反映されること。
- `npx tsc --noEmit` / `npm run build` 通過。

---

## 8.4 読み出しバイト数の計測（`tt stats`）

**背景**: 8.1〜8.3 の効果と「次に何を絞るべきか」をデータで判断できるようにする。現状、read 系 API の返却量を記録する仕組みはない。

**仕様**:
1. `server/pty-manager.ts`（または `server/index.ts` のモジュールスコープ）に in-memory カウンタを追加:
   ```ts
   type ReadStats = { calls: number; bytesReturned: number; bytesElided: number };
   // キー: `${api}` と `${api}:${sessionId}` の2粒度。api = rendered | capture | report | manifest | buffer
   ```
   - 計測ポイント: `rendered` / `captures/latest`＋taskId capture 読み / `tasks/by-id/:id/report` / `tasks/by-id/:id/manifest` / `buffer` の各ハンドラの返却直前。
   - `bytesElided` = elideMiddle が削ったバイト数（8.2 の戻り値から）。
   - サーバー再起動でリセットされる割り切りで良い（永続化しない）。起動時刻 `since` を持つ。
2. `GET /api/stats/reads` を追加: `{ since, totals: {api: ReadStats}, sessions: {sessionId: {api: ReadStats}} }`。
3. `bin/tt` に `tt stats [reads]` を追加: 合計と上位セッションを小さな表で表示（出力自体が大きくならないよう上位 10 まで）。
4. README の tt CLI 表に追記。

**注意**:
- ホットパス（WS のデータ転送）には**計測を入れない**。HTTP 読み出し API のみ。
- カウンタ更新は同期・例外安全に（計測の失敗が API 応答を壊さないこと）。

**受け入れ基準**:
- 一時サーバーで数回 `tt read` / `tt task report` を叩いた後、`tt stats` に calls / bytesReturned / bytesElided が計上されること。
- `npx tsc --noEmit` / `npm run build` 通過。

---

## 進め方・コミット

- ブランチ `feature/token-efficiency` を**専用 worktree**で作業（例: `git worktree add ../terminal-tool-token-eff -b feature/token-efficiency`）。**メイン checkout は稼働中の tboard が使用しているため直接触らない**（`tsx` は watch ではないのでサーバーは再起動しないが、`bin/tt` は呼び出しごとに読まれるため編集途中の状態が他エージェントに見える事故を避ける）。
- 1タスク=1コミット: `feat(token): elide middle of large reads (8.2)` のように。
- 検証用の一時サーバーは**必ず別ポート**（例 `PORT=3299`）。稼働中の tboard（51730/51731 または 5173/3001）に触らない。`npm run dev` は使わず `npx tsx server/index.ts` 単体で良い（クライアントは無関係）。
- 完了後は本ファイルの末尾に実施結果を追記し、`PROGRESS.md` にフェーズ8のエントリを足す。マージとtboard再起動はユーザー判断。
