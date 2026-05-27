# yfinance-screener-site

毎日の日本株スクリーニング結果を表示する静的サイト（**Cloudflare Pages**・HTTP Basic 認証で保護）。
米国株版 [`finviz-screener-site`](https://github.com/kiri-trader/finviz-screener-site) の日本株版。

- 配信: Cloudflare Pages（`*.pages.dev`）。アクセスには ID・パスワードが必要。
- スクリーニング本体（非公開）: `yfinance_screener` リポジトリ。本リポジトリは**表示用のサイトとデータのみ**を持つ。

## 構成

- `web/` … サイト本体（`index.html` / `style.css` / `app.js`、依存なしの vanilla JS。銘柄リンクは kabutan、TV取込は TSE: 形式）
- `build_site.py` … `data/*_yf_sc.csv` と `*_industry_rs.csv` を読んで `data.json` を生成し、
  `web/` とともに出力先（既定 `_site/`）へ書き出す（標準ライブラリのみ）。
- `functions/_middleware.js` … 全リクエストに HTTP Basic 認証を要求する Cloudflare Pages Function。
  資格情報は環境変数 `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` から読む（後述）。
- `data/` … 抽出リスト（`*_yf_sc.csv`）と業種RSランキング（`*_industry_rs.csv`）。
  スクリーニング実行機が日次で push して更新する。

## CSV の列

抽出リスト `*_yf_sc.csv`（utf-8-sig / BOM付き）:

```
コード, 銘柄名, 市場, 業種(17), 業種(33), 前日比(%), 52週安値乖離(%),
終値(円), 当日出来高, 10日平均出来高, RS, Industry Rank, Grade
```

業種RS `*_industry_rs.csv`:

```
Rank, Grade, Industry(Sector33), Sector(17), RS, Median Raw, Count
```

`RS` は銘柄RS（全銘柄パーセンタイル 1-99）、`Grade`/`Industry Rank` は所属業種(33)の
業種RSグレード・順位。銘柄ごとの数値 Industry RS 列は持たないため、サイト側は同日の
`industry_rs.csv` から 業種(33) 名で join して乖離判定などに使う。

## デプロイ（Cloudflare Pages）

GitHub 連携で push のたびに自動ビルド・デプロイされる。ダッシュボードのビルド設定:

| 項目 | 値 |
| --- | --- |
| Build command | `python build_site.py --out _site` |
| Build output directory | `_site` |
| Root directory | （リポジトリ直下のまま） |

- Python が見つからない/古い場合は環境変数 `PYTHON_VERSION` に `3.12` 等を設定する。
- 認証の資格情報は **Settings → Environment variables** で登録（値は Encrypt）:
  - `BASIC_AUTH_USER` … ログインID
  - `BASIC_AUTH_PASS` … パスワード
- `functions/` はビルド出力（`_site`）とは別にリポジトリ直下から読まれ、自動で Worker 化される。

## ローカルプレビュー（認証なし・表示確認用）

```powershell
python build_site.py --out _site
cd _site; python -m http.server 8765   # → http://localhost:8765/
```
（`file://` 直開きは fetch がブロックされるためサーバー経由で開く。
`_middleware.js` の認証は Cloudflare 上でのみ働き、この簡易サーバーには掛からない）

## 認証の動作確認（デプロイ後）

```powershell
curl.exe -I https://<your-project>.pages.dev/                       # → 401 Unauthorized
curl.exe -I -u "ID:パスワード" https://<your-project>.pages.dev/    # → 200 OK
```
