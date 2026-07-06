/**
 * 鱼泡网 · 深圳产线工人时薪专题报告生成器
 *
 * 读取 scrape-yupao-data 下的批量抓取 JSON，过滤出深圳岗位，将杂乱的区名
 * （如「宝安区」「宝安区 福永」「南山中心区」「葵涌」）归一化为标准行政区，
 * 然后从多个维度（行政区 / 工种 / 薪资类型 / 福利标签 / 结算方式 / 时薪分布）
 * 统计分析，输出一份深圳专用的 HTML 可视化报告。
 *
 * 用法:
 *   node report-shenzhen.js                          # 自动选取最新的 wages-batch-*.json
 *   node report-shenzhen.js --input scrape-yupao-data/wages-batch-2026-07-05.json
 *   node report-shenzhen.js --city 深圳              # 显式指定城市（默认深圳）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 命令行参数
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const config = { input: null, city: '深圳' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--input' || a === '-i') config.input = args[++i];
    else if (a === '--city' || a === '-c') config.city = args[++i];
    else if (a === '--help' || a === '-h') {
      console.log(`用法: node report-shenzhen.js [--input <批量json>] [--city <城市>]
  --input, -i  指定输入的 wages-batch-*.json（默认自动选取最新）
  --city,  -c  目标城市（默认: 深圳）`);
      process.exit(0);
    }
  }
  return config;
}

// ============================================================
// 自动查找最新的批量 JSON
// ============================================================
function findLatestBatch(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^wages-batch-.*\.json$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? path.join(dir, files[0].f) : null;
}

// ============================================================
// 深圳行政区归一化
// Yupao 的 district 字段非常杂乱：有时是「宝安区」，有时带片区「宝安区 福永」，
// 有时是别名「南山中心区」「光明新区」「葵涌」。这里统一映射到 10 个标准区。
// ============================================================
const SZ_DISTRICTS = [
  '福田区', '罗湖区', '南山区', '盐田区', '宝安区',
  '龙岗区', '龙华区', '坪山区', '光明区', '大鹏新区',
];
// 别名 → 标准区（需在标准区名匹配失败后再匹配，故单独列出）
const DISTRICT_ALIASES = [
  ['光明新区', '光明区'],
  ['龙岗中心城', '龙岗区'],
  ['南山中心区', '南山区'],
  ['宝安中心区', '宝安区'],
  ['坪山新区', '坪山区'],
  ['龙华新区', '龙华区'],
  ['葵涌', '大鹏新区'],
  ['大鹏', '大鹏新区'],
  ['盐田港', '盐田区'],
];

function resolveDistrict(job) {
  const text = `${job.district || ''} ${job.fullLocation || ''}`;
  for (const d of SZ_DISTRICTS) if (text.includes(d)) return d;
  for (const [alias, real] of DISTRICT_ALIASES) if (text.includes(alias)) return real;
  return '其他/未知';
}

// 片区/街道（区名之后的补充信息，仅用于展示）
function resolveArea(job) {
  const parts = (job.district || '').split(/\s+/).filter(Boolean);
  if (parts.length > 1) return parts.slice(1).join(' ');
  return '';
}

// ============================================================
// 工具函数
// ============================================================
// 取一条岗位的时薪中点（用于统计与排序）
function wageMid(job) {
  const { min, max } = job.hourlyWage || {};
  if (min !== null && max !== null) return (min + max) / 2;
  if (min !== null) return min;
  if (max !== null) return max;
  return null;
}

function fmt(v, suffix = ' 元/时') {
  return v === null || v === undefined ? '-' : v.toFixed(1) + suffix;
}

function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 百分位计算（输入需为升序数组）
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ============================================================
// 统计：整体时薪
// ============================================================
function computeOverallStats(jobs) {
  const mids = jobs.map(wageMid).filter((x) => x !== null).sort((a, b) => a - b);
  if (mids.length === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null, p10: null, p25: null, p75: null, p90: null };
  }
  const sum = mids.reduce((a, b) => a + b, 0);
  return {
    count: mids.length,
    mean: sum / mids.length,
    median: percentile(mids, 0.5),
    min: mids[0],
    max: mids[mids.length - 1],
    p10: percentile(mids, 0.1),
    p25: percentile(mids, 0.25),
    p75: percentile(mids, 0.75),
    p90: percentile(mids, 0.9),
  };
}

// ============================================================
// 统计：分组（通用）
// ============================================================
function groupStats(jobs, keyFn) {
  const map = new Map();
  for (const job of jobs) {
    const key = keyFn(job) || '未知';
    if (!map.has(key)) map.set(key, { key, wages: [], count: 0 });
    const e = map.get(key);
    e.count++;
    const m = wageMid(job);
    if (m !== null) e.wages.push(m);
  }
  const result = [];
  for (const [, e] of map) {
    const wages = e.wages.sort((a, b) => a - b);
    result.push({
      key: e.key,
      count: e.count,
      valid: wages.length,
      mean: wages.length ? wages.reduce((a, b) => a + b, 0) / wages.length : null,
      median: wages.length ? percentile(wages, 0.5) : null,
      min: wages.length ? wages[0] : null,
      max: wages.length ? wages[wages.length - 1] : null,
    });
  }
  return result;
}

// ============================================================
// 时薪分布直方图分桶
// ============================================================
const BUCKETS = [
  { label: '<20', lo: 0, hi: 20 },
  { label: '20-25', lo: 20, hi: 25 },
  { label: '25-30', lo: 25, hi: 30 },
  { label: '30-35', lo: 30, hi: 35 },
  { label: '35-40', lo: 35, hi: 40 },
  { label: '40-50', lo: 40, hi: 50 },
  { label: '50+', lo: 50, hi: Infinity },
];

function histogram(jobs) {
  const mids = jobs.map(wageMid).filter((x) => x !== null);
  const total = mids.length || 1;
  return BUCKETS.map((b) => {
    const count = mids.filter((w) => w >= b.lo && w < b.hi).length;
    return { ...b, count, pct: (count / total) * 100 };
  });
}

// ============================================================
// 福利标签 & 结算方式统计
// ============================================================
const WELFARE = [
  { key: '包吃', tags: ['包吃'] },
  { key: '包住', tags: ['包住'] },
  { key: '餐补', tags: ['餐补'] },
  { key: '社保/保险', tags: ['社保', '保险', '五险', '五险一金'] },
  { key: '五险一金', tags: ['五险一金'] },
  { key: '加班补贴', tags: ['加班补贴'] },
  { key: '夜班补贴', tags: ['夜班补贴'] },
  { key: '高温补贴', tags: ['高温补贴'] },
  { key: '交通补助', tags: ['交通补助'] },
  { key: '免费培训', tags: ['免费培训'] },
  { key: '长白班', tags: ['长白班'] },
  { key: '坐班', tags: ['坐班'] },
];

const SETTLEMENTS = ['月结', '日结', '周结', '完工结算', '现结', '小时结'];

function tagStats(jobs, groups, total) {
  return groups.map((g) => {
    const tags = g.tags || [g.key];
    const count = jobs.filter((j) => (j.tags || []).some((t) => tags.includes(t))).length;
    return { key: g.key, count, pct: (count / (total || 1)) * 100 };
  });
}

// ============================================================
// 薪资类型中文名
// ============================================================
const TYPE_LABEL = {
  monthly: '月薪',
  daily: '日薪',
  hourly: '时薪',
  negotiable: '面议',
  unknown: '未识别',
};

// ============================================================
// HTML 生成
// ============================================================
function generateHTML({ city, scrapeDate, jobs, overall, nationalMean }) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  const districtStats = groupStats(jobs, (j) => j._district).sort((a, b) => (b.mean || 0) - (a.mean || 0));
  const keywordStats = groupStats(jobs, (j) => j.searchKeyword || '未知').sort((a, b) => b.count - a.count);
  const typeStats = groupStats(jobs, (j) => TYPE_LABEL[j.salaryParsed?.type] || '未识别').sort((a, b) => b.count - a.count);
  const hist = histogram(jobs);
  const welfare = tagStats(jobs, WELFARE, jobs.length).sort((a, b) => b.pct - a.pct);
  const settlement = tagStats(jobs, SETTLEMENTS.map((s) => ({ key: s, tags: [s] })), jobs.length).filter((s) => s.count > 0);

  const maxDistrictWage = Math.max(...districtStats.map((d) => d.mean || 0), 1);
  const maxHistCount = Math.max(...hist.map((h) => h.count), 1);
  const maxKwCount = Math.max(...keywordStats.map((k) => k.count), 1);
  const maxTypeCount = Math.max(...typeStats.map((t) => t.count), 1);

  // ---------- 顶部统计卡 ----------
  const o = overall;
  const statCards = `
    <div class="stat-card"><div class="stat-label">有效样本</div><div class="stat-value">${o.count}</div><div class="stat-sub">共 ${jobs.length} 条深圳岗位</div></div>
    <div class="stat-card"><div class="stat-label">时薪中位数</div><div class="stat-value">${fmt(o.median)}</div><div class="stat-sub">50% 分位</div></div>
    <div class="stat-card"><div class="stat-label">时薪均值</div><div class="stat-value">${fmt(o.mean)}</div><div class="stat-sub">全国均值 ${fmt(nationalMean, '')}</div></div>
    <div class="stat-card"><div class="stat-label">主要区间</div><div class="stat-value" style="font-size:20px">${fmt(o.p25, '')} ~ ${fmt(o.p75, '')}</div><div class="stat-sub">P25 ~ P75（中间 50%）</div></div>
    <div class="stat-card"><div class="stat-label">最低时薪</div><div class="stat-value low">${fmt(o.min)}</div><div class="stat-sub">P10: ${fmt(o.p10, '')}</div></div>
    <div class="stat-card"><div class="stat-label">最高时薪</div><div class="stat-value high">${fmt(o.max)}</div><div class="stat-sub">P90: ${fmt(o.p90, '')}</div></div>`;

  // ---------- 直方图 ----------
  const histBars = hist.map((h) => `
    <div class="hist-col">
      <div class="hist-count">${h.count}</div>
      <div class="hist-bar" style="height:${(h.count / maxHistCount) * 100}%"></div>
      <div class="hist-label">${h.label}</div>
      <div class="hist-pct">${h.pct.toFixed(0)}%</div>
    </div>`).join('');

  // ---------- 行政区表格 + 条形 ----------
  const districtRows = districtStats.map((d) => {
    const pct = d.mean ? (d.mean / maxDistrictWage) * 100 : 0;
    return `<tr>
      <td class="city-name">${escapeHtml(d.key)}</td>
      <td>${d.count}</td>
      <td>${d.valid}</td>
      <td class="wage-cell">${d.mean !== null ? d.mean.toFixed(1) : '-'}</td>
      <td>${d.median !== null ? d.median.toFixed(1) : '-'}</td>
      <td>${d.min !== null ? d.min.toFixed(1) : '-'}~${d.max !== null ? d.max.toFixed(1) : '-'}</td>
      <td class="bar-cell"><div class="bar" style="width:${pct}%"></div></td>
    </tr>`;
  }).join('');

  // ---------- 工种表格 ----------
  const kwRows = keywordStats.map((k) => {
    const pct = (k.count / maxKwCount) * 100;
    return `<tr>
      <td>${escapeHtml(k.key)}</td>
      <td>${k.count}</td>
      <td class="wage-cell">${k.mean !== null ? k.mean.toFixed(1) : '-'}</td>
      <td>${k.median !== null ? k.median.toFixed(1) : '-'}</td>
      <td class="bar-cell"><div class="bar kw" style="width:${pct}%"></div></td>
    </tr>`;
  }).join('');

  // ---------- 薪资类型 ----------
  const typeRows = typeStats.map((t) => {
    const pct = (t.count / maxTypeCount) * 100;
    return `<tr>
      <td>${escapeHtml(t.key)}</td>
      <td>${t.count}</td>
      <td>${((t.count / jobs.length) * 100).toFixed(0)}%</td>
      <td class="wage-cell">${t.mean !== null ? t.mean.toFixed(1) : '-'}</td>
      <td class="bar-cell"><div class="bar type" style="width:${pct}%"></div></td>
    </tr>`;
  }).join('');

  // ---------- 福利 ----------
  const welfareBars = welfare.map((w) => `
    <div class="welfare-item">
      <div class="welfare-head"><span class="welfare-name">${escapeHtml(w.key)}</span><span class="welfare-pct">${w.pct.toFixed(0)}% <em>(${w.count})</em></span></div>
      <div class="welfare-track"><div class="welfare-fill" style="width:${w.pct}%"></div></div>
    </div>`).join('');

  // ---------- 结算方式 ----------
  const settleBars = settlement.map((s) => `
    <div class="welfare-item">
      <div class="welfare-head"><span class="welfare-name">${escapeHtml(s.key)}</span><span class="welfare-pct">${s.pct.toFixed(0)}% <em>(${s.count})</em></span></div>
      <div class="welfare-track"><div class="welfare-fill settle" style="width:${s.pct}%"></div></div>
    </div>`).join('');

  // ---------- 岗位明细表 ----------
  const tableRows = jobs.map((job, i) => {
    const sortVal = wageMid(job) ?? -1;
    const { min, max } = job.hourlyWage || {};
    let hourlyStr = '-';
    if (min !== null && max !== null && min !== max) hourlyStr = `${min.toFixed(1)}-${max.toFixed(1)} 元/时`;
    else if (min !== null || max !== null) hourlyStr = `${(min !== null ? min : max).toFixed(1)} 元/时`;
    const tagsStr = (job.tags || []).slice(0, 5).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const companyLink = job.companyUrl
      ? `<a href="${escapeHtml(job.companyUrl)}" target="_blank">${escapeHtml(job.company)}</a>`
      : escapeHtml(job.company);
    return `<tr data-district="${escapeHtml(job._district)}" data-sort-idx="${i}">
      <td>${escapeHtml(job.title)}</td>
      <td>${companyLink}</td>
      <td>${escapeHtml(job._district)}${job._area ? ' · ' + escapeHtml(job._area) : ''}</td>
      <td>${escapeHtml(TYPE_LABEL[job.salaryParsed?.type] || '-')}</td>
      <td>${escapeHtml(job.salaryRaw)}</td>
      <td data-sort-num="${sortVal}">${escapeHtml(hourlyStr)}</td>
      <td>${escapeHtml(job.searchKeyword || '')}</td>
      <td>${escapeHtml(job.date)}</td>
      <td>${tagsStr}</td>
    </tr>`;
  }).join('');

  // 行政区筛选项
  const filterOptions = ['全部', ...districtStats.map((d) => d.key)]
    .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(city)}产线工人时薪报告 · 鱼泡网 · ${dateStr}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #333; line-height: 1.6; }
  .header { background: linear-gradient(135deg, #0d47a1, #1a73e8); color: #fff; padding: 36px 24px; text-align: center; }
  .header h1 { font-size: 26px; margin-bottom: 10px; }
  .header .meta { font-size: 14px; opacity: 0.9; }
  .header .meta span { margin: 0 14px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 14px; margin-bottom: 32px; }
  .stat-card { background: #fff; border-radius: 12px; padding: 18px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .stat-label { font-size: 13px; color: #888; margin-bottom: 8px; }
  .stat-value { font-size: 26px; font-weight: 700; color: #1a73e8; }
  .stat-value.low { color: #e65100; }
  .stat-value.high { color: #2e7d32; }
  .stat-sub { font-size: 12px; color: #aaa; margin-top: 4px; }

  .section { margin-bottom: 32px; }
  .section-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; padding-left: 12px; border-left: 4px solid #1a73e8; }
  .section-title .hint { font-size: 12px; color: #999; font-weight: 400; margin-left: 8px; }

  /* 直方图 */
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
</style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(city)}产线工人时薪数据报告</h1>
    <div class="meta">
      <span>数据来源: 鱼泡网 m.yupao.com</span>
      <span>抓取日期: ${escapeHtml(scrapeDate)}</span>
      <span>样本: ${jobs.length} 条（有效时薪 ${overall.count} 条）</span>
      <span>生成: ${dateStr}</span>
    </div>
  </div>

  <div class="container">
    <div class="stats-grid">${statCards}</div>

    <div class="section">
      <div class="section-title">时薪分布<span class="hint">按换算后的时薪中点分桶（元/时）</span></div>
      <div class="hist-chart">${histBars}</div>
    </div>

    <div class="section">
      <div class="section-title">各行政区时薪对比<span class="hint">区名已从原始杂乱文本归一化</span></div>
      <div class="table-wrapper">
        <table>
          <thead><tr>
            <th>行政区</th><th>岗位数</th><th>有效</th><th>均时薪</th><th>中位数</th><th>范围</th><th>占比</th>
          </tr></thead>
          <tbody>${districtRows}</tbody>
        </table>
      </div>
    </div>

    <div class="dual-grid">
      <div class="section">
        <div class="section-title">各工种（来源关键词）时薪</div>
        <div class="table-wrapper"><table>
          <thead><tr><th>工种</th><th>岗位数</th><th>均时薪</th><th>中位数</th><th>占比</th></tr></thead>
          <tbody>${kwRows}</tbody>
        </table></div>
      </div>
      <div class="section">
        <div class="section-title">薪资类型构成</div>
        <div class="table-wrapper"><table>
          <thead><tr><th>类型</th><th>数量</th><th>占比</th><th>均时薪</th><th>分布</th></tr></thead>
          <tbody>${typeRows}</tbody>
        </table></div>
      </div>
    </div>

    <div class="welfare-grid">
      <div class="section">
        <div class="section-title">福利与补贴占比</div>
        <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">${welfareBars}</div>
      </div>
      <div class="section">
        <div class="section-title">结算方式</div>
        <div style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.06)">${settleBars || '<div style="color:#999;font-size:13px">无结算方式标签</div>'}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">${escapeHtml(city)}岗位明细<span class="hint">点击列头排序 · 可按行政区筛选</span></div>
      <div class="filter-bar">
        <label>行政区筛选:</label>
        <select id="districtFilter">${filterOptions}</select>
        <span id="filterCount">共 ${jobs.length} 条</span>
      </div>
      <div class="table-wrapper table-scroll">
        <table id="jobsTable">
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
          <tbody id="jobsBody">${tableRows}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="footer">
    数据来源: 鱼泡网 m.yupao.com · 换算规则: 日薪÷10、月薪÷260 · 生成时间: ${today.toLocaleString('zh-CN')}
  </div>

