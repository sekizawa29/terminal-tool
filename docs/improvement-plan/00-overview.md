# terminal-board 改修計画 — 全体概要

このディレクトリは、コードベース全体の監査(2026-06-10 実施、基準コミット `e46eb92` + 未コミット差分)に基づく改修計画です。実装者(別セッションの Claude)は **必ずこのファイルを最初に読み**、その後フェーズ順に各ドキュメントを読んで実装してください。

## プロジェクトの性格

- ブラウザ上の無限キャンバス(パン/ズーム)に、本物のターミナル(xterm.js ⇄ WebSocket ⇄ node-pty)をウィンドウとして並べるローカルツール。
- 主用途は Claude Code / Codex などの AI エージェントを複数走らせること。ターミナル同士を「リンク」して、エージェント間でタスク送信・通知ができる(`bin/tt` CLI と MCP サーバー経由)。
- ユーザーが最も重視しているのは **ターミナル間相互通信の信頼性** と **無限ボードの UX**。

## アーキテクチャ早見表

| 領域 | ファイル | 役割 |
|---|---|---|
| サーバー | `server/index.ts` (~1480行) | Express + WS。全 HTTP API、リンク管理、タスク/通知 API |
| サーバー | `server/pty-manager.ts` (~2470行) | PTY 生成/入出力、ヘッドレス xterm でのレンダリング、`pasteAndSubmit`、通知キュー、タスクレジストリ、ディスクキャプチャ |
| サーバー | `server/screenshot.ts` | OS ネイティブの範囲スクリーンショット |
| CLI | `bin/tt` (~1950行) | エージェントが叩く CLI。Unix ソケット優先・HTTP フォールバック。`tt mcp-stdio` で MCP ツール12個を公開 |
| クライアント | `client/App.tsx` | ルート。ウィンドウ生成、レイアウト復元、Canvas/Sidebar 配線 |
| クライアント | `client/hooks/useTerminalStore.ts` | zustand ストア。ウィンドウ Map、リンク、localStorage 永続化 |
| クライアント | `client/hooks/useCanvas.ts` | パン/ズーム transform(React state) |
| クライアント | `client/components/Canvas.tsx` | transform 適用コンテナ、ホイール処理、ウィンドウ列挙 |
| クライアント | `client/components/TerminalWindow.tsx` | ウィンドウ枠。ドラッグ/リサイズ/リンクドット/各コンテンツの出し分け |
| クライアント | `client/components/TerminalContent.tsx` | xterm 本体、WS 接続、fit、D&D アップロード |
| クライアント | `client/components/Sidebar.tsx` (~1170行) | セッション一覧、2秒ポーリング、最近の dir、各種ボタン |
| クライアント | `client/components/ExplorerContent.tsx` (~940行) / `EditorContent.tsx` / `BrowserContent.tsx` / `MemoContent.tsx` | 補助ウィンドウ |

## フェーズ構成と順序

| フェーズ | ドキュメント | 内容 | 依存 |
|---|---|---|---|
| 0 | (本ファイル末尾) | WIP 差分のコミット | なし |
| 1 | `01-security.md` | 127.0.0.1 バインド、トークン認証、パス封じ込め | 0 |
| 2 | `02-quick-fixes.md` | panBy 修正、localStorage スキーマ版数、WS 自動再接続、transform 永続化 | 1 |
| 3 | `03-messaging-reliability.md` | タスク送信のキュー化、配信確認、エージェントプロファイル、リンク状態ドリフト修正 | 1 |
| 4 | `04-client-performance.md` | セレクタ購読、React.memo、transform の ref 化、リサイズ デバウンス | 2 |
| 5 | `05-aux-safety-refactor.md` | DOMPurify、エディタ競合検出、iframe sandbox、巨大コンポーネント分割 | 1 |
| 6 | `06-ux-features.md` | 注意喚起バッジ、ミニマップ、検索、死亡セッション復元、エクスプローラ統合、メモ永続化、リンクUX、ブラウザ完成 | 2, 4 |
| 7 | `07-appendix-small-fixes.md` | 小粒の修正群(各フェーズの合間や最後に) | 適宜 |

フェーズ 3 と 4 は互いに独立(並行可)。フェーズ 6 は 4 の CanvasController API(4.4)と 2 のスキーマ版数(2.2)に依存するため最後。

## 実装ルール(全フェーズ共通)

1. **行番号は参考値**。基準コミット時点のもので、実装が進むとずれる。必ず記載のシンボル名(関数名・変数名)で grep して現在位置を特定すること。**ドキュメントとコードが食い違ったらコードが正**。意図を汲んで適応すること。
2. **タスク単位でコミット**する(例: `feat(security): bind server to loopback`)。1コミット = 1タスク。フェーズ完了ごとに `npx tsc --noEmit` と `npm run build` が通ることを確認。
3. **検証**: `npm run dev` で起動(Vite :5173 / backend :3001。`start.sh` 経由だと :51730/:51731)。各タスクの「受け入れ基準」を満たすことを確認してからコミット。ブラウザ確認が必要なものは curl / WS クライアントで代替可能な範囲はそれで検証する。
4. **新規依存は最小限**: 許可済みは `dompurify`(+`@types/dompurify`)と `@xterm/addon-search` のみ。xterm 本体のアップグレードは**禁止**(プライベート API へのモンキーパッチがあるため。`TerminalContent.tsx` の `_core._mouseService` 参照)。
5. 既存のコードスタイル(インラインスタイル中心、コメントは英語、UI 文言は日本語混在)に合わせる。
6. UI 文言は既存に倣い日本語で良い。
7. **キーボードナビゲーション機能(Cmd+1..9 / Cmd+K パレット等)は意図的にスコープ外**。実装しないこと(監査では提案されたがユーザーが除外した)。

## フェーズ 0: 未コミット差分のコミット

現在のワーキングツリーに監査済みの WIP 差分が2件ある。どちらも妥当と確認済みなので最初にコミットする:

1. `server/index.ts` — `server.on('error')` で EADDRINUSE 時に分かりやすいメッセージを出して exit(1) するハンドラ。
2. `server/pty-manager.ts` — PTY 子プロセスの env から `PORT` / `VITE_PORT` を除去(`start.sh` がエクスポートするため、ターミナル内で起動した dev サーバーが tboard のポートを奪う事故の修正)。

```bash
git add server/index.ts server/pty-manager.ts
git commit -m "fix(server): handle EADDRINUSE and strip PORT/VITE_PORT from PTY env"
```

**その他の untracked ファイル(`.DS_Store`, `Icon\r`, `screenshot-*.png`)と `public/logo.png` の削除は触らない**(ユーザー判断待ち)。ただし `.gitignore` に `.DS_Store` を追加するのは可。
