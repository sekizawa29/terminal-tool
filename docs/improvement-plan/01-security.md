# フェーズ 1: セキュリティ修正(最優先)

## 背景

現状、サーバーは `server.listen(PORT, '0.0.0.0', ...)`(`server/index.ts` 末尾)で全インターフェースに待ち受けており、かつ **HTTP API には一切の認証がない**。WS アップグレードのみ origin + トークン検査がある。その結果、同一 LAN 上の任意のホストから:

- `GET /api/files/read?path=/etc/passwd` で任意ファイル読み取り(パスのルート制限なし、`resolve(filePath)` のみ)
- `POST /api/files/write` で `~/.zshrc` 等への任意書き込み
- `POST /api/terminals` → `POST /api/terminals/:id/write` でシェルへの任意コマンド注入(実質 RCE)
- `GET /api/token` は誰にでも有効トークンを発行(トークンオラクル)。`validTokens` Set は無限成長

が可能。本フェーズでこれを全て塞ぐ。

## 1.1 ループバックバインド

**仕様**: `server.listen(PORT, '0.0.0.0', ...)` を `'127.0.0.1'` に変更。`cliServer`(Unix ソケット)は変更不要。

**注意**:
- `vite.config.ts` の proxy は既に `http://127.0.0.1:${backendPort}` を向いているので dev は無変更で動く。
- Vite 自体の `host: '0.0.0.0'` は据え置きで良い(UI を LAN の別端末から見るユースケースを残す。API は Vite の proxy 経由 = ループバック発でアクセスされる)。
- WSL2 では localhost フォワーディングがループバックバインドでも機能するため `start.bat` 経由の Windows ブラウザアクセスは壊れない。

**受け入れ基準**: `lsof -nP -iTCP:3001 -sTCP:LISTEN` で `127.0.0.1:3001` のみ。`curl http://<LAN IP>:3001/api/terminals` が接続失敗。

## 1.2 サーバートークンの単一化と `/api/token` の保護

**現状**: `GET /api/token`(`server/index.ts` 冒頭付近、`validTokens` Set)は呼ばれるたびに新トークンを発行して Set に追加し、削除されない。

**仕様**:
1. `validTokens` Set を廃止し、起動時に1回だけ生成する `const serverToken = randomBytes(32).toString('hex')` に置き換える。`GET /api/token` はこれを返す。
2. `GET /api/token` には **Host ヘッダ検査**を追加(DNS リバインディング対策): `req.headers.host` が `localhost(:port)?` / `127.0.0.1(:port)?` にマッチしない場合 403。
3. WS アップグレード時のトークン検査(`wss.on('connection')` 内の `validTokens.has(token)`)を `token === serverToken || ptyManager.isValidSessionToken(token)` に変更(`isValidSessionToken` は 1.3 で追加)。

## 1.3 全 `/api/*` への認証ミドルウェア

**仕様**: Express に以下のミドルウェアを `app.use('/api', ...)` で全ルートの前に挿入する:

```
許可条件(いずれか):
  a) Unix ソケット経由のリクエスト
     判定: req.socket.remoteAddress === undefined(Unix ソケットには remoteAddress がない)
     → bin/tt のソケット経路。ファイルパーミッションで保護されているので信頼する
  b) ヘッダ x-tboard-token が serverToken と一致(crypto.timingSafeEqual で比較。長さ不一致は即 false)
  c) ヘッダ x-tboard-token がいずれかの生存セッションの TBOARD_TOKEN と一致
     → ptyManager に isValidSessionToken(token: string): boolean を追加。
       各セッションの env に注入している TBOARD_TOKEN(pty-manager.ts の spawn 部分、
       タスク完了検証 verifyTaskToken 周辺に既存の timing-safe 比較があるので流用)
       を全セッション走査で timing-safe 比較
  d) GET /api/token のみ例外(1.2 の Host 検査で保護)
  e) GET /api/files/raw と GET /api/files/download のみ、クエリ ?token= でも受け付ける
     (<img src> / <a href> / DownloadURL はヘッダを付与できないため)
不許可 → 401 { error: 'unauthorized' }
```

**クライアント側**: `client/api.ts` を新設:

```ts
let token: string | null = null;
export function setApiToken(t: string) { token = t; }
export function apiFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set('x-tboard-token', token);
  return fetch(input, { ...init, headers });
}
export function withToken(url: string) { /* ?token= を付与(raw/download 用) */ }
```

