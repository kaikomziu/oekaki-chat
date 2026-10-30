# 絵チャ

みんなで同じキャンバスに描けるお絵描きチャット。静的サイト（GitHub Pages）＋ Supabase で動く。

## しくみ（節約のポイント）

| データ | どこに置くか |
| --- | --- |
| 描いている途中の線 | Supabase Realtime の broadcast（DB に書かない） |
| 描き終わった線 | `oekaki_strokes` テーブル → 毎日 GitHub Actions が PNG に焼き込んで削除 |
| チャット | `oekaki_messages` テーブル → 24 時間経ったら `data/<room>/log/YYYY-MM.json` に移して削除 |

閲覧者は `data/<room>/meta.json` と PNG（GitHub Pages から配信）を下敷きにして、
その後の線だけを Supabase から取るので、DB の容量も転送量もほとんど増えない。
毎日 Actions が Supabase にアクセスするので、無料プランの「1 週間放置で一時停止」も防げる。

## セットアップ

1. **Supabase**: プロジェクトを作り、SQL Editor で [supabase/schema.sql](supabase/schema.sql) を実行する。
2. **config.js**: Project URL と anon（publishable）キーを [config.js](config.js) に書く。
3. **GitHub**: このフォルダをリポジトリにして push する。
   - Settings → Pages → 「Deploy from a branch」で `main` / `(root)` を選ぶ。
   - Settings → Secrets and variables → Actions に次の 2 つを登録する。
     - `SUPABASE_URL`
     - `SUPABASE_SERVICE_ROLE_KEY`（**service_role キーは Secrets にだけ置く**）
4. Actions タブから `archive` を手動実行して、動くか確かめる。

部屋は `?room=名前`（英数字・`_`・`-`、32 文字まで）で分けられる。省略時は `lobby`。

## ローカルで試す

ES Modules を使うので、ファイルを直接開くのではなく簡易サーバー経由で開く。

```bash
npx serve .
```

## 注意

- スナップショット PNG は毎日（描かれた部屋だけ）コミットされるので、リポジトリは少しずつ大きくなる。
  気になったら cron の頻度を下げる。
- 誰でも描ける・書ける仕様。荒らし対策（レート制限やログイン）は入れていない。
- GitHub はリポジトリに 60 日動きがないと定期実行を止めるので、しばらく使わなかったら Actions を再有効化する。
