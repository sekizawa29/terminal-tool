# フェーズ 3: エージェント間通信の信頼性

このフェーズが本ツールの核心。現状の問題: **タスク送信が相手のビジー状態を見ずに PTY へペーストする**ため、生成中のエージェントの入力行を壊すか、黙って捨てられる。通知(notifications)には既にビジー検査+キュー+リトライの機構があるのに、タスク送信はそれを使っていない。

既存機構の場所(`server/pty-manager.ts`):
- `pasteAndSubmit(sessionId, text, opts)` — ブラケットペースト + 350ms 後 Enter + 1200ms 後に1回リトライ(`retryNeedle` が画面末尾に見つからない場合)
- `canAutoInject(sessionId)` — プロンプト待ちか(処理中でない・入力行が空)の判定
- `tryFlushNotifications(sessionId)` / `scheduleNotificationRetry(sessionId)` / `notificationFlushTimers` / `notificationRetryTimers` — 通知のアイドル時フラッシュ機構
- `getPromptTextAtEnd` / `stripAgentNoise` — レンダリング済みバッファからのプロンプト/ノイズ検出(Claude Code の TUI にハードコード)

呼び出し側(`server/index.ts`):
- `POST /api/tasks/send` — `registerTask` 後、`ptyManager.pasteAndSubmit(resolved, paste, { retryNeedle: paste })` を**無条件で直呼び**
- `POST /api/ipc/send`(deprecated)— 同様に直呼び

## 3.1 配信キュー(dispatch outbox)

**仕様**: `pty-manager.ts` に汎用の配信キューを実装する。

1. セッションごとの outbox を追加:
   ```ts
   interface PendingDispatch {
     id: string;            // taskId か turnId(なければ randomUUID)
     paste: string;         // pasteAndSubmit に渡す全文
     retryNeedle: string;
     enqueuedAt: number;
     kind: 'task' | 'ipc';
   }
   private dispatchOutbox = new Map<string, PendingDispatch[]>(); // sessionId → FIFO
   ```
2. 公開メソッド `dispatchToAgent(sessionId, paste, opts: { retryNeedle, kind, id? }): 'delivered' | 'queued'`:
   - `canAutoInject(sessionId)` が true → 即 `pasteAndSubmit` して `'delivered'`。
   - false → outbox に push し、`scheduleNotificationRetry` と同型のリトライ(共通化して `scheduleOutboxRetry` にリネームしても良い)をセットして `'queued'`。
   - outbox 上限 20 件/セッション。超過時は例外を投げ、ハンドラ側で 429 を返す。
3. フラッシュ: 既存の `tryFlushNotifications` を `tryFlushOutbox` に発展させる(または先頭で outbox を流す)。順序は **outbox(タスク)→ 通知** の FIFO。1回のフラッシュで流すのは outbox 1件のみ(連続ペーストでエージェントを混乱させない)。残件があれば再スケジュール。
   - `tryFlushNotifications` の既存呼び出し箇所(通知キュー投入時、リトライタイマ発火時、PTY 出力のアイドル検知があればそこ)を grep で全て特定し、同じトリガで outbox も流れるようにする。
4. ハンドラ変更(`server/index.ts`):
   - `POST /api/tasks/send`: `pasteAndSubmit` 直呼びを `dispatchToAgent(resolved, paste, { retryNeedle: paste, kind: 'task', id: taskId })` に差し替え。レスポンスに `delivery: 'delivered' | 'queued'` を追加。
   - `POST /api/ipc/send`: 同様(`kind: 'ipc'`)。
5. クリーンアップ: セッション終了時(`cleanupHistory` / `killAll` / PTY exit)に該当セッションの outbox とタイマーを破棄。**あわせて既存バグの修正**: `notificationFlushTimers` / `notificationRetryTimers` も同じ場所で clear する(現状 `killAll` でも消えず、死んだセッション宛のタイマーが残る)。

**受け入れ基準**: SUB ターミナルで `sleep 30` 実行中(=非プロンプト)に MAIN から `tt send` / タスク送信 → レスポンスが `queued`、sleep 終了後のプロンプトでメッセージが1件ずつ注入される。プロンプト待ちの相手には従来どおり即時配信。

## 3.2 タスクの配信状態トラッキング

**背景**: MAIN からは「配信されたのか・相手が作業中なのか・未達なのか」が区別できない。`registerTask` で作られるタスクには配信状態がない。

**仕様**:
1. タスクレコード(`registerTask` が作る構造)に `delivery: 'queued' | 'delivered' | 'unconfirmed'` と `deliveredAt?: number` を追加。
   - `dispatchToAgent` が即配信 → ペースト確認(既存のリトライ機構が `retryNeedle` を画面末尾で確認するロジック)成功時に `delivered`。
   - リトライ後も needle 未確認 → `unconfirmed`(配信はされたかもしれないが確認できない、の意)。
   - キュー滞留中は `queued`。
2. 露出: `GET /api/tasks/:sessionId` と `GET /api/tasks/by-id/:taskId` のレスポンスに `delivery` / `deliveredAt` を含める。`bin/tt` の `tt tasks` / `tt task` 表示と MCP の `task_get` 出力にも反映。
3. `pasteAndSubmit` に完了コールバック(または Promise 化)を追加して確認結果を受け取れるようにする。既存呼び出し箇所(通知フラッシュ等)はコールバック無視で互換。

**受け入れ基準**: タスク送信直後の `tt task <id>` で `delivery: queued|delivered` が見える。ビジー相手に送って配信後 `delivered` に遷移する。