<script>
  // 行政区筛选
  (function() {
    var filter = document.getElementById('districtFilter');
    var countEl = document.getElementById('filterCount');
    var allRows = Array.from(document.querySelectorAll('#jobsBody tr'));
    filter.addEventListener('change', function() {
      var v = filter.value;
      var shown = 0;
      allRows.forEach(function(r) {
        var show = v === '全部' || r.dataset.district === v;
        r.style.display = show ? '' : 'none';
        if (show) shown++;
      });
      countEl.textContent = '共 ' + shown + ' 条';
    });
  })();

  // 列排序
  (function() {
    var sC = -1, sD = 1;
    var hs = document.querySelectorAll('#jobsTable th');
    hs.forEach(function(th) {
      th.addEventListener('click', function() {
        var c = parseInt(th.dataset.col), t = th.dataset.type;
        if (sC === c) { sD = -sD; } else { sC = c; sD = 1; }
        hs.forEach(function(h) { h.classList.remove('sort-asc', 'sort-desc'); });
        th.classList.add(sD === 1 ? 'sort-asc' : 'sort-desc');
        var tb = document.getElementById('jobsBody');
        var rows = Array.from(tb.querySelectorAll('tr')).filter(function(r){ return r.style.display !== 'none'; });
        rows.sort(function(a, b) {
          var ca = a.children[c], cb = b.children[c], va, vb;
          if (t === 'num') { va = parseFloat(ca.dataset.sortNum) || -1; vb = parseFloat(cb.dataset.sortNum) || -1; }
          else if (t === 'date') { va = ca.textContent.trim(); vb = cb.textContent.trim(); }
          else { va = ca.textContent.trim(); vb = cb.textContent.trim(); }
          if (va < vb) return -1 * sD;
          if (va > vb) return 1 * sD;
          return 0;
        });
        rows.forEach(function(r) { tb.appendChild(r); });
      });
    });
  })();
