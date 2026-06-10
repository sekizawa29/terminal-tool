# フェーズ 6: UX 新機能

前提: フェーズ 2(スキーマ版数・WS再接続)、4.4(CanvasController の `getTransform`/`subscribe`)、5.4-3(`useSessionPolling` hook)が完了していること。

**注意: キーボードナビゲーション(Cmd+1..9 巡回、Cmd+K パレット等)はユーザー判断でスコープ外。実装しない。**

## 6.1 オフスクリーン注意喚起(最重要 UX)

**目的**: 「どのエージェントが完了した/入力を待っているか」に気づけるようにする。現状の処理中グロー(`TerminalWindow.tsx` の agent-processing glow)は画面外では見えない。

**仕様**:
1. **検出**(`useSessionPolling.ts` 内): 前回ポーリングとの差分で、エージェントプロセス(既存の判定リスト: claude/codex/aider 等。`TerminalWindow.tsx` 冒頭の配列を共有定数化)が `isProcessing: true → false` に遷移したセッションを「attention」とする。
2. **store**: `attention: Map<string /* windowId */, { kind: 'finished'; at: number }>` と `setAttention` / `clearAttention(windowId)` を追加。ウィンドウがアクティブ化(`setActive`)された時と、attention 発生時にそのウィンドウがビューポート内かつタブが可視(`document.visibilityState === 'visible'`)の場合は付与しない/即クリア。
3. **UI 3点**:
   - **サイドバー**: 該当セッション行に琥珀色のパルスバッジ。セッション数ピルにも合計数を表示。
   - **エッジバッジ**: 新コンポーネント `EdgeBadges.tsx`(transform 適用 div の**外**、fixed レイヤー)。attention 付きウィンドウごとに、ビューポート中心→ウィンドウ中心の方向を計算し、画面端(マージン 16px)にクランプした位置に「⬉ <タイトル>」チップを表示。クリックで `focusOn` + `clearAttention`。ビューポート内に入ったら自動で消す。transform は `controller.subscribe` で追従。
   - **タブ通知**: attention 合計 > 0 の間、`document.title` を `(N) Terminal Board` にする。favicon の動的変更は任意(やるなら canvas で赤ドット合成)。
4. ビューポート内判定: `controller.getTransform()` とウィンドウ矩形から算出するユーティリティ `isWindowInViewport(tw, transform)` を `client/utils/viewport.ts` に作る(6.2 でも使う)。

**受け入れ基準**: 画面外のターミナルで `claude` に短いタスクを実行させ完了させる → 画面端にチップが出てサイドバーがパルスし、クリックでそのウィンドウへジャンプしバッジが消える。

## 6.2 ミニマップ

**仕様**:
1. `client/components/Minimap.tsx` を新設。右下 fixed、220×160px、半透明背景。ヘッダクリックで折りたたみ(状態は localStorage)。
2. 全ウィンドウのバウンディングボックス + 現在ビューポートを包含する範囲を計算し、ウィンドウ矩形を縮小描画(SVG で可)。色: アクティブ=アクセント色、processing=緑、attention=琥珀、その他=グレー。ウィンドウ type ごとに僅かに色相を変えると識別しやすい(任意)。
3. ビューポート矩形を枠線で重畳。`controller.subscribe` で追従。
4. クリック/ドラッグでその地点がビューポート中心に来るよう `controller` のパンを更新。
5. 再レンダー負荷: terminals 購読は `useShallow` で座標配列に絞る。subscribe 由来の更新は rAF スロットル。

**受け入れ基準**: 10 ウィンドウ配置時にミニマップで全体配置とビューポートが見え、クリックジャンプが機能する。ドラッグ/パン中も追従して滑らか。

## 6.3 ターミナル横断検索

**仕様**:
1. **ウィンドウ内検索**: `@xterm/addon-search` を導入。タイトルバーに虫眼鏡ボタン → ターミナル上部に検索バー(input + 前へ/次へ/閉じる)。`findNext`/`findPrevious`、Enter=次へ、Esc=閉じる。ターミナルがフォーカス中の Cmd/Ctrl+F で開いて良い(ナビゲーション系ではないため許可)。ただし xterm 内のキーは `attachCustomKeyEventHandler` 系の既存ブロック処理(`TerminalContent.tsx` の Ctrl キー処理)と整合させること。
2. **全体検索(サーバー側)**: `GET /api/search?q=` を新設。全生存セッションについてヘッドレス xterm のレンダリング済み行(`/api/terminals/:id/rendered` が使う既存機構を流用)から大文字小文字無視の部分一致を探し、`[{ sessionId, name, lineText, lineIndex }]` を返す(セッションあたり最大 20 件、全体 200 件)。
3. **UI**: サイドバー展開時の上部に検索フィールド。300ms デバウンスで `/api/search` を叩き、結果リスト(セッション名 + マッチ行抜粋)を表示。クリックで該当ウィンドウへ `focusOn` + `setActive`。

