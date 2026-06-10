# フェーズ 5: 補助機能の安全性とリファクタ

## 5.1 Markdown プレビューの XSS 対策

**背景**: `EditorContent.tsx` は `marked(content)` の結果を `dangerouslySetInnerHTML` に直接渡している。`marked` はサニタイズしない。`<img onerror=...>` 入りの .md を開くと app オリジンでスクリプトが走る(同オリジンにファイル API がいるため実害化する)。

**仕様**: `dompurify` を追加し、`grep -n dangerouslySetInnerHTML client/` で**全箇所**を `DOMPurify.sanitize(marked(content))` 経由に変更。

**受け入れ基準**: `<img src=x onerror="document.title='XSS'">` を含む .md のプレビューでタイトルが変わらない。通常の Markdown(見出し・コード・表)は従来どおり描画される。

## 5.2 エディタの競合検出(エージェントとの同時編集対策)

**背景**: このツールではエージェントがファイルを書き換えることが**前提**なのに、エディタは外部変更を検出せず、保存は無条件上書き(`server/index.ts` の `/api/files/write` → `writeFileSync`)。エージェントの変更を人間の Save が黙って潰す。また dirty なエディタウィンドウを閉じても警告がない。

**仕様**:
1. **サーバー**:
   - `GET /api/files/read` のレスポンスに `mtimeMs` を追加。
   - `GET /api/files/stat?path=` を新設(`{ mtimeMs, size, exists }` のみ返す軽量エンドポイント。パス封じ込め適用)。
   - `POST /api/files/write` が `expectedMtimeMs` を受け取った場合: 現ファイルの mtime と不一致なら 409 `{ error: 'conflict', currentMtimeMs }`。`force: true` 指定時は無条件で書く。書き込み成功レスポンスに新しい `mtimeMs` を含める。
2. **クライアント** (`EditorContent.tsx`):
   - 読み込み時に `mtimeMs` を保持。保存時に `expectedMtimeMs` を送る。
   - 409 受信 → エディタ上部にバナー「ディスク上でファイルが変更されています」+ ボタン [再読み込み](変更を破棄してリロード)/ [上書き保存](`force: true` で再送)。
   - ウィンドウがアクティブな間、3秒間隔で `/api/files/stat` をポーリング。mtime が変わっていたら: dirty でなければ自動リロード(ステータスバーに「外部変更を反映しました」を数秒表示)、dirty ならバナー表示。
3. **dirty クローズガード**:
   - store に `dirtyWindows: Set<string>` と `setWindowDirty(id, dirty)` を追加。`EditorContent` が dirty 変化時に呼ぶ。
   - `TerminalWindow.tsx` の close ボタン処理で、対象が dirty なら `confirm('未保存の変更があります。閉じますか?')` を挟む。
   - `removeTerminal` 時に Set からも削除。

**受け入れ基準**: エディタでファイルを開く → 別ターミナルで同ファイルを `echo x >> file` → (a) 未編集なら3秒以内に自動反映、(b) 編集中ならバナー表示、(c) その状態で保存すると 409 → バナーの選択肢が機能する。dirty のまま閉じると確認が出る。

## 5.3 ブラウザウィンドウの iframe sandbox 是正

**背景** (`BrowserContent.tsx`): localhost URL には sandbox 属性が**全く付かず**、フレーム内ページが app と同等の権限(localStorage、ファイル API への fetch)を持つ。

**仕様**:
1. localhost への特例を廃止し、**常に** `sandbox="allow-same-origin allow-scripts allow-popups allow-forms allow-modals"` を付ける(エージェントの dev サーバーは別ポート=別オリジンなので sandbox 逸脱は起きない)。
2. **自オリジンのフレーミング禁止**: ナビゲート先 URL の origin が `location.origin` と一致する場合は iframe を出さず「このアプリ自身は埋め込めません」と表示。
3. (6.8 と共用)`GET /api/probe-frame?url=` をサーバーに新設: http/https のみ許可し、サーバーが HEAD(失敗時 GET)して `X-Frame-Options` / CSP `frame-ancestors` を読み、`{ frameable: boolean, status: number }` を返す。タイムアウト 5 秒。**SSRF 注意**: スキーム検査必須。これはローカルツールなのでプライベート IP 禁止までは不要。

**受け入れ基準**: localhost の dev サーバーが従来どおり表示される。`http://127.0.0.1:<tboardポート>` を開こうとするとブロック表示。

## 5.4 巨大コンポーネントの分割と重複排除

挙動を変えない純リファクタ。**1抽出 = 1コミット**で進める。

1. **共有 API ヘルパー**: `readApiPayload` / `getApiError` が `ExplorerContent.tsx` と `EditorContent.tsx` に重複 → `client/api.ts`(フェーズ1で新設済み)へ統合。
2. **`client/components/icons.tsx`**: `Sidebar.tsx` 内の ~15 個のインライン SVG コンポーネントを移設。
3. **`client/hooks/useSessionPolling.ts`**: `Sidebar.tsx` 内の 2 秒ポーリング effect(`/api/terminals/status` 取得 → `setSessionStatuses` → cwd 差分から recent-dirs POST)を hook に抽出し、**`App.tsx` で1回だけマウント**する(現状 Sidebar 内にあるのは責務違反。フェーズ 6.1 の注意喚起検出もこの hook に載る)。
4. **`client/api/dirsApi.ts`**: Sidebar 内の dirs fetch ヘルパー群を移設。
5. **Sidebar サブコンポーネント**(`SessionRow`, `RecentDirItem`, `DropdownItem` 等)を `client/components/sidebar/` 配下へ分割。
6. **ExplorerContent**: D&D ジオメトリ/ヒットテストを `client/hooks/useExplorerDnD.ts`、ツリー操作(ノード挿入・展開状態管理)を `client/utils/treeUtils.ts`、行レンダラ(~200行)を `TreeRow` コンポーネントへ抽出。
7. **サーバー**: `/api/files` と `/api/files/all` のほぼ同一ハンドラを共通関数に統合(両ルートは互換のため残す。差分は dotfile フィルタのみ)。重複した MIME マップ(`MIME_TYPES` と `IMAGE_MIME`)を1つに。

**受け入れ基準**: 各コミット後に `npx tsc --noEmit` クリーン + エクスプローラ/サイドバー/エディタの主要操作が目視で従来どおり。

## 5.5 エクスプローラの click/dblclick 競合修正

**背景**: ディレクトリ行は single-click で展開トグル、double-click でルート変更が**両方**発火し、展開→即リロードのフラッシュが起きる。

**仕様**: single-click の展開を 250ms タイマーで遅延し、dblclick 発火時はタイマーをキャンセルしてルート変更のみ実行する。

## 5.6 サイドバーの操作性

**背景**: 展開がホバー専用(`onMouseEnter/Leave`、80ms で閉じる)でピン留め不可。セッション行に kill 手段がなく、cwd も見えない。

**仕様**:
1. **クリックでピン留め**: ロゴクリックで展開状態を固定/解除。状態は localStorage(`terminal-board-sidebar-pinned`)に保存。ピン中はマウスリーブで閉じない。
2. **セッション行に閉じるボタン**(ホバー時表示の ×): `DELETE /api/terminals/:id` + store `removeTerminal`。誤爆防止に `confirm` 1回。
3. **セッション行の2行目**に `cwdShort` と `foregroundProcess` を小さく表示(`SessionStatus` に両方既存)。

**受け入れ基準**: ピン留めがリロード後も保持される。サイドバーからターミナルを終了できる。
