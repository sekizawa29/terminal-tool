<p align="center">
  <img src="public/logo.svg" alt="tboard" width="360">
</p>

<p align="center">
  無限キャンバス上でターミナルを管理するブラウザベースのツール。<br>
  複数のシェルセッションを並べ、ターミナル同士を接続し、AIエージェントを操作できます。
</p>

---

## 機能

- **無限キャンバス** — パン・ズームで自由にターミナルウィンドウを配置
- **マルチシェル** — Bash / Zsh / PowerShell のセッションを好きなだけ同時起動
- **ターミナル間通信** — ターミナルをリンクし、`tt` CLI でコマンドを送受信
- **AIエージェント起動** — Claude・Codex などをワンクリックで起動
- **ファイルエクスプローラー** — ツリー表示、ドラッグ&ドロップ、リネーム、削除
- **テキストエディター** — キャンバス上でファイルを直接編集
- **メモパネル** — ボードに貼り付けるメモ帳
- **レイアウト自動保存** — ウィンドウ位置やリンクが自動的に保持される
- **クロスプラットフォーム** — macOS / Linux / Windows (WSL2) 対応

## 動作要件

- **Node.js** 18 以上 (npm 含む)
- **macOS** または **Linux** — そのまま動作
- **Windows** — WSL2 が必要。Node.js は **WSL 内**にインストールすること

## セットアップ

### macOS / Linux

```bash
git clone https://github.com/sekizawa29/terminal-tool.git
cd terminal-tool
./start.sh
```

`start.sh` が以下を自動で行います:
1. `node_modules/` がなければ `npm install` を実行
2. 開発サーバー (フロントエンド + バックエンド) を起動
3. ブラウザをアプリモードで自動オープン (Chrome, Edge, Brave, Safari の順に検出)

### Windows (WSL2)

**前提:** WSL2 と Linux ディストリビューションがインストール済みで、WSL 内に Node.js がインストールされていること (Windows 側の Node ではなく WSL 側)。

1. WSL ターミナルでリポジトリをクローン:
   ```bash
   git clone https://github.com/sekizawa29/terminal-tool.git
   cd terminal-tool
   ```

2. 以下のいずれかで起動:
   - **WSL ターミナル:** `./start.sh`
   - **エクスプローラー:** `start.bat` をダブルクリック
   - **コマンドプロンプト / Windows Terminal:** `start.bat`

   `start.bat` はリポジトリの WSL パスを自動検出するため、手動設定は不要です。

起動後、ブラウザで `http://127.0.0.1:51730` が開きます。

> **ヒント:** WSL 内で nvm を使っている場合、`start.sh` が自動検出して読み込みます。

### 手動起動 (全プラットフォーム共通)

```bash
npm install
npm run dev
```

Vite 開発サーバー (ポート 5173) とバックエンド API サーバー (ポート 3001) が起動します。ブラウザで `http://127.0.0.1:5173` を開いてください。

## 本番ビルド

```bash
npm run build
npm start
```

Vite でフロントエンドをビルドし、サーバーの TypeScript をコンパイルした後、`dist/` から配信します。

## 使い方

### キャンバス操作

| 操作 | ショートカット |
|------|--------------|
| 新規ターミナル | `Ctrl/Cmd + Shift + N` |
| パン (移動) | 背景をドラッグ / `Space` + ドラッグ / 2本指スクロール |
| ズーム | `Ctrl/Cmd` + スクロールまたはピンチ |

### パネルの種類

サイドバーから作成できます:

- **Terminal** — xterm.js によるシェルセッション
- **Memo** — テキストメモ
- **Explorer** — ファイルツリーブラウザ
- **Editor** — テキストエディター (Explorer でファイルをダブルクリックで開く)

### ターミナルのリンク

ターミナルのコネクターボタンから別のターミナルへドラッグするとリンクが作成されます。リンクしたターミナル同士は `tt` CLI で通信できます。

### `tt` CLI

tboard 内のターミナルでは `tt` コマンドが自動的に使えます:

```bash
tt ls                          # 全ターミナル一覧
tt send <target> <message>     # 別のターミナルにコマンド送信
tt read <target> [lines]       # ターミナル出力の読み取り（クリーン）
tt read <target> --wait        # エージェント完了まで待機して読み取り
tt ipc <target> <message>      # コマンド送信＋応答待ち
tt peers                       # リンク中のターミナル一覧
tt peer ipc "message"          # リンク先にメッセージ送信＋応答待ち
tt peer read --wait            # リンク先の完了を待機して読み取り
tt status                      # 現在のターミナル状態
tt history <target>            # IPC 通信履歴の表示
```

### 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PORT` | `3001` | バックエンド API サーバーのポート |
| `VITE_PORT` | `5173` | Vite 開発サーバーのポート |

`start.sh` 経由で起動した場合、ポートは `51731` (バックエンド) / `51730` (フロントエンド) に固定されます。

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| フロントエンド | React, TypeScript, xterm.js, Zustand |
| バックエンド | Express, node-pty, WebSocket |
| ビルド | Vite |

## ライセンス

MIT
