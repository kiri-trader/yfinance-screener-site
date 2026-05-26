# yfinance-screener-site

毎日の日本株スクリーニング結果を表示する静的サイト（GitHub Pages）。米国株版
[`finviz-screener-site`](https://github.com/kiri-trader/finviz-screener-site) の日本株版。

- 公開URL: https://kiri-trader.github.io/yfinance-screener-site/
- スクリーニング本体（非公開）: `yfinance_screener` リポジトリ。本リポジトリは**表示用のサイトとデータのみ**を持つ。

## 構成

- `web/` … サイト本体（`index.html` / `style.css` / `app.js`、依存なしの vanilla JS）
- `build_site.py` … `data/*_yf_sc.csv` と `*_industry_rs.csv` を読んで `data.json` を生成し、
  `web/` とともに出力先（既定 `_site/`）へ書き出す（標準ライブラリのみ）。
- `.github/workflows/deploy-pages.yml` … push 時に `build_site.py` を実行し GitHub Pages へデプロイ。
- `worker/` + `wrangler.jsonc` … Cloudflare Worker のログインゲート（任意）。Pages を公開したくない
  場合は Cloudflare 経由で配信し、Basic認証相当のログインを掛けられる。Secret は
  `AUTH_USER` / `AUTH_PASS` / `AUTH_SECRET`。
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

## ローカルプレビュー

```powershell
python build_site.py --out _site
cd _site; python -m http.server 8765   # → http://localhost:8765/
```
（`file://` 直開きは fetch がブロックされるためサーバー経由で開く）
