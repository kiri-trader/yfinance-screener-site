"""
build_site.py — 日本株（yfinance）スクリーニング結果の静的サイトをビルドする

data/ に蓄積された日次CSV（`*_yf_sc.csv` = 抽出後リスト、
`*_industry_rs.csv` = 業種RSランキング）を読み、Webページが読み込む
`data.json` を生成する。さらに web/ のHTML/CSS/JSを出力先へコピーして
GitHub Pages にそのまま載せられる一式（既定では _site/）を作る。

設計上の注意:
- **標準ライブラリのみ**で動かす（CI に追加依存を持ち込まない）。
- スクリーニング条件の表示文は yf_screener.py のDiscordメッセージと同じ文字列を
  ここに複製している（config値からの自動生成はしない）。
- 抽出リスト(SC)には銘柄ごとの数値 Industry RS 列が無い（"Grade" と "Industry Rank"
  のみ）。業種RSの数値は同日 industry_rs.csv から 業種(33) 名で join して補う。
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).parent

# yf_screener.py の Discord メッセージ（build_discord_message）と同じ条件表示。
SCREENING_SUMMARY = (
    "前日比≥+5% | 終値100〜10,000円 | 出来高>10日平均 | "
    "52W安値≥+30% | 銘柄RS≥60 | 売買代金≥3千万/日"
)

# CSV の列名（yf_screener.py の save_*_csv と一致させる）
COL_TICKER = "コード"
COL_INDUSTRY = "業種(33)"
COL_RS = "RS"
COL_RANK = "Industry Rank"  # 文字列 "X/33"

# 抽出リスト1件あたりの「業種に何銘柄集中しているか」をハイライトする下限
CONCENTRATION_MIN = 3
# 「乖離」（強い銘柄なのに業種は弱い）と見なす条件
DIVERGENT_RS_MIN = 80
DIVERGENT_DIFF_MIN = 50


def to_int(val: str) -> int | None:
    try:
        s = str(val).strip()
        return int(float(s)) if s else None
    except ValueError:
        return None


def read_csv(path: Path) -> tuple[list[str], list[list[str]]]:
    """utf-8-sig（BOM付き）CSVを読み、(headers, rows) を返す。"""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        all_rows = list(reader)
    if not all_rows:
        return [], []
    return all_rows[0], all_rows[1:]


def col_index(headers: list[str], name: str) -> int:
    return headers.index(name) if name in headers else -1


def load_industry_rs(path: Path) -> tuple[list[dict], dict[str, int], dict[str, int]]:
    """industry_rs.csv を読み、(ランキングリスト, 業種→rank, 業種→RS) を返す。"""
    headers, rows = read_csv(path)
    idx = {
        "rank": col_index(headers, "Rank"),
        "grade": col_index(headers, "Grade"),
        "industry": col_index(headers, "Industry(Sector33)"),
        "sector": col_index(headers, "Sector(17)"),
        "rs": col_index(headers, "RS"),
        "count": col_index(headers, "Count"),
    }
    rankings: list[dict] = []
    industry_to_rank: dict[str, int] = {}
    industry_to_rs: dict[str, int] = {}
    for row in rows:
        def get(key: str) -> str:
            j = idx[key]
            return row[j] if 0 <= j < len(row) else ""
        rank = to_int(get("rank"))
        industry = get("industry").strip()
        rs = to_int(get("rs"))
        if industry:
            if rank is not None:
                industry_to_rank[industry] = rank
            if rs is not None:
                industry_to_rs[industry] = rs
        rankings.append({
            "rank": rank,
            "grade": get("grade").strip(),
            "industry": industry,
            "sector": get("sector").strip(),
            "rs": rs,
            "count": to_int(get("count")),
        })
    return rankings, industry_to_rank, industry_to_rs


def build_insights(
    headers: list[str],
    rows: list[list[str]],
    industry_to_rank: dict[str, int],
    industry_to_rs: dict[str, int],
    total_industries: int,
) -> dict:
    """yf_screener.py の _build_insights 相当を抽出リスト＋業種ランキングから再構成。"""
    i_ind = col_index(headers, COL_INDUSTRY)
    i_rs = col_index(headers, COL_RS)
    i_ticker = col_index(headers, COL_TICKER)

    industries = [rows[k][i_ind].strip() for k in range(len(rows))] if i_ind >= 0 else []

    # 集中業種（同一 業種(33) に CONCENTRATION_MIN 銘柄以上）
    counts = Counter(ind for ind in industries if ind)
    concentrated = [[ind, c] for ind, c in counts.most_common() if c >= CONCENTRATION_MIN][:5]

    # Top業種（抽出銘柄の所属業種で順位が上位のものを最大5つ）
    ranks_present = {ind: industry_to_rank[ind] for ind in counts if ind in industry_to_rank}
    top_industries = [
        {"name": name, "rank": rank}
        for name, rank in sorted(ranks_present.items(), key=lambda kv: kv[1])[:5]
    ]

    # 乖離銘柄（銘柄RS≥80 かつ RS − 業種RS ≥ 50）。業種RSは industry_rs から join。
    divergent = []
    if i_rs >= 0 and i_ind >= 0:
        for row in rows:
            rs = to_int(row[i_rs])
            ind = row[i_ind].strip()
            irs = industry_to_rs.get(ind)
            if rs is None or irs is None:
                continue
            if rs >= DIVERGENT_RS_MIN and (rs - irs) >= DIVERGENT_DIFF_MIN:
                rank = industry_to_rank.get(ind)
                if rank is None:
                    continue
                divergent.append({
                    "ticker": row[i_ticker] if i_ticker >= 0 else "",
                    "rs": rs,
                    "ind_rank": rank,
                    "diff": rs - irs,
                })
        divergent.sort(key=lambda x: -x["diff"])
        divergent = divergent[:5]

    # 銘柄RS高位カウント
    rs_values = [to_int(r[i_rs]) for r in rows] if i_rs >= 0 else []
    rs_values = [v for v in rs_values if v is not None]
    rs_ge_90 = sum(1 for v in rs_values if v >= 90)
    rs_ge_80 = sum(1 for v in rs_values if v >= 80)

    return {
        "concentrated": concentrated,
        "top_industries": top_industries,
        "total_industries": total_industries,
        "divergent": divergent,
        "rs_ge_90": rs_ge_90,
        "rs_ge_80": rs_ge_80,
    }


def collect_days(data_dir: Path) -> dict[str, dict]:
    """data/ を走査し、日付ごとに最新タイムスタンプの SC / industry_rs を選ぶ。

    戻り値: {date: {"prefix": str, "sc": Path, "industry": Path|None}}
    """
    by_date: dict[str, dict] = {}
    for sc_path in sorted(data_dir.glob("*_yf_sc.csv")):
        prefix = sc_path.name[: -len("_yf_sc.csv")]  # 例: 2026-05-26-1600
        date = prefix[:10]
        # 同日複数あれば prefix（時刻含む文字列）が大きい方＝より新しい方を採用
        if date not in by_date or prefix > by_date[date]["prefix"]:
            by_date[date] = {"prefix": prefix, "sc": sc_path, "industry": None}

    # 業種RSを同prefix優先で対応付け（無ければ同日の最新 industry_rs にフォールバック）
    for date, info in by_date.items():
        same = data_dir / f"{info['prefix']}_industry_rs.csv"
        if same.exists():
            info["industry"] = same
        else:
            cands = sorted(data_dir.glob(f"{date}-*_industry_rs.csv"))
            info["industry"] = cands[-1] if cands else None
    return by_date


def collect_industry_days(data_dir: Path) -> dict[str, Path]:
    """industry_rs.csv を日付ごとに最新タイムスタンプで集める（SCの有無に依存しない）。

    業種RSトレンドは業種レベルの指標なので、抽出リスト(SC)が無い日でも拾う。
    """
    by_date: dict[str, tuple[str, Path]] = {}
    for path in sorted(data_dir.glob("*_industry_rs.csv")):
        prefix = path.name[: -len("_industry_rs.csv")]
        date = prefix[:10]
        if date not in by_date or prefix > by_date[date][0]:
            by_date[date] = (prefix, path)
    return {date: p for date, (_, p) in by_date.items()}


def build_data(data_dir: Path, max_days: int) -> dict:
    by_date = collect_days(data_dir)
    days_out: list[dict] = []

    for date in sorted(by_date.keys(), reverse=True)[:max_days]:
        info = by_date[date]
        headers, rows = read_csv(info["sc"])
        if not headers:
            continue

        if info["industry"] is not None:
            industry_rs, industry_to_rank, industry_to_rs = load_industry_rs(info["industry"])
        else:
            industry_rs, industry_to_rank, industry_to_rs = [], {}, {}

        insights = build_insights(
            headers, rows, industry_to_rank, industry_to_rs, len(industry_rs)
        )

        days_out.append({
            "date": date,
            "timestamp": info["prefix"][11:],  # HHMM
            "count": len(rows),
            "columns": headers,
            "rows": rows,
            "insights": insights,
            "industry_rs": industry_rs,
        })

    # 業種RSトレンド: industry_rs がある全日（SC無しの日も含む）の業種ランキング時系列
    industry_days = collect_industry_days(data_dir)
    trend_out: list[dict] = []
    for date in sorted(industry_days.keys(), reverse=True)[:max_days]:
        rankings, _, _ = load_industry_rs(industry_days[date])
        trend_out.append({"date": date, "industry_rs": rankings})

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "screening_summary": SCREENING_SUMMARY,
        "days": days_out,
        "industry_trend": trend_out,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="日本株スクリーニング結果サイトをビルド")
    ap.add_argument("--out", default="_site", help="出力ディレクトリ（既定: _site）")
    ap.add_argument("--data-dir", default=str(BASE_DIR / "data"), help="CSV置き場")
    ap.add_argument("--web-dir", default=str(BASE_DIR / "web"), help="HTML/CSS/JS置き場")
    ap.add_argument("--max-days", type=int, default=120, help="サイトに載せる最大日数（既定120）")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    web_dir = Path(args.web_dir)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 静的ファイルをコピー
    for name in ("index.html", "style.css", "app.js"):
        src = web_dir / name
        if src.exists():
            shutil.copy(src, out_dir / name)

    data = build_data(data_dir, args.max_days)
    (out_dir / "data.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    n_days = len(data["days"])
    n_rows = sum(d["count"] for d in data["days"])
    print(f"built {out_dir}/  (days={n_days}, rows={n_rows})")


if __name__ == "__main__":
    main()