**受け入れ基準**: 2つのターミナルにそれぞれ固有文字列を echo し、サイドバー検索で両方ヒット・ジャンプできる。ウィンドウ内検索でハイライト移動できる。

## 6.4 死亡セッションのプレースホルダ復元

**背景**: リロード時、生存していないセッションのウィンドウは黙って捨てられ、次の `saveLayout` で配置情報も消える(`App.tsx` の restore 処理)。サーバー再起動でボード配置が全損する。

**仕様**:
1. `TerminalWindow` 型(`client/types.ts`)に `dead?: boolean` を追加。`SavedLayout` には 2.2 で追加済みの `cwd` を使う。
2. restore 時、type が terminal で生存セッションに無いものは捨てずに `dead: true` のままウィンドウ生成。
3. `TerminalWindow.tsx`: `dead` のとき `TerminalContent` の代わりにプレースホルダを描画 — 「セッションは終了しました」+ 保存 cwd 表示 + ボタン [ここで再開] / [閉じる]。
   - [ここで再開]: `POST /api/terminals`(`cwd` 指定。duplicate-with-cwd 用の既存パラメータを流用 — `App.tsx` の `duplicateTerminal` がどう渡しているか確認して同じ形式で)→ 新 sessionId でウィンドウを更新(`updateTerminal` で `sessionId` 差し替え + `dead: false`)。`TerminalContent` は `sessionId` 変更で再マウントされることを確認(effect の依存キー)。
4. `saveLayout` は dead ウィンドウも保存し続ける(配置を失わない)。
5. WS 再接続(2.3)が「セッション消滅(4004)」で打ち切られた場合も、ウィンドウ closed 表示から同じプレースホルダ(`dead: true` へ遷移)に落とすと一貫する — close code 4004 受信時に `updateTerminal(id, { dead: true })`。

**受け入れ基準**: サーバーを再起動してリロード → 全ウィンドウが元の位置にプレースホルダとして残り、[ここで再開] で同じ cwd の新セッションが同じウィンドウで開く。

## 6.5 エクスプローラ統合 + ファイル操作(README 既載の未実装分)

**仕様**:
1. **サーバー** (全てパス封じ込め + 認証適用):
   - `POST /api/files/mkdir` `{ path }`
   - `POST /api/files/create` `{ path }`(空ファイル。既存パスなら 409)
   - `POST /api/files/delete` `{ path }`(`fs.rm(path, { recursive: true, force: false })`。ディレクトリは `recursive: true` 必須フラグを body に要求)
   - リネームは既存 `/api/files/move` を流用。
2. **クライアント** (`ExplorerContent.tsx`): 行の右クリックでコンテキストメニュー(新規コンポーネント `client/components/ContextMenu.tsx`、fixed 配置、外側クリック/Esc で閉じる):
   - ディレクトリ: ここでターミナルを開く / ここで Claude / ここで Codex / 新規ファイル / 新規フォルダ / リネーム / 削除
   - ファイル: 開く(エディタ)/ リネーム / 削除 / ダウンロード
   - リネーム・新規作成はインライン input(行をその場で編集状態に)。削除は `confirm`。
3. **「ここで開く」の配線**: `App.tsx` の既存コールバック(`duplicateTerminal` 相当の cwd 指定生成、`claudeTerminal` / `codexTerminal`)に cwd 引数を通す形で再利用。ExplorerContent は固定パネル(`App.tsx`)とキャンバスウィンドウ(`TerminalWindow.tsx` 経由)の**2箇所**から使われているので、両方の呼び出し元に props を通すこと。
4. 操作後はツリーを部分更新(該当ディレクトリの再読込。既存の refresh が展開状態を保持する仕組みを流用)。

**受け入れ基準**: エクスプローラから新規フォルダ作成→リネーム→ターミナルをそこで開く→削除、が一通り動く。README の機能記載と実装が一致する。

## 6.6 メモのサーバー永続化 + エージェント連携

**背景**: メモは localStorage のみ(`MemoContent.tsx` が毎キーストロークで `saveLayout()`)でエージェントから見えない。