</script>
</body>
</html>`;

  return html;
}

// ============================================================
// 主函数
// ============================================================
function main() {
  const config = parseArgs();
  const dataDir = path.join(__dirname, 'scrape-yupao-data');

  // 读取输入文件
  let inputFile = config.input;
  if (!inputFile) {
    inputFile = findLatestBatch(dataDir);
    if (!inputFile) {
      console.error('✗ 未找到批量 JSON。请先运行 `npm run batch`，或用 --input 指定文件。');
      process.exit(1);
    }
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`✗ 文件不存在: ${inputFile}`);
    process.exit(1);
  }

  console.log(`读取数据: ${inputFile}`);
  const data = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
  const allJobs = data.jobs || [];
  const scrapeDate = data.scrapeDate || '未知';

  // 过滤目标城市（兼容 city 字段或 fullLocation 包含）
  const city = config.city;
  const cityLower = city.toLowerCase();
  let jobs = allJobs.filter((j) => {
    if (j.city && j.city.toLowerCase().includes(cityLower)) return true;
    if (j.fullLocation && j.fullLocation.toLowerCase().includes(cityLower)) return true;
    return false;
  });

  if (jobs.length === 0) {
    console.error(`✗ 未在数据中找到「${city}」的岗位。`);
    process.exit(0);
  }

  // 归一化行政区
  for (const j of jobs) {
    j._district = resolveDistrict(j);
    j._area = resolveArea(j);
  }

  // 整体统计
  const overall = computeOverallStats(jobs);
  // 全国均值（用于对比）
  const nationalMids = allJobs.map(wageMid).filter((x) => x !== null);
  const nationalMean = nationalMids.length ? nationalMids.reduce((a, b) => a + b, 0) / nationalMids.length : null;

  // 控制台摘要
  console.log('========================================');
  console.log(`  ${city} 产线工人时薪分析`);
  console.log('========================================');
  console.log(`  数据抓取日期: ${scrapeDate}`);
  console.log(`  ${city}岗位数: ${jobs.length}（有效时薪 ${overall.count} 条）`);
  console.log(`  全国岗位数: ${allJobs.length}（均值 ${fmt(nationalMean, '')}）`);
  console.log(`  时薪中位数: ${fmt(overall.median)}`);
  console.log(`  时薪均值:   ${fmt(overall.mean)}`);
  console.log(`  P25~P75:    ${fmt(overall.p25, '')} ~ ${fmt(overall.p75, '')}`);
  console.log(`  最低/最高:  ${fmt(overall.min, '')} / ${fmt(overall.max, '')}`);
  console.log('----------------------------------------');
  console.log('  各行政区均时薪:');
  groupStats(jobs, (j) => j._district).sort((a, b) => (b.mean || 0) - (a.mean || 0)).forEach((d) => {
    console.log(`    ${d.key.padEnd(8)} ${d.count}条  均值 ${d.mean !== null ? d.mean.toFixed(1) : '-'} 元/时`);
  });
  console.log('========================================\n');

  // 生成 HTML
  const html = generateHTML({ city, scrapeDate, jobs, overall, nationalMean });
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeCity = city.replace(/[^\w一-龥]/g, '_');
  const outFile = path.join(dataDir, `report-${safeCity}-${dateStr}.html`);
  fs.writeFileSync(outFile, html, 'utf-8');
  console.log(`✓ 报告已生成: ${outFile}`);
}

main();
