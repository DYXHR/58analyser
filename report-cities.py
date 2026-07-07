#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鱼泡网 · 产线工人时薪多城市对比报告生成器（Python 版）

读取 scrape-yupao-data 下的批量抓取 JSON，过滤出指定城市（默认深圳、南京、
西安、河源、长沙）的岗位，将杂乱的区名归一化为标准行政区，生成一份多城市
对比 HTML 报告：顶部五城市总览 + 逐城市标签页（时薪分布直方图 / 各行政区 /
工种 / 薪资类型 / 福利与结算方式 / 岗位明细）。

仅依赖 Python 标准库。

用法:
  python report-cities.py                                    # 默认 5 城市
  python report-cities.py -c 深圳,南京,西安,河源,长沙
  python report-cities.py -c 深圳                            # 单城市（无标签页）
  python report-cities.py -i scrape-yupao-data/wages-batch-2026-07-05.json
"""

import argparse
import json
import math
import re
import sys
from datetime import date, datetime
from pathlib import Path

# Windows 控制台默认 GBK 编码，会让 ✓ 等字符崩溃、中文显示乱码。
# 强制 stdout/stderr 用 UTF-8 输出（Python 3.7+）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "scrape-yupao-data"

DEFAULT_CITIES = ["深圳", "南京", "西安", "河源", "长沙"]

# ============================================================
# 各城市行政区表（用于区名归一化）
# Yupao 的 district 字段有时是「宝安区」，有时带片区「宝安区 福永」，
# 有时是别名「南山中心区」「葵涌」。先匹配标准区名，再匹配别名，
# 最后兜底取首段（以 区/县/市 结尾）。
# ============================================================
CITY_DISTRICTS = {
    "深圳": ["福田区", "罗湖区", "南山区", "盐田区", "宝安区",
             "龙岗区", "龙华区", "坪山区", "光明区", "大鹏新区"],
    "南京": ["玄武区", "秦淮区", "建邺区", "鼓楼区", "浦口区",
             "栖霞区", "雨花台区", "江宁区", "六合区", "溧水区",
             "高淳区", "江北新区"],
    "西安": ["新城区", "碑林区", "莲湖区", "灞桥区", "未央区",
             "雁塔区", "阎良区", "临潼区", "长安区", "高陵区",
             "鄠邑区", "蓝田县", "周至县", "西咸新区"],
    "河源": ["源城区", "紫金县", "龙川县", "连平县", "和平县", "东源县", "江东新区"],
    "长沙": ["芙蓉区", "天心区", "岳麓区", "开福区", "雨花区",
             "望城区", "长沙县", "浏阳市", "宁乡市"],
}

# 别名 → 标准区（仅深圳区名较杂需要别名；其余城市区名规范）
CITY_ALIASES = {
    "深圳": [
        ("光明新区", "光明区"),
        ("龙岗中心城", "龙岗区"),
        ("南山中心区", "南山区"),
        ("宝安中心区", "宝安区"),
        ("坪山新区", "坪山区"),
        ("龙华新区", "龙华区"),
        ("葵涌", "大鹏新区"),
        ("大鹏", "大鹏新区"),
        ("盐田港", "盐田区"),
    ],
}


def resolve_district(job, city):
    text = f"{job.get('district') or ''} {job.get('fullLocation') or ''}"
    for d in CITY_DISTRICTS.get(city, []):
        if d in text:
            return d
    for alias, real in CITY_ALIASES.get(city, []):
        if alias in text:
            return real
    # 兜底：首段以 区/县/市 结尾则直接采用
    parts = [p for p in (job.get("district") or "").split() if p]
    if parts and re.search(r"[区县市]$", parts[0]):
        return parts[0]
    return "其他/未知"


def resolve_area(job):
    """片区/街道（区名之后的补充信息，仅用于展示）"""
    parts = [p for p in (job.get("district") or "").split() if p]
    if len(parts) > 1:
        return " ".join(parts[1:])
    return ""


# ============================================================
# 工具函数
# ============================================================
def wage_mid(job):
    hw = job.get("hourlyWage") or {}
    mn = hw.get("min")
    mx = hw.get("max")
    if mn is not None and mx is not None:
        return (mn + mx) / 2
    if mn is not None:
        return mn
    if mx is not None:
        return mx
    return None


def fmt(v, suffix=" 元/时"):
    if v is None:
        return "-"
    return f"{v:.1f}{suffix}"


def escape_html(text):
    if text is None:
        return ""
    s = str(text)
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def percentile(sorted_list, p):
    if not sorted_list:
        return None
    idx = (len(sorted_list) - 1) * p
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return sorted_list[lo]
    return sorted_list[lo] + (sorted_list[hi] - sorted_list[lo]) * (idx - lo)


# ============================================================
# 统计
# ============================================================
def compute_overall_stats(jobs):
    mids = sorted(m for m in (wage_mid(j) for j in jobs) if m is not None)
    if not mids:
        return {"count": 0, "mean": None, "median": None, "min": None,
                "max": None, "p10": None, "p25": None, "p75": None, "p90": None}
    total = sum(mids)
    return {
        "count": len(mids),
        "mean": total / len(mids),
        "median": percentile(mids, 0.5),
        "min": mids[0],
        "max": mids[-1],
        "p10": percentile(mids, 0.1),
        "p25": percentile(mids, 0.25),
        "p75": percentile(mids, 0.75),
        "p90": percentile(mids, 0.9),
    }


def group_stats(jobs, key_fn):
    order = []
    bucket = {}
    for job in jobs:
        key = key_fn(job) or "未知"
        if key not in bucket:
            bucket[key] = {"key": key, "wages": [], "count": 0}
            order.append(key)
        e = bucket[key]
        e["count"] += 1
        m = wage_mid(job)
        if m is not None:
            e["wages"].append(m)
    result = []
    for key in order:
        e = bucket[key]
        wages = sorted(e["wages"])
        result.append({
            "key": e["key"],
            "count": e["count"],
            "valid": len(wages),
            "mean": (sum(wages) / len(wages)) if wages else None,
            "median": percentile(wages, 0.5) if wages else None,
            "min": wages[0] if wages else None,
            "max": wages[-1] if wages else None,
        })
    return result


BUCKETS = [
    {"label": "<20", "lo": 0, "hi": 20},
    {"label": "20-25", "lo": 20, "hi": 25},
    {"label": "25-30", "lo": 25, "hi": 30},
    {"label": "30-35", "lo": 30, "hi": 35},
    {"label": "35-40", "lo": 35, "hi": 40},
    {"label": "40-50", "lo": 40, "hi": 50},
    {"label": "50+", "lo": 50, "hi": math.inf},
]


def histogram(jobs):
    mids = [m for m in (wage_mid(j) for j in jobs) if m is not None]
    total = len(mids) or 1
    out = []
    for b in BUCKETS:
        count = sum(1 for w in mids if b["lo"] <= w < b["hi"])
        out.append({**b, "count": count, "pct": count / total * 100})
    return out


WELFARE = [
    {"key": "包吃", "tags": ["包吃"]},
    {"key": "包住", "tags": ["包住"]},
    {"key": "餐补", "tags": ["餐补"]},
    {"key": "社保/保险", "tags": ["社保", "保险", "五险", "五险一金"]},
    {"key": "五险一金", "tags": ["五险一金"]},
    {"key": "加班补贴", "tags": ["加班补贴"]},
    {"key": "夜班补贴", "tags": ["夜班补贴"]},
    {"key": "高温补贴", "tags": ["高温补贴"]},
    {"key": "交通补助", "tags": ["交通补助"]},
    {"key": "免费培训", "tags": ["免费培训"]},
    {"key": "长白班", "tags": ["长白班"]},
    {"key": "坐班", "tags": ["坐班"]},
]

SETTLEMENTS = ["月结", "日结", "周结", "完工结算", "现结", "小时结"]

TYPE_LABEL = {
    "monthly": "月薪",
    "daily": "日薪",
    "hourly": "时薪",
    "negotiable": "面议",
    "unknown": "未识别",
}


def tag_stats(jobs, groups, total):
    out = []
    for g in groups:
        tags = g.get("tags") or [g["key"]]
        count = sum(1 for j in jobs if any(t in (j.get("tags") or []) for t in tags))
        out.append({"key": g["key"], "count": count, "pct": count / (total or 1) * 100})
    return out


# ============================================================
# HTML 片段渲染
# ============================================================
def render_stat_cards(o, jobs_len, national_mean):
    return f"""
      <div class="stat-card"><div class="stat-label">有效样本</div><div class="stat-value">{o['count']}</div><div class="stat-sub">共 {jobs_len} 条岗位</div></div>
      <div class="stat-card"><div class="stat-label">时薪中位数</div><div class="stat-value">{fmt(o['median'])}</div><div class="stat-sub">50% 分位</div></div>
      <div class="stat-card"><div class="stat-label">时薪均值</div><div class="stat-value">{fmt(o['mean'])}</div><div class="stat-sub">全国均值 {fmt(national_mean, '')}</div></div>
      <div class="stat-card"><div class="stat-label">主要区间</div><div class="stat-value" style="font-size:20px">{fmt(o['p25'], '')} ~ {fmt(o['p75'], '')}</div><div class="stat-sub">P25 ~ P75（中间 50%）</div></div>
      <div class="stat-card"><div class="stat-label">最低时薪</div><div class="stat-value low">{fmt(o['min'])}</div><div class="stat-sub">P10: {fmt(o['p10'], '')}</div></div>
      <div class="stat-card"><div class="stat-label">最高时薪</div><div class="stat-value high">{fmt(o['max'])}</div><div class="stat-sub">P90: {fmt(o['p90'], '')}</div></div>"""


def render_hist(hist):
    max_count = max([h["count"] for h in hist] + [1])
    cols = []
    for h in hist:
        height = h["count"] / max_count * 100
        cols.append(
            f"""
        <div class="hist-col">
          <div class="hist-count">{h['count']}</div>
          <div class="hist-bar" style="height:{height:.2f}%"></div>
          <div class="hist-label">{escape_html(h['label'])}</div>
          <div class="hist-pct">{h['pct']:.0f}%</div>
        </div>"""
        )
    return "".join(cols)


def _or_dash(v, fmt_str="{:.1f}"):
    return fmt_str.format(v) if v is not None else "-"


def render_district_rows(district_stats, max_district_wage):
    rows = []
    for d in district_stats:
        pct = (d["mean"] / max_district_wage * 100) if d["mean"] else 0
        rng = f"{d['min']:.1f}~{d['max']:.1f}" if d["min"] is not None and d["max"] is not None else "-"
        rows.append(
            f"""
        <tr>
          <td class="city-name">{escape_html(d['key'])}</td>
          <td>{d['count']}</td>
          <td>{d['valid']}</td>
          <td class="wage-cell">{_or_dash(d['mean'])}</td>
          <td>{_or_dash(d['median'])}</td>
          <td>{rng}</td>
          <td class="bar-cell"><div class="bar" style="width:{pct:.2f}%"></div></td>
        </tr>"""
        )
    return "".join(rows)


def render_kw_rows(keyword_stats, max_kw_count):
    rows = []
    for k in keyword_stats:
        pct = (k["count"] / max_kw_count * 100) if max_kw_count else 0
        rows.append(
            f"""
        <tr>
          <td>{escape_html(k['key'])}</td>
          <td>{k['count']}</td>
          <td class="wage-cell">{_or_dash(k['mean'])}</td>
          <td>{_or_dash(k['median'])}</td>
          <td class="bar-cell"><div class="bar kw" style="width:{pct:.2f}%"></div></td>
        </tr>"""
        )
    return "".join(rows)


def render_type_rows(type_stats, jobs_len, max_type_count):
    rows = []
    for t in type_stats:
        pct = (t["count"] / max_type_count * 100) if max_type_count else 0
        ratio = f"{t['count'] / jobs_len * 100:.0f}%" if jobs_len else "-"
        rows.append(
            f"""
        <tr>
          <td>{escape_html(t['key'])}</td>
          <td>{t['count']}</td>
          <td>{ratio}</td>
          <td class="wage-cell">{_or_dash(t['mean'])}</td>
          <td class="bar-cell"><div class="bar type" style="width:{pct:.2f}%"></div></td>
        </tr>"""
        )
    return "".join(rows)


def render_bars(items, fill_class=""):
    out = []
    for w in items:
        cls = "welfare-fill"
        if fill_class:
            cls += " " + fill_class
        out.append(
            f"""
      <div class="welfare-item">
        <div class="welfare-head"><span class="welfare-name">{escape_html(w['key'])}</span><span class="welfare-pct">{w['pct']:.0f}% <em>({w['count']})</em></span></div>
        <div class="welfare-track"><div class="{cls}" style="width:{w['pct']:.2f}%"></div></div>
      </div>"""
        )
    return "".join(out)


def render_table_rows(jobs):
    rows = []
    for i, job in enumerate(jobs):
        wm = wage_mid(job)
        sort_val = wm if wm is not None else -1
        hw = job.get("hourlyWage") or {}
        mn = hw.get("min")
        mx = hw.get("max")
        if mn is not None and mx is not None and mn != mx:
            hourly_str = f"{mn:.1f}-{mx:.1f} 元/时"
        elif mn is not None or mx is not None:
            val = mn if mn is not None else mx
            hourly_str = f"{val:.1f} 元/时"
        else:
            hourly_str = "-"

        tags = job.get("tags") or []
        tags_str = "".join(f'<span class="tag">{escape_html(t)}</span>' for t in tags[:5])
        company = job.get("company") or ""
        company_url = job.get("companyUrl") or ""
        company_link = (
            f'<a href="{escape_html(company_url)}" target="_blank">{escape_html(company)}</a>'
            if company_url else escape_html(company)
        )

        district = job.get("_district", "")
        area = job.get("_area", "")
        district_cell = escape_html(district) + (f" · {escape_html(area)}" if area else "")
        type_label = TYPE_LABEL.get((job.get("salaryParsed") or {}).get("type"), "-")

        rows.append(
            f"""
        <tr data-district="{escape_html(district)}" data-sort-idx="{i}">
          <td>{escape_html(job.get('title') or '')}</td>
          <td>{company_link}</td>
          <td>{district_cell}</td>
          <td>{escape_html(type_label)}</td>
          <td>{escape_html(job.get('salaryRaw') or '')}</td>
          <td data-sort-num="{sort_val}">{escape_html(hourly_str)}</td>
          <td>{escape_html(job.get('searchKeyword') or '')}</td>
          <td>{escape_html(job.get('date') or '')}</td>
          <td>{tags_str}</td>
        </tr>"""
        )
    return "".join(rows)


def render_filter_options(district_stats):
    opts = ["全部"] + [d["key"] for d in district_stats]
    return "".join(f'<option value="{escape_html(d)}">{escape_html(d)}</option>' for d in opts)


# ============================================================
# 单个城市详情面板
# ============================================================
def render_city_section(idx, city, jobs, overall, national_mean):
    district_stats = sorted(
        group_stats(jobs, lambda j: j.get("_district", "未知")),
        key=lambda d: (d["mean"] or 0), reverse=True,
    )
    keyword_stats = sorted(
        group_stats(jobs, lambda j: j.get("searchKeyword") or "未知"),
        key=lambda k: k["count"], reverse=True,
    )
    type_stats = sorted(
        group_stats(jobs, lambda j: TYPE_LABEL.get((j.get("salaryParsed") or {}).get("type"), "未识别")),
        key=lambda t: t["count"], reverse=True,
    )
    hist = histogram(jobs)
    welfare = sorted(tag_stats(jobs, WELFARE, len(jobs)), key=lambda w: w["pct"], reverse=True)
    settlement = [s for s in tag_stats(jobs, [{"key": s, "tags": [s]} for s in SETTLEMENTS], len(jobs))
                  if s["count"] > 0]

    max_district_wage = max([d["mean"] or 0 for d in district_stats] + [1])
    max_kw_count = max([k["count"] for k in keyword_stats] + [1])
    max_type_count = max([t["count"] for t in type_stats] + [1])

    stat_cards = render_stat_cards(overall, len(jobs), national_mean)
    hist_bars = render_hist(hist)
    district_rows = render_district_rows(district_stats, max_district_wage)
    kw_rows = render_kw_rows(keyword_stats, max_kw_count)
    type_rows = render_type_rows(type_stats, len(jobs), max_type_count)
    welfare_bars = render_bars(welfare)
    settle_bars = render_bars(settlement, "settle") or '<div style="color:#999;font-size:13px">无结算方式标签</div>'
    table_rows = render_table_rows(jobs)
    filter_options = render_filter_options(district_stats)

    return f"""
        <div class="stats-grid">{stat_cards}</div>

        <div class="section">
          <div class="section-title">{escape_html(city)}时薪分布<span class="hint">按换算后的时薪中点分桶（元/时）</span></div>
          <div class="hist-chart">{hist_bars}</div>
        </div>

        <div class="section">
          <div class="section-title">{escape_html(city)}各行政区时薪对比<span class="hint">区名已归一化</span></div>
          <div class="table-wrapper">
            <table>
              <thead><tr><th>行政区</th><th>岗位数</th><th>有效</th><th>均时薪</th><th>中位数</th><th>范围</th><th>占比</th></tr></thead>
              <tbody>{district_rows}</tbody>
            </table>
          </div>
        </div>

        <div class="dual-grid">
          <div class="section">
            <div class="section-title">各工种（来源关键词）时薪</div>
            <div class="table-wrapper"><table>
              <thead><tr><th>工种</th><th>岗位数</th><th>均时薪</th><th>中位数</th><th>占比</th></tr></thead>
              <tbody>{kw_rows}</tbody>
            </table></div>
          </div>
          <div class="section">
            <div class="section-title">薪资类型构成</div>
            <div class="table-wrapper"><table>
              <thead><tr><th>类型</th><th>数量</th><th>占比</th><th>均时薪</th><th>分布</th></tr></thead>
              <tbody>{type_rows}</tbody>
            </table></div>
          </div>
        </div>

        <div class="welfare-grid">
          <div class="section">
            <div class="section-title">福利与补贴占比</div>
            <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">{welfare_bars}</div>
          </div>
          <div class="section">
            <div class="section-title">结算方式</div>
            <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">{settle_bars}</div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">{escape_html(city)}岗位明细<span class="hint">点击列头排序 · 可按行政区筛选</span></div>
          <div class="filter-bar">
            <label>行政区筛选:</label>
            <select id="districtFilter-{idx}">{filter_options}</select>
            <span id="filterCount-{idx}">共 {len(jobs)} 条</span>
          </div>
          <div class="table-wrapper table-scroll">
            <table class="jobs-table" id="jobsTable-{idx}" data-idx="{idx}">
              <thead><tr>
                <th data-col="0" data-type="text">岗位标题</th>
                <th data-col="1" data-type="text">公司</th>
                <th data-col="2" data-type="text">行政区</th>
                <th data-col="3" data-type="text">薪资类型</th>
                <th data-col="4" data-type="text">薪资原文</th>
                <th data-col="5" data-type="num">换算时薪</th>
                <th data-col="6" data-type="text">工种</th>
                <th data-col="7" data-type="date">发布时间</th>
                <th data-col="8" data-type="text">标签</th>
              </tr></thead>
              <tbody>{table_rows}</tbody>
            </table>
          </div>
        </div>"""


# ============================================================
# 城市对比总览
# ============================================================
def render_overview(cities_data, national_mean):
    max_mean = max([cd["overall"]["mean"] or 0 for cd in cities_data] + [1])
    rows = []
    for cd in sorted(cities_data, key=lambda x: (x["overall"]["mean"] or 0), reverse=True):
        o = cd["overall"]
        p2575 = f"{_or_dash(o['p25'])} ~ {_or_dash(o['p75'])}"
        pct = (o["mean"] / max_mean * 100) if o["mean"] else 0
        rows.append(
            f"""
          <tr>
            <td class="city-name">{escape_html(cd['city'])}</td>
            <td>{len(cd['jobs'])}</td>
            <td>{o['count']}</td>
            <td class="wage-cell">{_or_dash(o['mean'])}</td>
            <td>{_or_dash(o['median'])}</td>
            <td>{p2575}</td>
            <td>{_or_dash(o['min'])}</td>
            <td>{_or_dash(o['max'])}</td>
            <td class="bar-cell"><div class="bar" style="width:{pct:.2f}%"></div></td>
          </tr>"""
        )
    natl = _or_dash(national_mean)
    return f"""
      <div class="section">
        <div class="section-title">{len(cities_data)} 城市时薪对比<span class="hint">按平均时薪降序 · 全国均值 {natl} 元/时</span></div>
        <div class="table-wrapper"><table>
          <thead><tr><th>城市</th><th>岗位数</th><th>有效</th><th>均时薪</th><th>中位数</th><th>P25~P75</th><th>最低</th><th>最高</th><th>对比</th></tr></thead>
          <tbody>{''.join(rows)}</tbody>
        </table></div>
      </div>"""


# ============================================================
# HTML 组装
# ============================================================
CSS = """
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #333; line-height: 1.6; }
  .header { background: linear-gradient(135deg, #0d47a1, #1a73e8); color: #fff; padding: 36px 24px; text-align: center; }
  .header h1 { font-size: 26px; margin-bottom: 10px; }
  .header .meta { font-size: 14px; opacity: 0.9; }
  .header .meta span { margin: 0 14px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .stat-card { background: #fff; border-radius: 12px; padding: 18px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .stat-label { font-size: 13px; color: #888; margin-bottom: 8px; }
  .stat-value { font-size: 26px; font-weight: 700; color: #1a73e8; }
  .stat-value.low { color: #e65100; }
  .stat-value.high { color: #2e7d32; }
  .stat-sub { font-size: 12px; color: #aaa; margin-top: 4px; }

  .section { margin-bottom: 28px; }
  .section-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; padding-left: 12px; border-left: 4px solid #1a73e8; }
  .section-title .hint { font-size: 12px; color: #999; font-weight: 400; margin-left: 8px; }

  .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; position: sticky; top: 0; background: #f5f7fa; padding: 10px 0; z-index: 10; }
  .tab-btn { padding: 8px 20px; border: 1px solid #d0d7e2; background: #fff; border-radius: 20px; cursor: pointer; font-size: 14px; color: #555; transition: all 0.15s; }
  .tab-btn:hover { border-color: #1a73e8; color: #1a73e8; }
  .tab-btn.active { background: #1a73e8; color: #fff; border-color: #1a73e8; }
  .city-panel { }

  .hist-chart { display: flex; align-items: flex-end; gap: 12px; background: #fff; border-radius: 12px; padding: 24px 20px 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); height: 280px; }
  .hist-col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 0; }
  .hist-count { font-size: 13px; font-weight: 600; color: #1a73e8; margin-bottom: 4px; }
  .hist-bar { width: 70%; background: linear-gradient(180deg, #4fc3f7, #1a73e8); border-radius: 6px 6px 0 0; min-height: 2px; transition: height 0.3s; }
  .hist-label { font-size: 12px; color: #666; margin-top: 8px; white-space: nowrap; }
  .hist-pct { font-size: 11px; color: #aaa; }

  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); font-size: 13px; }
  thead { background: #f0f4ff; }
  th { padding: 12px 14px; text-align: left; font-weight: 600; color: #555; cursor: pointer; user-select: none; white-space: nowrap; transition: background 0.15s; }
  th:hover { background: #e3eaff; }
  th.sort-asc::after { content: " ▲"; font-size: 11px; color: #1a73e8; }
  th.sort-desc::after { content: " ▼"; font-size: 11px; color: #1a73e8; }
  td { padding: 9px 14px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
  tbody tr:hover { background: #f8faff; }
  tbody tr:nth-child(even) { background: #fcfcfe; }
  tbody tr:nth-child(even):hover { background: #f8faff; }
  .city-name { font-weight: 600; }
  .wage-cell { font-weight: 600; color: #1a73e8; white-space: nowrap; }
  .bar-cell { width: 160px; }
  .bar { height: 18px; background: linear-gradient(90deg, #4fc3f7, #1a73e8); border-radius: 4px; min-width: 2px; }
  .bar.kw { background: linear-gradient(90deg, #ffb74d, #e65100); }
  .bar.type { background: linear-gradient(90deg, #81c784, #2e7d32); }
  .tag { display: inline-block; background: #e8f0fe; color: #1a73e8; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin: 1px; white-space: nowrap; }
  td a { color: #1a73e8; text-decoration: none; }
  td a:hover { text-decoration: underline; }
  .table-wrapper { overflow-x: auto; }
  .table-scroll { max-height: 720px; overflow-y: auto; }

  .dual-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 24px; }
  @media (max-width: 900px) { .dual-grid { grid-template-columns: 1fr; } }

  .welfare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 768px) { .welfare-grid { grid-template-columns: 1fr; } }
  .welfare-item { margin-bottom: 12px; }
  .welfare-head { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
  .welfare-name { font-weight: 600; color: #444; }
  .welfare-pct { color: #1a73e8; font-weight: 600; }
  .welfare-pct em { color: #aaa; font-style: normal; font-weight: 400; }
  .welfare-track { background: #eef2f7; border-radius: 4px; height: 12px; overflow: hidden; }
  .welfare-fill { height: 100%; background: linear-gradient(90deg, #4fc3f7, #1a73e8); border-radius: 4px; }
  .welfare-fill.settle { background: linear-gradient(90deg, #ffb74d, #e65100); }

  .filter-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; font-size: 13px; color: #666; }
  .filter-bar select { padding: 6px 10px; border: 1px solid #d0d7e2; border-radius: 6px; font-size: 13px; background: #fff; }
  .footer { text-align: center; padding: 24px; color: #aaa; font-size: 13px; }
"""

JS = """
  // 标签切换（多城市时存在）
  (function() {
    var tabBtns = document.querySelectorAll('.tab-btn');
    if (!tabBtns.length) return;
    tabBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        tabBtns.forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.city-panel').forEach(function(p) { p.style.display = 'none'; });
        btn.classList.add('active');
        var panel = document.getElementById('panel-' + btn.dataset.tab);
        if (panel) panel.style.display = '';
      });
    });
  })();

  // 每个岗位明细表：列头排序 + 行政区筛选
  (function() {
    document.querySelectorAll('.jobs-table').forEach(function(table) {
      var idx = table.dataset.idx;
      var filter = document.getElementById('districtFilter-' + idx);
      var countEl = document.getElementById('filterCount-' + idx);
      var tbody = table.querySelector('tbody');
      var allRows = Array.from(tbody.querySelectorAll('tr'));

      if (filter) {
        filter.addEventListener('change', function() {
          var v = filter.value;
          var shown = 0;
          allRows.forEach(function(r) {
            var show = v === '全部' || r.dataset.district === v;
            r.style.display = show ? '' : 'none';
            if (show) shown++;
          });
          if (countEl) countEl.textContent = '共 ' + shown + ' 条';
        });
      }

      table.querySelectorAll('th').forEach(function(th) {
        th.addEventListener('click', function() {
          var c = parseInt(th.dataset.col), t = th.dataset.type;
          var sD = th.dataset.dir === 'asc' ? -1 : 1;
          table.querySelectorAll('th').forEach(function(h) { h.classList.remove('sort-asc','sort-desc'); h.dataset.dir = ''; });
          th.dataset.dir = (sD === 1) ? 'asc' : 'desc';
          th.classList.add(sD === 1 ? 'sort-asc' : 'sort-desc');
          var rows = allRows.filter(function(r) { return r.style.display !== 'none'; });
          rows.sort(function(a, b) {
            var ca = a.children[c], cb = b.children[c], va, vb;
            if (t === 'num') { va = parseFloat(ca.dataset.sortNum) || -1; vb = parseFloat(cb.dataset.sortNum) || -1; }
            else { va = ca.textContent.trim(); vb = cb.textContent.trim(); }
            if (va < vb) return -1 * sD;
            if (va > vb) return 1 * sD;
            return 0;
          });
          rows.forEach(function(r) { tbody.appendChild(r); });
        });
      });
    });
  })();
"""


def generate_html(cities_data, scrape_date, national_mean):
    date_str = date.today().isoformat()
    now_str = datetime.now().strftime("%Y/%m/%d %H:%M:%S")
    total_jobs = sum(len(cd["jobs"]) for cd in cities_data)
    total_valid = sum(cd["overall"]["count"] for cd in cities_data)
    multi = len(cities_data) > 1

    if multi:
        title = f"产线工人时薪多城市对比报告 · {len(cities_data)}城市"
        meta_cities = " · ".join(cd["city"] for cd in cities_data)
        overview = render_overview(cities_data, national_mean)
        tabs_nav = '<div class="tabs">' + "".join(
            f'<button class="tab-btn{" active" if i == 0 else ""}" data-tab="{i}">{escape_html(cd["city"])}</button>'
            for i, cd in enumerate(cities_data)
        ) + "</div>"
        panels = ""
        for i, cd in enumerate(cities_data):
            style = "" if i == 0 else ' style="display:none"'
            panels += (
                f'<div class="city-panel" id="panel-{i}"{style}>'
                f'{render_city_section(i, cd["city"], cd["jobs"], cd["overall"], national_mean)}</div>'
            )
        body = f"""
  <div class="container">
    {overview}
    {tabs_nav}
    {panels}
  </div>"""
        meta_line = (
            f'<span>城市: {escape_html(meta_cities)}</span>'
            f'<span>样本: {total_jobs} 条（有效时薪 {total_valid} 条）</span>'
        )
    else:
        cd = cities_data[0]
        title = f"{cd['city']}产线工人时薪报告"
        body = f"""
  <div class="container">
    {render_city_section(0, cd['city'], cd['jobs'], cd['overall'], national_mean)}
  </div>"""
        meta_line = (
            f'<span>城市: {escape_html(cd["city"])}</span>'
            f'<span>样本: {len(cd["jobs"])} 条（有效时薪 {cd["overall"]["count"]} 条）</span>'
        )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{title} · 鱼泡网 · {date_str}</title>
<style>{CSS}</style>
</head>
<body>
  <div class="header">
    <h1>{title}</h1>
    <div class="meta">
      <span>数据来源: 鱼泡网 m.yupao.com</span>
      <span>抓取日期: {escape_html(scrape_date)}</span>
      {meta_line}
      <span>生成: {date_str}</span>
    </div>
  </div>
{body}
  <div class="footer">
    数据来源: 鱼泡网 m.yupao.com · 换算规则: 日薪÷10、月薪÷260 · 生成时间: {now_str}
  </div>
<script>{JS}</script>
</body>
</html>"""


# ============================================================
# 自动查找最新的批量 JSON
# ============================================================
def find_latest_batch(data_dir):
    """自动选取最新的批量 JSON：优先按城市抓取的 wages-cities-batch-*.json，
    否则回退到全国批量 wages-batch-*.json。"""
    if not data_dir.exists():
        return None
    # 同时匹配按城市批量与全国批量，按修改时间取最新
    files = list(data_dir.glob("wages-cities-batch-*.json")) + list(data_dir.glob("wages-batch-*.json"))
    if not files:
        return None
    return max(files, key=lambda f: f.stat().st_mtime)


# ============================================================
# 主函数
# ============================================================
def main():
    parser = argparse.ArgumentParser(description="生成鱼泡网产线工人时薪多城市对比报告")
    parser.add_argument("-i", "--input", help="指定输入的 wages-batch-*.json（默认自动选取最新）")
    parser.add_argument("-c", "--cities", default=",".join(DEFAULT_CITIES),
                        help="逗号分隔的城市列表（默认: 深圳,南京,西安,河源,长沙）")
    args = parser.parse_args()

    cities = [c.strip() for c in args.cities.split(",") if c.strip()]
    if not cities:
        print("错误: 未指定城市。")
        raise SystemExit(1)

    input_file = Path(args.input) if args.input else find_latest_batch(DATA_DIR)
    if not input_file or not input_file.exists():
        print("错误: 未找到批量 JSON。请先运行 `npm run batch`，或用 -i 指定文件。")
        raise SystemExit(1)

    print(f"读取数据: {input_file}")
    with open(input_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    all_jobs = data.get("jobs", [])
    scrape_date = data.get("scrapeDate", "未知")

    # 全国均值（作为对比基准）
    national_mids = [m for m in (wage_mid(j) for j in all_jobs) if m is not None]
    national_mean = (sum(national_mids) / len(national_mids)) if national_mids else None

    # 逐城市过滤 + 归一化 + 统计
    cities_data = []
    print("========================================")
    print(f"  产线工人时薪多城市分析（{len(cities)} 城市）")
    print("========================================")
    print(f"  数据抓取日期: {scrape_date}")
    print(f"  全国岗位数: {len(all_jobs)}（均值 {fmt(national_mean, '')}）")
    print("----------------------------------------")
    for city in cities:
        city_lower = city.lower()
        jobs = [j for j in all_jobs
                if ((j.get("city") or "").lower().find(city_lower) >= 0
                    or (j.get("fullLocation") or "").lower().find(city_lower) >= 0)]
        if not jobs:
            print(f"  ⚠ {city}: 未找到岗位，跳过")
            continue
        for j in jobs:
            j["_district"] = resolve_district(j, city)
            j["_area"] = resolve_area(j)
        overall = compute_overall_stats(jobs)
        cities_data.append({"city": city, "jobs": jobs, "overall": overall})
        print(f"  {city.ljust(4)}: {len(jobs)} 条（有效 {overall['count']}）"
              f"  中位 {fmt(overall['median'], '')}  均值 {fmt(overall['mean'], '')} 元/时")
    print("========================================\n")

    if not cities_data:
        print("错误: 所有城市均无数据。")
        raise SystemExit(1)

    html = generate_html(cities_data, scrape_date, national_mean)
    date_str = date.today().isoformat()
    if len(cities_data) == 1:
        safe_city = re.sub(r"[^A-Za-z0-9一-龥]", "_", cities_data[0]["city"])
        out_file = DATA_DIR / f"report-{safe_city}-{date_str}.html"
    else:
        out_file = DATA_DIR / f"report-cities-{date_str}.html"
    out_file.parent.mkdir(parents=True, exist_ok=True)
    out_file.write_text(html, encoding="utf-8")
    print(f"[OK] 报告已生成: {out_file}")


if __name__ == "__main__":
    main()