## 3.3 エージェントプロファイル(TUI 検出の差し替え可能化)

**背景**: `stripAgentNoise` / `getPromptTextAtEnd` / `canAutoInject` は Claude Code の TUI(スピナー文字、"esc to interrupt"、`❯`、モデルバッジ等)をハードコードしている。Codex や TUI 変更で busy 検出・応答抽出が壊れる。

**仕様**:
1. `server/agent-profiles.ts` を新設:
   ```ts
   export interface AgentProfile {
     name: string;
     /** このプロファイルを適用するフォアグラウンドプロセス名 */
     processNames: string[];
     /** 末尾画面がプロンプト待ちに見えるか */
     isPromptReady(tailLines: string[]): boolean;
     /** 生成中/処理中に見えるか(スピナー等)。null = 判定不能(バーストヒューリスティックに委ねる) */
     isBusy(tailLines: string[]): boolean | null;
     /** 応答抽出時に除去するノイズ行判定 */
     isNoiseLine(line: string): boolean;
   }
   ```
2. `claudeProfile`: 既存の `stripAgentNoise` / `getPromptTextAtEnd` 内の正規表現群をそのまま移設。
3. `codexProfile`: ベストエフォートで実装(Codex CLI のプロンプト記号・"Esc to interrupt" 類の文言を `processNames: ['codex']` で適用)。確証のない正規表現は入れず、`isBusy` は null を返してバーストヒューリスティックに委ねて良い。
4. `genericProfile`(フォールバック): `isPromptReady` は「末尾行が `$ `, `% `, `> `, `❯ ` 等のシェルプロンプト風で終わる」程度の緩い判定 + 既存の出力バーストヒューリスティック(`isProcessing`)。
5. `pty-manager.ts`: セッションのフォアグラウンドプロセス名(既存の foreground 検出。`SessionStatus.foregroundProcess` を作っている箇所)からプロファイルを選択する `getProfile(sessionId)` を追加し、`canAutoInject` / `stripAgentNoise` / `getPromptTextAtEnd` の内部実装をプロファイル委譲に置き換える。**外部から見た関数シグネチャと挙動(Claude に対して)は変えない**。

**受け入れ基準**: 既存の Claude ワークフロー(タスク送信→ `tt task complete` →応答読み取り)が回帰しない。`rg "esc to interrupt|❯" server/pty-manager.ts` がヒットしない(全て agent-profiles.ts に移っている)。

## 3.4 リンク状態ドリフトの解消

**背景** (`client/hooks/useTerminalStore.ts`):
- `removeTerminal` はクライアント側 `links` をフィルタするだけで、サーバーの `DELETE /api/links` を呼ばない → 死んだピアへのルートがサーバーに残る。
- `addLink` は呼ばれるたびに `PUT /api/terminals/:id/name` で `sub-N` を送る。リロード時のリンク復元(`App.tsx` の restore 処理)も `addLink` を使うため、**カスタム名がリロードごとに上書きされる**。`subCount` も現在のリンク数から計算するため削除後に重複し得る。
- サーバーの `POST /api/links` はリンク作成時に両 PTY へコンテキストペーストを注入するため、復元のたびに再注入される懸念もある。

**仕様**:
1. **サーバー側で `POST /api/links` を冪等に**: 既にリンク済みのペアなら、ペースト注入や `recentlyUnlinked` 処理をスキップして `{ ok: true, alreadyLinked: true }` を返す。
2. **自動命名をサーバー側へ移動**: `POST /api/links` の body に `autoName?: boolean` を追加。true かつ **target セッションにまだ名前がない場合のみ**、サーバーが既存 SUB 数を数えて `sub-N` を付ける(`setName` 経由)。レスポンスに `assignedName?: string` を含め、クライアントはそれでタイトルを更新する。クライアント側の `PUT /name` 呼び出し(`addLink` 内)は削除。
3. **store の `addLink`**: `autoName: true` で POST。**新設 `restoreLink(sourceId, targetId)`**: クライアント state とサーバー登録だけ行い `autoName` なし。`App.tsx` のリンク復元箇所を `restoreLink` に差し替え。
4. **store の `removeTerminal`**: 削除前に該当ウィンドウに触れるリンクを列挙し、各ペアの sessionId で `DELETE /api/links` を発火(fire-and-forget、`removeLink` の既存実装と同じ形)。その後 `saveLinks()` も呼ぶ(現状呼ばれておらず localStorage にもゴミが残る — 要確認の上修正)。

**受け入れ基準**: リンク済みターミナルの片方を閉じる → `GET /api/links` から該当ペアが消える。SUB をリネームしてリロード → 名前が保持される。リロードしてもターミナルにコンテキストペーストが再注入されない。

## 3.5 セッション名の一意性

**背景**: `setName`(`pty-manager.ts`)は `nameIndex[name]` を無条件上書きするため、同名を付けると先行セッションの名前ルーティングが奪われる(メッセージの誤配先になる)。

**仕様**: `setName` で名前が他の生存セッションに使われている場合、`-2`, `-3`… を自動付与して確定し、確定後の名前を返す。`PUT /api/terminals/:id/name` はレスポンスに確定名を含め、クライアント(`TerminalWindow.tsx` のリネーム処理)はそれをタイトルに反映する。

**受け入れ基準**: 2つのターミナルに同じ名前を付けると2つ目が `name-2` になり、`tt send name ...` が1つ目に届き続ける。
