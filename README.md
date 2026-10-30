# 絵チャ

みんなで同じキャンバスに描けるお絵描きチャット。静的サイト（GitHub Pages）＋ Supabase で動く。

公開ページ: https://kaikomziu.github.io/oekaki-chat/

## できること

- **部屋**: ロビーで作成。公開範囲を選べる
  - 完全公開 … ロビーの一覧に出る
  - URL限定 … 一覧に出ない。推測できない URL を知っている人だけ入れる
  - パスワード … 一覧に出ない。URL とパスワードの両方が必要
- **レイヤー**: 最大 32 枚。追加・削除・並べ替え・名前変更・全消しは部屋の全員に反映。
  表示 / 非表示と不透明度は自分の画面だけ
- **ブラシ**: ペン・消しゴム（本当に透明にする）・スポイト・手のひら。太さ・不透明度・筆圧・手ぶれ補正
- **取り消し / やり直し**: 自分の線を 30 分以内なら取り消せる（全員の画面から消える）
- **表示**: ズーム（Ctrl+ホイール・ピンチ）、パン（ホイール・スペース+ドラッグ・中ボタン・2 本指）、ブラシの大きさの円カーソル
- **チャット**、接続人数、PNG 書き出し

### ショートカット

| キー | 動作 |
| --- | --- |
| B / E / I / H | ペン / 消しゴム / スポイト / 手のひら |
| Alt+クリック | スポイト |
| [ / ] | ブラシを細く / 太く |
| Ctrl+Z / Ctrl+Shift+Z・Ctrl+Y | 取り消し / やり直し |
| + / - / 0 | 拡大 / 縮小 / 画面に合わせる |
| スペース+ドラッグ | パン |

## しくみ（節約のポイント）

| データ | どこに置くか |
| --- | --- |
| 描いている途中の線 | Supabase Realtime の broadcast（DB に書かない） |
| 描き終わった線 | `oekaki_strokes` → 毎日 GitHub Actions がレイヤーごとの PNG に焼き込んで削除 |
| チャット | `oekaki_messages` → 24 時間経ったら `data/<部屋>/log/YYYY-MM.json` に移して削除 |

閲覧者は `data/<部屋>/meta.json` とレイヤー画像（GitHub Pages から配信）を下敷きにして、
その後の線だけを Supabase から取るので、DB の容量も転送量もほとんど増えない。
毎日 Actions が Supabase にアクセスするので、無料プランの「1 週間放置で一時停止」も防げる。

### 非公開部屋の守り方

- テーブルは匿名ユーザーから直接読めない。読み書きはすべて部屋の `secret` を要求する RPC（`supabase/schema.sql`）経由。
  `secret` は `oekaki_join` が返す（パスワード部屋は照合に成功したときだけ）。
- リアルタイム配信のチャンネル名も `secret` から作るので、知らない人は受信できない。
- GitHub リポジトリは公開なので、URL限定・パスワード部屋の画像とログは `secret` から作った鍵で
  AES-GCM 暗号化して置く（`.bin`）。フォルダ名は部屋の内部 ID で、URL とは無関係。

## セットアップ

1. **Supabase**: SQL Editor で [supabase/schema.sql](supabase/schema.sql) を実行する（既存の絵チャのテーブルは作り直される）。
2. **config.js**: Project URL と anon キーを [config.js](config.js) に書く。
3. **GitHub**: Settings → Pages で `main` / `(root)` を公開する。
4. **アーカイブ用の合言葉**: ランダムな文字列を作って GitHub Secrets の `OEKAKI_ARCHIVE_TOKEN` に登録し、
   その SHA-256（16 進）を DB に登録する（service_role キーは使わない）。
   ```bash
   TOKEN=$(openssl rand -hex 32)
   printf %s "$TOKEN" | gh secret set OEKAKI_ARCHIVE_TOKEN
   printf %s "$TOKEN" | sha256sum   # これを下の SQL に入れる
   ```
   ```sql
   update public.oekaki_config set archive_token_hash = '<上のハッシュ>';
   ```
5. Actions タブから `archive` を手動実行して、動くか確かめる。

## ローカルで試す

ES Modules を使うので、ファイルを直接開くのではなく簡易サーバー経由で開く
（`npx serve` は `room.html?r=…` のクエリを落とすので使わない）。

```bash
python -m http.server 5173
```

## 注意

- レイヤー画像は毎日（描かれた部屋のレイヤーだけ）コミットされるので、リポジトリは少しずつ大きくなる。
- 誰でも部屋を作れて、公開部屋には誰でも描ける。荒らし対策（レート制限やログイン）は入れていない。
- パスワードの総当たり対策は bcrypt の遅さだけ。大事な絵には長いパスワードを使う。
- 塗りつぶし（バケツ）は、全員の画面で同じ結果にするのが難しいので入れていない。
- GitHub はリポジトリに 60 日動きがないと定期実行を止めるので、しばらく使わなかったら Actions を再有効化する。