**仕様**:
1. **サーバー**: `~/.local/state/tboard/memos.json` に永続化(dirs.json と同じパターン。`server/index.ts` の dirs 実装を踏襲):
   - `GET /api/memos` → `[{ id, title, text, updatedAt }]`
   - `PUT /api/memos/:id` `{ text, title? }`(upsert)
   - `DELETE /api/memos/:id`
2. **クライアント**: メモウィンドウの `sessionId`(疑似 ID)をメモ id として使う。`MemoContent.tsx`:
   - マウント時 `GET /api/memos` から自分の id を探してあれば**サーバー内容を優先**して hydrate(localStorage からの一回限りの移行: サーバーに無く local にあれば PUT で吸い上げ)。
   - 入力は 500ms デバウンスで `PUT`。毎キーストロークの `saveLayout()` 呼び出しは廃止(レイアウト保存はテキストを含めなくて良くなる — `SavedLayout.memoText` は後方互換のため読み込みのみ残す)。
   - ウィンドウ close 時に `DELETE`(メモはウィンドウと運命共同体で良い)。
3. **bin/tt**: コマンド追加 — `tt memo list` / `tt memo read <id|タイトル前方一致>` / `tt memo write <id> [text]`(text 省略時 stdin)。`tt mcp-stdio` に MCP ツール `memo_list` / `memo_read` / `memo_write` を追加(既存 12 ツールの定義パターンに倣う)。

**受け入れ基準**: メモに書いた内容がリロード後も残り、ボード上のターミナルから `tt memo list` で見える・`tt memo write` の変更が(リロード後)メモに反映される。

## 6.7 リンク UX の磨き込み

**背景**: 接続ドットはウィンドウホバー時のみ表示で機能に気づけない。リンク線は素クリックで即削除(誤爆)。方向(誰が MAIN か)が見えない。

**仕様**:
1. **常時表示**: 接続ドットをホバー時 opacity 1.0 / 非ホバー時 0.35 の常時表示に変更(terminal type のみ、現状どおり)。
2. **タイトルバーにリンクボタン**(チェーンアイコン): クリックで `startLinkDrag(tw.id)` を発火し、以後マウス追従(既存の linkDrag 機構をそのまま使う)。別ウィンドウクリックで成立、Esc / 背景クリックでキャンセル。
3. **方向表示**: `LinkLines.tsx` のベジェに target 側の矢印(SVG marker)と、中点に小ラベル `MAIN → <sub名>` を追加(ホバー時のみ表示で可)。
4. **削除の安全化**: 線の素クリックでの即削除をやめ、クリックで線の中点に小ポップオーバー [リンク解除] [キャンセル] を表示。既存のホバー × ボタンも同じポップオーバーを開く形に統一。
5. **初回ヒント**: ターミナルウィンドウが2枚以上 かつ リンクが一度も作られたことがない(localStorage フラグ `terminal-board-link-hint-shown`)とき、接続ドット付近に一度だけツールチップ「ドラッグして別のターミナルと接続」を表示。リンク成立で恒久的に消す。

**受け入れ基準**: リンクの作成がドット/タイトルバーの両方から行え、線クリックで即削除されない。矢印で方向が分かる。

## 6.8 ブラウザウィンドウの完成

**背景**: `type: 'browser'` のウィンドウは復元時にしか生成されず、UI 上の作成導線がない。X-Frame-Options で拒否されたサイトは真っ白になるだけ。

**仕様**:
1. **作成導線**: サイドバーの追加メニューに「ブラウザ」を追加(`browser` 用のトーン定義が `Sidebar.tsx` に既存)。`App.tsx` に `addBrowserPanel`(`addMemoPanel` のパターンを踏襲、初期 URL `http://localhost:3000`)を実装して配線。
2. **ブロック検出**: ナビゲート時に 5.3 の `GET /api/probe-frame?url=` を叩き、`frameable: false` なら iframe の代わりにフォールバック表示「このサイトは埋め込みを拒否しています」+ [外部ブラウザで開く](`window.open(url, '_blank')`)。probe 失敗(タイムアウト等)は従来どおり iframe を試す。localhost 系 URL は probe をスキップして直接表示して良い。
3. Google 検索の `igu=1` ハックは現状維持(probe 対象外)。

**受け入れ基準**: サイドバーからブラウザウィンドウを作成でき、localhost の dev サーバーが表示できる。`https://github.com` を開くとフォールバックが出て外部で開ける。