- `App.tsx` のトークン取得(マウント時の `/api/token` フェッチ → `setToken`)直後に `setApiToken` も呼ぶ。
- **全クライアントファイルの `fetch('/api/...')` を `apiFetch` に機械的に置換**。対象を `grep -rn "fetch('/api" client/` で洗い出すこと。少なくとも: `App.tsx`, `useTerminalStore.ts`, `Sidebar.tsx`, `ExplorerContent.tsx`, `EditorContent.tsx`, `TerminalContent.tsx`(アップロード), `TerminalWindow.tsx`(rename / DELETE / screenshot)。
- `EditorContent.tsx` の画像プレビュー(`?mode=raw` を `<img src>` に直接渡す箇所)と `ExplorerContent.tsx` のドラッグアウト `DownloadURL` は `withToken()` でクエリ付与に変更。

**bin/tt 側**: HTTP フォールバック経路(`detectBase()` 後の fetch)で、`process.env.TBOARD_TOKEN` があれば `x-tboard-token` ヘッダを常に付与する。ソケット経路は変更不要。

**受け入れ基準**:
- ヘッダなし `curl http://127.0.0.1:3001/api/terminals` → 401。
- `curl -H "x-tboard-token: $(正しいトークン)"` → 200。
- ブラウザ UI が全機能(ターミナル作成、エクスプローラ、エディタ保存、画像プレビュー、ファイルD&D、スクリーンショット)で動作。
- ボード上のターミナル内から `tt ls` が動く(ソケット経路)。`TBOARD_SOCKET= TBOARD_URL=http://127.0.0.1:3001 tt ls` も動く(HTTP + セッショントークン経路)。

## 1.4 ファイル API のパス封じ込め

**現状**: `/api/files/read|write|move|upload`, `/api/files`, `/api/files/all`, `/api/files/raw`, `/api/files/download`, `/api/upload` は `resolve(userPath)` のみで、ルート制限がない。既存の `isDescendantPath`(`server/index.ts` 冒頭)は move の自己包含チェックにしか使われていない。

**仕様**: `server/index.ts` にヘルパーを追加し、上記全エンドポイントの入口で呼ぶ:

```ts
const ALLOWED_ROOTS: string[] = (process.env.TBOARD_ALLOWED_ROOTS
  ? process.env.TBOARD_ALLOWED_ROOTS.split(':')
  : [os.homedir(), os.tmpdir()]
).map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });

function assertAllowedPath(p: string): string {
  const abs = resolve(p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p);
  // シンボリックリンク対策: 実在する最も近い祖先の realpath で判定
  let probe = abs;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  const ok = ALLOWED_ROOTS.some((root) => real === root || real.startsWith(root + sep));
  if (!ok) throw new PathNotAllowedError(abs);
  return abs;
}
```

- 違反時は 403 `{ error: 'path not allowed' }` を返す。
- `~` 展開は既存エンドポイントに同等処理があれば流用する(エクスプローラのデフォルトルートが `'~'` なので必ずどこかで展開している。grep で探して一元化)。
- WSL で Windows 側ファイル(`/mnt/c/...`)を見たいユーザーは `TBOARD_ALLOWED_ROOTS` で拡張できる。README にこの env を1行追記。
- `move` は移動元・移動先の両方を検査。`upload` は展開後の各エントリパスを検査。

**受け入れ基準**: `curl -H "x-tboard-token: ..." "http://127.0.0.1:3001/api/files/read?path=/etc/passwd"` → 403。ホーム配下は従来通り読める。エクスプローラの全操作(展開、移動、アップロード、ダウンロード)が動く。

## 1.5 仕上げ

- `POST /api/links` ハンドラ冒頭で `sourceId` / `targetId` を `resolveSession` で解決してから `linkPairKey` / `arePeers` / `addLink` に渡す(現状は生の body 値を使っており、他エンドポイントと解決規則が食い違う)。
- 起動ログの `http://127.0.0.1` 表記は 1.1 で実態と一致するのでそのまま。

## このフェーズで「やらない」こと

- HTTPS 化、ユーザー認証(ローカルツールには過剰)。
- `/api/dirs*` のパス検証(文字列を保存するだけで実害がない。認証ミドルウェアの対象には含まれる)。
