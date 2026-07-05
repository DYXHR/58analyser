/**
 * 鱼泡网产线工人时薪爬取脚本
 * 使用 Playwright 爬取 m.yupao.com 招聘列表，提取薪资并换算为时薪
 * 输出 JSON 数据文件 + HTML 可视化报告
 *
 * 用法:
 *   node scrape-yupao.js                              # 默认搜索"产线工人"，爬取3轮加载
 *   node scrape-yupao.js --keyword 普工
 *   node scrape-yupao.js --keyword 产线工人 --city 深圳
 *   node scrape-yupao.js --max-pages 5
 *
 * 批量模式（数千条数据）:
 *   node scrape-yupao.js --batch                      # 使用默认关键词列表批量爬取
 *   node scrape-yupao.js --batch --max-pages 20       # 每个关键词滚动20轮
 *   node scrape-yupao.js --batch --keywords "普工,操作工,装配工"
 */

import { chromium } from 'playwright';
import { parseWage, toHourlyWage, formatWage } from './wage-parser.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 批量模式默认关键词列表（工厂/产线相关岗位，30个关键词覆盖更多岗位）
const DEFAULT_KEYWORDS = [
  '产线工人', '普工', '操作工', '流水线工人', '装配工',
  '包装工', '分拣员', '质检员', '车间工人', '生产工人',
  '机修工', '仓库管理员', '物料员', '检验员', '打包工',
  '叉车工', '焊工', '电工', '学徒工', '杂工',
  '辅助工', '维修工', '调机员', '品管员', '跟单员',
  '统计员', '保全工', '帮工', '小工', '切割工',
];

// ============================================================
// 命令行参数解析
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    keyword: '产线工人',
    city: null,
    maxPages: 3,
    batch: false,
    keywords: null,       // 自定义关键词列表（逗号分隔）
    delay: 5,             // 批量模式关键词间延迟（秒）
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keyword' || arg === '-k') {
      config.keyword = args[++i];
    } else if (arg === '--city' || arg === '-c') {
      config.city = args[++i];
    } else if (arg === '--max-pages' || arg === '-m') {
      config.maxPages = parseInt(args[++i], 10) || 3;
    } else if (arg === '--batch' || arg === '-b') {
      config.batch = true;
      if (config.maxPages === 3) config.maxPages = 25; // 批量模式默认25轮
    } else if (arg === '--keywords') {
      config.keywords = args[++i];
    } else if (arg === '--delay' || arg === '-d') {
      config.delay = parseInt(args[++i], 10) || 5;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node scrape-yupao.js [选项]

单关键词模式:
  --keyword, -k <关键词>  搜索关键词 (默认: 产线工人)
  --city, -c <城市>       按城市本地过滤 (可选)
  --max-pages, -m <次数>  最大滚动加载次数 (默认: 3)

批量模式（获取数千条数据）:
  --batch, -b             启用批量模式，使用默认15个关键词
  --keywords <列表>       自定义关键词，逗号分隔 (如: "普工,操作工,装配工")
  --max-pages, -m <次数>  每个关键词滚动加载次数 (批量默认: 15)
  --delay, -d <秒>        关键词间延迟秒数 (默认: 5)
  --city, -c <城市>       按城市本地过滤 (可选)

示例:
  node scrape-yupao.js --batch
  node scrape-yupao.js --batch --max-pages 20 --delay 8
  node scrape-yupao.js --batch --keywords "普工,操作工" --city 深圳`);
      process.exit(0);
    }
  }
  return config;
}

// ============================================================
// 薪资预处理：将"万元"单位转换为"元"
// 如 "1.5-2万元/月" → "15000-20000元/月"
// ============================================================
function preprocessSalary(text) {
  if (!text) return '';
  let result = String(text).trim();
  // 范围 + 万元: "1.5-2万元/月" 或 "1.5-2万/月"
  result = result.replace(
    /(\d+(?:\.\d+)?)\s*[-–—~～至到]\s*(\d+(?:\.\d+)?)\s*万(?:元)?/g,
    (_, a, b) => `${Math.round(parseFloat(a) * 10000)}-${Math.round(parseFloat(b) * 10000)}元`
  );
  // 单值 + 万元: "2万元/月" 或 "2万/月"
  result = result.replace(
    /(\d+(?:\.\d+)?)\s*万(?:元)?/g,
    (_, a) => `${Math.round(parseFloat(a) * 10000)}元`
  );
  return result;
}

// ============================================================
// 从当前页面提取原始岗位数据（在浏览器上下文中执行）
// ============================================================
async function extractRawJobs(page) {
  return await page.evaluate(() => {
    const jobs = [];
    const cards = document.querySelectorAll('[class*="card___"]');

    cards.forEach((card) => {
      try {
        // 岗位标题
        const titleEl = card.querySelector('[class*="text___"]');
        const title = titleEl ? titleEl.innerText.trim() : '';

        // 薪资文本
        const salaryEl = card.querySelector('[class*="salary___"]');
        const salaryRaw = salaryEl ? salaryEl.innerText.trim() : '';

        // 用户信息: "联系人 · 公司名" (在 a 标签中)
        const userInfoEl = card.querySelector('[class*="userInfoText___"]');
        const userLinkEl = userInfoEl ? userInfoEl.querySelector('a') : null;
        const userInfoText = userLinkEl ? userLinkEl.innerText.trim() : '';
        const parts = userInfoText.split('·').map((s) => s.trim());
        const contact = parts[0] || '';
        const company = parts[1] || '';

        // 活跃状态 (span 标签)
        const activityEl = userInfoEl ? userInfoEl.querySelector('span') : null;
        const activity = activityEl ? activityEl.innerText.trim() : '';

        // 地区: "省市 县区"
        const addressEl = card.querySelector('[class*="address___"]');
        const addressText = addressEl ? addressEl.innerText.trim() : '';
        const addressParts = addressText.split(/\s+/);
        const city = addressParts[0] || '';
        const district = addressParts.slice(1).join(' ') || '';

        // 发布时间
        const dateEl = card.querySelector('[class*="date___"]');
        const date = dateEl ? dateEl.innerText.trim() : '';

        // 岗位标签
        const tagEls = card.querySelectorAll('[class*="jobTags___"] span');
        const tags = Array.from(tagEls)
          .map((el) => el.innerText.trim())
          .filter(Boolean);

        // 企业链接
        const linkEl = card.querySelector('a[href*="/qiye/"]');
        let companyUrl = linkEl ? linkEl.href : '';
        // 规范化为绝对 URL
        if (companyUrl && !companyUrl.startsWith('http')) {
          companyUrl = 'https://m.yupao.com' + (companyUrl.startsWith('/') ? '' : '/') + companyUrl;
        }

        jobs.push({
          title,
          salaryRaw,
          company,
          contact,
          city,
          district,
          fullLocation: addressText,
          date,
          tags,
          companyUrl,
          activity,
        });
      } catch (e) {
        // 跳过解析失败的卡片
      }
    });
    return jobs;
  });
}

// ============================================================
// 处理原始数据：薪资解析、时薪换算、去重
// ============================================================
function processJobs(rawJobs) {
  const seen = new Set();
  const processed = [];

  for (const raw of rawJobs) {
    // 去重：以 标题+公司 为唯一标识（同一企业不同岗位不应被去重）
    const dedupeKey = `${raw.title}|${raw.company}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // 薪资预处理 + 解析
    const processedSalary = preprocessSalary(raw.salaryRaw);
    const salaryParsed = parseWage(processedSalary);
    const hourlyWage = toHourlyWage(salaryParsed);

    // 时薪显示字符串
    const hourlyWageDisplay = (() => {
      const { min, max } = hourlyWage;
      if (min === null && max === null) return '-';
      if (min !== null && max !== null && min !== max) {
        return `${min.toFixed(1)}-${max.toFixed(1)}元/小时`;
      }
      const val = min !== null ? min : max;
      return `${val.toFixed(1)}元/小时`;
    })();

    processed.push({
      title: raw.title,
      salaryRaw: raw.salaryRaw,
      salaryParsed,
      hourlyWage,
      hourlyWageDisplay,
      company: raw.company,
      contact: raw.contact,
      city: raw.city,
      district: raw.district,
      fullLocation: raw.fullLocation,
      date: raw.date,
      tags: raw.tags,
      companyUrl: raw.companyUrl,
      activity: raw.activity,
    });
  }

  return processed;
}

// ============================================================
// 统计当前页面岗位卡片数量（用于判断是否成功加载更多）
// ============================================================
async function countCards(page) {
  return await page.evaluate(() => {
    return document.querySelectorAll('[id^="RecruitCard_"], [class*="card___"]').length;
  });
}

// ============================================================
// 策略A：模拟鼠标拖拽（hasTouch 模式下会触发 touch 事件）
// ============================================================
async function swipeStrategyA(page) {
  const viewport = page.viewportSize();
  const startX = Math.floor(viewport.width / 2);
  const startY = Math.floor(viewport.height * 0.75);
  const endY = Math.floor(viewport.height * 0.2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(startY + ((endY - startY) * i) / steps);
    await page.mouse.move(startX, y);
    await page.waitForTimeout(25);
  }
  await page.mouse.up();
  await page.waitForTimeout(2000);
}

// ============================================================
// 策略B：分发 TouchEvent 序列（更接近真实触摸上拉）
// ============================================================
async function swipeStrategyB(page) {
  const viewport = page.viewportSize();
  const startX = Math.floor(viewport.width / 2);
  const startY = Math.floor(viewport.height * 0.75);
  const endY = Math.floor(viewport.height * 0.2);
  await page.evaluate(
    async ({ startX, startY, endY }) => {
      const steps = 12;
      const target = document.elementFromPoint(startX, startY) || document.body;
      const makeTouch = (x, y) =>
        new Touch({
          identifier: 1,
          target,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
          radiusX: 1,
          radiusY: 1,
          force: 1,
        });
      const makeEvent = (type, touch) =>
        new TouchEvent(type, {
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: type === 'touchend' ? [] : [touch],
          changedTouches: [touch],
          bubbles: true,
          cancelable: true,
        });
      target.dispatchEvent(makeEvent('touchstart', makeTouch(startX, startY)));
      for (let i = 1; i <= steps; i++) {
        const y = Math.round(startY + ((endY - startY) * i) / steps);
        target.dispatchEvent(makeEvent('touchmove', makeTouch(startX, y)));
        await new Promise((r) => setTimeout(r, 25));
      }
      target.dispatchEvent(makeEvent('touchend', makeTouch(startX, endY)));
    },
    { startX, startY, endY }
  );
  await page.waitForTimeout(2000);
}

// ============================================================
// 策略C：设置可滚动容器的 scrollTop 到底部
// ============================================================
async function swipeStrategyC(page) {
  await page.evaluate(() => {
    const els = [document.scrollingElement, document.documentElement, document.body];
    for (const el of els) {
      if (el && el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight;
    }
    document.querySelectorAll('*').forEach((el) => {
      const style = getComputedStyle(el);
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight
      ) {
        el.scrollTop = el.scrollHeight;
      }
    });
    window.scrollTo(0, document.body.scrollHeight);
  });
  await page.waitForTimeout(2000);
}

// ============================================================
// 模拟触摸上拉滑动，触发无限滚动加载更多
// 按策略 A→B→C 顺序尝试，每次检查卡片数量是否增加
// @returns {Promise<boolean>} 是否成功加载了更多数据
// ============================================================
async function swipeUpToLoadMore(page) {
  const before = await countCards(page);

  // 策略A：模拟鼠标拖拽
  await swipeStrategyA(page);
  if ((await countCards(page)) > before) return true;

  // 策略B：分发 TouchEvent
  await swipeStrategyB(page);
  if ((await countCards(page)) > before) return true;

  // 策略C：设置容器 scrollTop
  await swipeStrategyC(page);
  return (await countCards(page)) > before;
}

// ============================================================
// 检查是否还有"加载更多"提示
// ============================================================
async function hasLoadMore(page) {
  return await page.evaluate(() => {
    const els = document.querySelectorAll('[class*="load-more___"]');
    for (const el of els) {
      const text = el.innerText || '';
      if (text.includes('上拉加载') || text.includes('加载更多') || text.includes('加载中')) {
        return true;
      }
    }
    return false;
  });
}

// ============================================================
// JSON 输出
// ============================================================
function generateJSON(keyword, city, jobs, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const safeKeyword = keyword.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const filename = `wages-${safeKeyword}-${dateStr}.json`;
  const filepath = path.join(outputDir, filename);

  const data = {
    keyword,
    city,
    scrapeDate: dateStr,
    totalJobs: jobs.length,
    jobs,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`✓ JSON 数据已保存: ${filepath}`);
  return filepath;
}

// ============================================================
// HTML 转义
// ============================================================
function escapeHtml(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
// 计算时薪统计信息
// ============================================================
function computeStats(jobs) {
  const wages = [];
  for (const job of jobs) {
    const { min, max } = job.hourlyWage;
    if (min !== null && max !== null) {
      wages.push((min + max) / 2);
    } else if (min !== null) {
      wages.push(min);
    } else if (max !== null) {
      wages.push(max);
    }
  }
  if (wages.length === 0) {
    return { mean: null, median: null, min: null, max: null, count: 0 };
  }
  const sorted = [...wages].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return {
    mean: sum / sorted.length,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    count: wages.length,
  };
}

// ============================================================
// 按城市分组统计
// ============================================================
function computeCityStats(jobs) {
  const cityMap = new Map();
  for (const job of jobs) {
    const city = job.city || '未知';
    if (!cityMap.has(city)) {
      cityMap.set(city, { city, wages: [], count: 0 });
    }
    const entry = cityMap.get(city);
    entry.count++;
    const { min, max } = job.hourlyWage;
    if (min !== null && max !== null) {
      entry.wages.push((min + max) / 2);
    } else if (min !== null) {
      entry.wages.push(min);
    } else if (max !== null) {
      entry.wages.push(max);
    }
  }
  const result = [];
  for (const [, entry] of cityMap) {
    if (entry.wages.length > 0) {
      const avg = entry.wages.reduce((a, b) => a + b, 0) / entry.wages.length;
      result.push({ city: entry.city, avgWage: avg, count: entry.count });
    } else {
      result.push({ city: entry.city, avgWage: null, count: entry.count });
    }
  }
  result.sort((a, b) => (b.avgWage || 0) - (a.avgWage || 0));
  return result;
}

// ============================================================
// 格式化时薪显示
// ============================================================
function formatHourlyWage(hourlyWage) {
  const { min, max } = hourlyWage;
  if (min === null && max === null) return '-';
  if (min !== null && max !== null && min !== max) {
    return `${min.toFixed(1)}-${max.toFixed(1)} 元/时`;
  }
  const val = min !== null ? min : max;
  return `${val.toFixed(1)} 元/时`;
}

// 获取用于排序的时薪数值（取 min 和 max 的平均值）
function getHourlyWageSortValue(hourlyWage) {
  const { min, max } = hourlyWage;
  if (min !== null && max !== null) return (min + max) / 2;
  if (min !== null) return min;
  if (max !== null) return max;
  return -1;
}

// ============================================================
// HTML 报告生成
// ============================================================
function generateHTML(keyword, city, jobs, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const safeKeyword = keyword.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const filename = `report-${safeKeyword}-${dateStr}.html`;
  const filepath = path.join(outputDir, filename);

  const stats = computeStats(jobs);
  const cityStats = computeCityStats(jobs);
  const maxCityWage = Math.max(...cityStats.map((c) => c.avgWage || 0), 1);

  // 统计卡片
  const fmtStat = (v) => (v !== null ? v.toFixed(1) + ' 元/时' : '-');
  const statsCards = `
    <div class="stat-card">
      <div class="stat-label">时薪均值</div>
      <div class="stat-value">${fmtStat(stats.mean)}</div>
      <div class="stat-sub">基于 ${stats.count} 条有效数据</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">时薪中位数</div>
      <div class="stat-value">${fmtStat(stats.median)}</div>
      <div class="stat-sub">50% 分位</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最低时薪</div>
      <div class="stat-value low">${fmtStat(stats.min)}</div>
      <div class="stat-sub">最低值</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">最高时薪</div>
      <div class="stat-value high">${fmtStat(stats.max)}</div>
      <div class="stat-sub">最高值</div>
    </div>`;

  // 城市对比表格 + 条形图
  const cityRows = cityStats
    .map((c) => {
      const pct = c.avgWage ? (c.avgWage / maxCityWage) * 100 : 0;
      const wageStr = c.avgWage !== null ? c.avgWage.toFixed(1) + ' 元/时' : '-';
      return `
      <tr>
        <td class="city-name">${escapeHtml(c.city)}</td>
        <td>${c.count}</td>
        <td class="wage-cell">${wageStr}</td>
        <td class="bar-cell"><div class="bar" style="width:${pct}%"></div></td>
      </tr>`;
    })
    .join('');

  // 岗位表格行
  const tableRows = jobs
    .map((job, i) => {
      const sortVal = getHourlyWageSortValue(job.hourlyWage);
      const hourlyStr = formatHourlyWage(job.hourlyWage);
      const tagsStr = job.tags.length > 0 ? job.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '';
      const companyLink = job.companyUrl
        ? `<a href="${escapeHtml(job.companyUrl)}" target="_blank">${escapeHtml(job.company)}</a>`
        : escapeHtml(job.company);
      return `
      <tr data-sort-idx="${i}">
        <td>${escapeHtml(job.title)}</td>
        <td>${companyLink}</td>
        <td>${escapeHtml(job.city)}</td>
        <td>${escapeHtml(job.salaryRaw)}</td>
        <td data-sort-num="${sortVal}">${escapeHtml(hourlyStr)}</td>
        <td data-sort-date="${escapeHtml(job.date)}">${escapeHtml(job.date)}</td>
        <td>${tagsStr}</td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>鱼泡网时薪报告 - ${escapeHtml(keyword)} - ${dateStr}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f7fa;
    color: #333;
    line-height: 1.6;
  }
  .header {
    background: linear-gradient(135deg, #1a73e8, #0d47a1);
    color: #fff;
    padding: 32px 24px;
    text-align: center;
  }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { font-size: 14px; opacity: 0.85; }
  .header .meta span { margin: 0 12px; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px; }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }
  .stat-card {
    background: #fff;
    border-radius: 12px;
    padding: 20px;
    text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
  }
  .stat-label { font-size: 13px; color: #888; margin-bottom: 8px; }
  .stat-value { font-size: 28px; font-weight: 700; color: #1a73e8; }
  .stat-value.low { color: #e65100; }
  .stat-value.high { color: #2e7d32; }
  .stat-sub { font-size: 12px; color: #aaa; margin-top: 4px; }

  .section { margin-bottom: 32px; }
  .section-title {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
    padding-left: 12px;
    border-left: 4px solid #1a73e8;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    background: #fff;
    border-radius: 8px;
    overflow: hidden;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    font-size: 14px;
  }
  thead { background: #f0f4ff; }
  th {
    padding: 12px 14px;
    text-align: left;
    font-weight: 600;
    color: #555;
    cursor: pointer;
    user-select: none;
    white-space: nowrap;
    transition: background 0.15s;
  }
  th:hover { background: #e3eaff; }
  th.sort-asc::after { content: " ▲"; font-size: 11px; color: #1a73e8; }
  th.sort-desc::after { content: " ▼"; font-size: 11px; color: #1a73e8; }
  td {
    padding: 10px 14px;
    border-bottom: 1px solid #f0f0f0;
    vertical-align: top;
  }
  tbody tr:hover { background: #f8faff; }
  tbody tr:nth-child(even) { background: #fcfcfe; }
  tbody tr:nth-child(even):hover { background: #f8faff; }

  .city-name { font-weight: 600; }
  .wage-cell { font-weight: 600; color: #1a73e8; white-space: nowrap; }
  .bar-cell { width: 200px; }
  .bar {
    height: 20px;
    background: linear-gradient(90deg, #4fc3f7, #1a73e8);
    border-radius: 4px;
    min-width: 2px;
    transition: width 0.3s;
  }

  .tag {
    display: inline-block;
    background: #e8f0fe;
    color: #1a73e8;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    margin: 2px 2px;
    white-space: nowrap;
  }

  td a { color: #1a73e8; text-decoration: none; }
  td a:hover { text-decoration: underline; }

  .table-wrapper { overflow-x: auto; }
  .footer {
    text-align: center;
    padding: 24px;
    color: #aaa;
    font-size: 13px;
  }
</style>
</head>
<body>
  <div class="header">
    <h1>鱼泡网时薪数据报告</h1>
    <div class="meta">
      <span>关键词: ${escapeHtml(keyword)}</span>
      <span>${city ? '城市筛选: ' + escapeHtml(city) : '城市: 全国'}</span>
      <span>日期: ${dateStr}</span>
      <span>岗位总数: ${jobs.length}</span>
    </div>
  </div>

  <div class="container">
    <div class="stats-grid">${statsCards}</div>

    <div class="section">
      <div class="section-title">按城市分组的平均时薪对比</div>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>城市</th>
              <th>岗位数</th>
              <th>平均时薪</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>${cityRows}</tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title">岗位列表（点击列头排序）</div>
      <div class="table-wrapper">
        <table id="jobsTable">
          <thead>
            <tr>
              <th data-col="0" data-type="text">岗位标题</th>
              <th data-col="1" data-type="text">公司</th>
              <th data-col="2" data-type="text">城市</th>
              <th data-col="3" data-type="text">薪资原文</th>
              <th data-col="4" data-type="num">换算时薪</th>
              <th data-col="5" data-type="date">发布时间</th>
              <th data-col="6" data-type="text">标签</th>
            </tr>
          </thead>
          <tbody id="jobsBody">${tableRows}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="footer">
    数据来源: 鱼泡网 m.yupao.com · 生成时间: ${today.toLocaleString('zh-CN')}
  </div>

<script>
  (function() {
    var sortCol = -1, sortDir = 1;
    var headers = document.querySelectorAll('#jobsTable th');
    headers.forEach(function(th) {
      th.addEventListener('click', function() {
        var col = parseInt(th.dataset.col);
        var type = th.dataset.type;
        if (sortCol === col) {
          sortDir = -sortDir;
        } else {
          sortCol = col;
          sortDir = 1;
        }
        headers.forEach(function(h) { h.classList.remove('sort-asc', 'sort-desc'); });
        th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');

        var tbody = document.getElementById('jobsBody');
        var rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort(function(a, b) {
          var cellA = a.children[col];
          var cellB = b.children[col];
          var valA, valB;
          if (type === 'num') {
            valA = parseFloat(cellA.dataset.sortNum) || -1;
            valB = parseFloat(cellB.dataset.sortNum) || -1;
          } else if (type === 'date') {
            valA = cellA.dataset.sortDate || '';
            valB = cellB.dataset.sortDate || '';
          } else {
            valA = cellA.textContent.trim();
            valB = cellB.textContent.trim();
          }
          if (valA < valB) return -1 * sortDir;
          if (valA > valB) return 1 * sortDir;
          return 0;
        });
        rows.forEach(function(r) { tbody.appendChild(r); });
      });
    });
  })();
</script>
</body>
</html>`;

  fs.writeFileSync(filepath, html, 'utf-8');
  console.log(`✓ HTML 报告已保存: ${filepath}`);
  return filepath;
}

// ============================================================
// 检测并处理鱼泡网安全验证页（geetest 极验反爬）
// 鱼泡网会对自动化访问弹出"安全访问验证"页面，需点击验证按钮通过
// @returns {Promise<boolean>} 是否通过验证（或无需验证）
// ============================================================
async function handleVerificationPage(page, maxRetries = 4) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 检测验证按钮
    const verifyBtn = await page.$('[class*="btn___"]').catch(() => null);
    if (!verifyBtn) {
      // 没有验证按钮，检查是否已有卡片（说明已通过验证）
      const hasCards = await page.$('[class*="card___"]').catch(() => null);
      if (hasCards) return true;
      // 既没验证按钮也没卡片，可能还在加载
      await page.waitForTimeout(2000);
      continue;
    }

    const btnText = await verifyBtn.innerText().catch(() => '');
    if (!btnText.includes('验证')) {
      const hasCards = await page.$('[class*="card___"]').catch(() => null);
      if (hasCards) return true;
      await page.waitForTimeout(2000);
      continue;
    }

    console.log(`  检测到安全验证页，尝试通过验证 (第 ${attempt}/${maxRetries} 次)...`);

    // 模拟人类行为：随机等待后移动鼠标再点击
    await page.waitForTimeout(1500 + Math.random() * 1500);

    const box = await verifyBtn.boundingBox();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // 先将鼠标移动到按钮附近随机位置，模拟人类视线移动
      await page.mouse.move(cx - 60 + Math.random() * 120, cy - 40 + Math.random() * 30);
      await page.waitForTimeout(300 + Math.random() * 500);
      // 再移动到按钮中心
      await page.mouse.move(cx, cy);
      await page.waitForTimeout(200 + Math.random() * 300);
      // 点击（带延迟）
      await page.mouse.click(cx, cy, { delay: 80 + Math.random() * 120 });
    } else {
      await verifyBtn.click({ delay: 100 });
    }

    // 等待验证结果（geetest 需要时间处理）
    await page.waitForTimeout(4000);

    // 检查是否已通过验证（卡片出现）
    const hasCards = await page.$('[class*="card___"]').catch(() => null);
    if (hasCards) {
      console.log('  ✓ 验证通过！');
      return true;
    }

    // 检查是否出现滑块验证码
    const slider = await page
      .$('.geetest_slider_button, [class*="geetest_slider"]')
      .catch(() => null);
    if (slider) {
      console.log('  出现滑块验证码，尝试处理...');
      await trySolveGeetestSlider(page);
      await page.waitForTimeout(3000);
      const hasCardsNow = await page.$('[class*="card___"]').catch(() => null);
      if (hasCardsNow) {
        console.log('  ✓ 滑块验证通过！');
        return true;
      }
    }

    // 检查验证按钮是否已消失（可能正在跳转）
    const stillVerifying = await page.$('[class*="btn___"]').catch(() => null);
    if (!stillVerifying) {
      await page.waitForTimeout(3000);
      const hasCardsNow = await page.$('[class*="card___"]').catch(() => null);
      if (hasCardsNow) {
        console.log('  ✓ 验证通过！');
        return true;
      }
    }
  }

  // 最终检查
  const hasCards = await page.$('[class*="card___"]').catch(() => null);
  return !!hasCards;
}

// ============================================================
// 尝试处理 geetest 滑块验证码（模拟人类拖拽行为）
// ============================================================
async function trySolveGeetestSlider(page) {
  try {
    const slider = await page.$('.geetest_slider_button');
    if (!slider) return false;
    const box = await slider.boundingBox();
    if (!box) return false;

    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const distance = 260; // 滑块轨道宽度约 260px

    await page.mouse.move(startX, startY);
    await page.waitForTimeout(200);
    await page.mouse.down();

    // 使用缓动函数模拟人类拖拽：先加速后减速
    const steps = 30;
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      const targetX = startX + distance * eased;
      const jitter = (Math.random() - 0.5) * 2;
      await page.mouse.move(targetX + jitter, startY + (Math.random() - 0.5) * 3);
      await page.waitForTimeout(15 + Math.random() * 20);
    }

    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(2000);
    return true;
  } catch (e) {
    console.warn('  滑块处理失败:', e.message);
    return false;
  }
}

// ============================================================
// 创建浏览器上下文（隐藏自动化特征）
// ============================================================
async function createBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  // 隐藏自动化特征
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    window.chrome = { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  return { browser, context };
}

// ============================================================
// 爬取单个关键词的所有岗位数据
// @returns {Promise<Array>} 原始岗位列表
// ============================================================
async function scrapeKeyword(context, keyword, maxPages) {
  const searchUrl = `https://m.yupao.com/topic/a1?keywords=${encodeURIComponent(keyword)}`;
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  let allRawJobs = [];

  try {
    // 先访问首页建立会话
    await page.goto('https://m.yupao.com/', { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(2000);

    // 打开搜索页
    await page.goto(searchUrl, { waitUntil: 'commit', timeout: 60000 });

    // 处理安全验证
    const verified = await handleVerificationPage(page);
    if (!verified) {
      console.log('  安全验证未通过，继续尝试提取已有内容...');
    }

    // 等待列表卡片
    await page.waitForSelector('[class*="card___"]', { timeout: 45000 });

    // 第一轮提取
    let rawJobs = await extractRawJobs(page);
    allRawJobs = rawJobs;
    console.log(`  第 1 轮: ${rawJobs.length} 条`);

    // 无限滚动加载
    for (let round = 2; round <= maxPages; round++) {
      const prevCount = allRawJobs.length;
      await swipeUpToLoadMore(page);
      rawJobs = await extractRawJobs(page);
      allRawJobs = rawJobs;
      const newCount = allRawJobs.length - prevCount;
      console.log(`  第 ${round} 轮: 累计 ${allRawJobs.length} 条，新增 ${newCount} 条`);

      if (newCount === 0) {
        // 再试一次
        await page.waitForTimeout(1500);
        const canLoadMore = await hasLoadMore(page);
        if (!canLoadMore) {
          console.log('  没有更多数据了');
          break;
        }
        // 最后尝试
        await swipeUpToLoadMore(page);
        rawJobs = await extractRawJobs(page);
        allRawJobs = rawJobs;
        if (allRawJobs.length === prevCount) {
          console.log('  连续两轮无新数据，停止');
          break;
        }
      }
    }
  } catch (err) {
    if (allRawJobs.length === 0) {
      console.warn(`  爬取失败: ${err.message}`);
    } else {
      console.warn(`  爬取中出现错误（已有部分数据）: ${err.message}`);
    }
  } finally {
    await page.close();
  }

  // 标记来源关键词
  return allRawJobs.map((job) => ({ ...job, searchKeyword: keyword }));
}

// ============================================================
// 批量模式：生成合并的 JSON 和 HTML
// ============================================================
function generateBatchJSON(allJobs, keywords, city, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const filename = `wages-batch-${dateStr}.json`;
  const filepath = path.join(outputDir, filename);

  const data = {
    keywords,
    city,
    scrapeDate: dateStr,
    totalJobs: allJobs.length,
    keywordCount: keywords.length,
    jobs: allJobs,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n✓ 批量JSON已保存: ${filepath} (${allJobs.length} 条)`);
  return filepath;
}

function generateBatchHTML(allJobs, keywords, city, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const filename = `report-batch-${dateStr}.html`;
  const filepath = path.join(outputDir, filename);

  const stats = computeStats(allJobs);
  const cityStats = computeCityStats(allJobs);
  const maxCityWage = Math.max(...cityStats.map((c) => c.avgWage || 0), 1);

  // 按关键词统计
  const kwMap = new Map();
  for (const job of allJobs) {
    const kw = job.searchKeyword || '未知';
    if (!kwMap.has(kw)) kwMap.set(kw, { keyword: kw, count: 0, wages: [] });
    const e = kwMap.get(kw);
    e.count++;
    const { min, max } = job.hourlyWage;
    if (min !== null && max !== null) e.wages.push((min + max) / 2);
    else if (min !== null) e.wages.push(min);
  }
  const kwStats = Array.from(kwMap.values()).map((e) => ({
    keyword: e.keyword,
    count: e.count,
    avgWage: e.wages.length > 0 ? e.wages.reduce((a, b) => a + b, 0) / e.wages.length : null,
  })).sort((a, b) => b.count - a.count);

  const fmtStat = (v) => (v !== null ? v.toFixed(1) + ' 元/时' : '-');

  const statsCards = `
    <div class="stat-card"><div class="stat-label">总岗位数</div><div class="stat-value">${allJobs.length}</div><div class="stat-sub">${keywords.length} 个关键词</div></div>
    <div class="stat-card"><div class="stat-label">时薪均值</div><div class="stat-value">${fmtStat(stats.mean)}</div><div class="stat-sub">${stats.count} 条有效</div></div>
    <div class="stat-card"><div class="stat-label">时薪中位数</div><div class="stat-value">${fmtStat(stats.median)}</div><div class="stat-sub">50% 分位</div></div>
    <div class="stat-card"><div class="stat-label">时薪范围</div><div class="stat-value" style="font-size:18px">${fmtStat(stats.min)} ~ ${fmtStat(stats.max)}</div><div class="stat-sub">最低 ~ 最高</div></div>`;

  const cityRows = cityStats.map((c) => {
    const pct = c.avgWage ? (c.avgWage / maxCityWage) * 100 : 0;
    return `<tr><td class="city-name">${escapeHtml(c.city)}</td><td>${c.count}</td><td class="wage-cell">${c.avgWage !== null ? c.avgWage.toFixed(1) + ' 元/时' : '-'}</td><td class="bar-cell"><div class="bar" style="width:${pct}%"></div></td></tr>`;
  }).join('');

  const kwRows = kwStats.map((k) => `
    <tr><td>${escapeHtml(k.keyword)}</td><td>${k.count}</td><td class="wage-cell">${k.avgWage !== null ? k.avgWage.toFixed(1) + ' 元/时' : '-'}</td></tr>
  `).join('');

  const tableRows = allJobs.map((job, i) => {
    const sortVal = getHourlyWageSortValue(job.hourlyWage);
    const hourlyStr = formatHourlyWage(job.hourlyWage);
    const tagsStr = job.tags.length > 0 ? job.tags.slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '';
    const companyLink = job.companyUrl ? `<a href="${escapeHtml(job.companyUrl)}" target="_blank">${escapeHtml(job.company)}</a>` : escapeHtml(job.company);
    return `<tr data-sort-idx="${i}"><td>${escapeHtml(job.title)}</td><td>${companyLink}</td><td>${escapeHtml(job.city)}</td><td>${escapeHtml(job.salaryRaw)}</td><td data-sort-num="${sortVal}">${escapeHtml(hourlyStr)}</td><td><span class="kw-tag">${escapeHtml(job.searchKeyword || '')}</span></td><td>${escapeHtml(job.date)}</td><td>${tagsStr}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>鱼泡网批量时薪报告 - ${dateStr}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #333; line-height: 1.6; }
.header { background: linear-gradient(135deg, #1a73e8, #0d47a1); color: #fff; padding: 32px 24px; text-align: center; }
.header h1 { font-size: 24px; margin-bottom: 8px; } .header .meta { font-size: 14px; opacity: 0.85; } .header .meta span { margin: 0 12px; }
.container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
.stat-card { background: #fff; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.stat-label { font-size: 13px; color: #888; margin-bottom: 8px; } .stat-value { font-size: 28px; font-weight: 700; color: #1a73e8; } .stat-sub { font-size: 12px; color: #aaa; margin-top: 4px; }
.section { margin-bottom: 32px; } .section-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; padding-left: 12px; border-left: 4px solid #1a73e8; }
.dual-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 768px) { .dual-grid { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); font-size: 13px; }
thead { background: #f0f4ff; } th { padding: 12px 14px; text-align: left; font-weight: 600; color: #555; cursor: pointer; user-select: none; white-space: nowrap; }
th:hover { background: #e3eaff; } th.sort-asc::after { content: " ▲"; font-size: 11px; color: #1a73e8; } th.sort-desc::after { content: " ▼"; font-size: 11px; color: #1a73e8; }
td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
tbody tr:hover { background: #f8faff; } tbody tr:nth-child(even) { background: #fcfcfe; }
.city-name { font-weight: 600; } .wage-cell { font-weight: 600; color: #1a73e8; white-space: nowrap; }
.bar-cell { width: 150px; } .bar { height: 20px; background: linear-gradient(90deg, #4fc3f7, #1a73e8); border-radius: 4px; min-width: 2px; }
.tag { display: inline-block; background: #e8f0fe; color: #1a73e8; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin: 1px; white-space: nowrap; }
.kw-tag { display: inline-block; background: #fff3e0; color: #e65100; padding: 2px 6px; border-radius: 4px; font-size: 11px; white-space: nowrap; }
td a { color: #1a73e8; text-decoration: none; } td a:hover { text-decoration: underline; }
.table-wrapper { overflow-x: auto; max-height: 800px; overflow-y: auto; }
.footer { text-align: center; padding: 24px; color: #aaa; font-size: 13px; }
</style></head>
<body>
<div class="header"><h1>鱼泡网批量时薪数据报告</h1>
<div class="meta"><span>关键词: ${escapeHtml(keywords.join(', '))}</span><span>${city ? '城市: ' + escapeHtml(city) : '城市: 全国'}</span><span>日期: ${dateStr}</span><span>岗位总数: ${allJobs.length}</span></div></div>
<div class="container">
  <div class="stats-grid">${statsCards}</div>
  <div class="dual-grid">
    <div class="section"><div class="section-title">按城市分组</div><div class="table-wrapper"><table><thead><tr><th>城市</th><th>岗位数</th><th>平均时薪</th><th>占比</th></tr></thead><tbody>${cityRows}</tbody></table></div></div>
    <div class="section"><div class="section-title">按关键词分组</div><div class="table-wrapper"><table><thead><tr><th>关键词</th><th>岗位数</th><th>平均时薪</th></tr></thead><tbody>${kwRows}</tbody></table></div></div>
  </div>
  <div class="section"><div class="section-title">全部岗位列表（点击列头排序）</div><div class="table-wrapper"><table id="jobsTable"><thead><tr><th data-col="0" data-type="text">岗位标题</th><th data-col="1" data-type="text">公司</th><th data-col="2" data-type="text">城市</th><th data-col="3" data-type="text">薪资原文</th><th data-col="4" data-type="num">换算时薪</th><th data-col="5" data-type="text">来源关键词</th><th data-col="6" data-type="date">发布时间</th><th data-col="7" data-type="text">标签</th></tr></thead><tbody id="jobsBody">${tableRows}</tbody></table></div></div>
</div>
<div class="footer">数据来源: 鱼泡网 m.yupao.com · 生成时间: ${today.toLocaleString('zh-CN')}</div>
<script>(function(){var sC=-1,sD=1;var hs=document.querySelectorAll('#jobsTable th');hs.forEach(function(th){th.addEventListener('click',function(){var c=parseInt(th.dataset.col),t=th.dataset.type;if(sC===c){sD=-sD}else{sC=c;sD=1}hs.forEach(function(h){h.classList.remove('sort-asc','sort-desc')});th.classList.add(sD===1?'sort-asc':'sort-desc');var tb=document.getElementById('jobsBody'),rs=Array.from(tb.querySelectorAll('tr'));rs.sort(function(a,b){var ca=a.children[c],cb=b.children[c],va,vb;if(t==='num'){va=parseFloat(ca.dataset.sortNum)||-1;vb=parseFloat(cb.dataset.sortNum)||-1}else if(t==='date'){va=ca.dataset.sortDate||'';vb=cb.dataset.sortDate||''}else{va=ca.textContent.trim();vb=cb.textContent.trim()}if(va<vb)return -1*sD;if(va>vb)return 1*sD;return 0});rs.forEach(function(r){tb.appendChild(r)})})})})();</script>
</body></html>`;

  fs.writeFileSync(filepath, html, 'utf-8');
  console.log(`✓ 批量HTML报告已保存: ${filepath}`);
  return filepath;
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  const config = parseArgs();

  // 验证 wage-parser.js 导入
  try {
    const testParsed = parseWage(preprocessSalary('1.5-2万元/月'));
    if (testParsed.type !== 'monthly' || testParsed.min !== 15000 || testParsed.max !== 20000) {
      throw new Error(`薪资解析异常: ${JSON.stringify(testParsed)}`);
    }
    console.log(`✓ wage-parser 导入正常`);
  } catch (e) {
    console.error('✗ wage-parser 导入异常:', e.message);
    process.exit(1);
  }

  const outputDir = path.join(__dirname, 'scrape-yupao-data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // ===================== 批量模式 =====================
  if (config.batch) {
    const keywords = config.keywords
      ? config.keywords.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_KEYWORDS;

    console.log('========================================');
    console.log('  鱼泡网批量时薪爬取');
    console.log('========================================');
    console.log(`  关键词数: ${keywords.length}`);
    console.log(`  关键词: ${keywords.join(', ')}`);
    console.log(`  每词滚动: ${config.maxPages} 轮`);
    console.log(`  词间延迟: ${config.delay} 秒`);
    console.log(`  城市: ${config.city || '全国'}`);
    console.log('========================================\n');

    const { browser, context } = await createBrowser();
    const globalDedup = new Set(); // 跨关键词去重
    let allProcessedJobs = [];
    const kwSummary = [];

    try {
      for (let ki = 0; ki < keywords.length; ki++) {
        const kw = keywords[ki];
        console.log(`\n[${ki + 1}/${keywords.length}] 关键词: "${kw}"`);
        console.log('----------------------------------------');

        const rawJobs = await scrapeKeyword(context, kw, config.maxPages);
        console.log(`  原始数据: ${rawJobs.length} 条`);

        // 处理 + 跨关键词去重
        let newCount = 0;
        for (const raw of rawJobs) {
          const dedupeKey = `${raw.title}|${raw.company}`;
          if (globalDedup.has(dedupeKey)) continue;
          globalDedup.add(dedupeKey);

          const processedSalary = preprocessSalary(raw.salaryRaw);
          const salaryParsed = parseWage(processedSalary);
          const hourlyWage = toHourlyWage(salaryParsed);
          const hourlyWageDisplay = (() => {
            const { min, max } = hourlyWage;
            if (min === null && max === null) return '-';
            if (min !== null && max !== null && min !== max) return `${min.toFixed(1)}-${max.toFixed(1)}元/小时`;
            const val = min !== null ? min : max;
            return `${val.toFixed(1)}元/小时`;
          })();

          allProcessedJobs.push({
            title: raw.title, salaryRaw: raw.salaryRaw, salaryParsed, hourlyWage, hourlyWageDisplay,
            company: raw.company, contact: raw.contact, city: raw.city, district: raw.district,
            fullLocation: raw.fullLocation, date: raw.date, tags: raw.tags, companyUrl: raw.companyUrl,
            activity: raw.activity, searchKeyword: kw,
          });
          newCount++;
        }

        console.log(`  去重后新增: ${newCount} 条 (全局累计: ${allProcessedJobs.length} 条)`);
        kwSummary.push({ keyword: kw, raw: rawJobs.length, new: newCount });

        // 增量保存（防止中途崩溃丢数据）
        generateBatchJSON(allProcessedJobs, keywords, config.city, outputDir);

        // 关键词间延迟
        if (ki < keywords.length - 1) {
          const delaySec = config.delay + Math.random() * 3;
          console.log(`  等待 ${delaySec.toFixed(1)} 秒...`);
          await new Promise((r) => setTimeout(r, delaySec * 1000));
        }
      }
    } finally {
      await browser.close();
    }

    // 城市过滤
    if (config.city) {
      const cityLower = config.city.toLowerCase();
      allProcessedJobs = allProcessedJobs.filter((j) =>
        j.city.toLowerCase().includes(cityLower) || cityLower.includes(j.city.toLowerCase())
      );
      console.log(`\n按城市"${config.city}"过滤后: ${allProcessedJobs.length} 条`);
    }

    console.log('\n========================================');
    console.log('  批量爬取完成');
    console.log('========================================');
    console.log(`  总岗位数: ${allProcessedJobs.length}`);
    console.log('\n  关键词统计:');
    kwSummary.forEach((s) => {
      console.log(`    ${s.keyword}: 原始${s.raw}条 → 新增${s.new}条`);
    });
    console.log('========================================\n');

    if (allProcessedJobs.length === 0) {
      console.log('未获取到任何数据。');
      process.exit(0);
    }

    // 最终输出
    generateBatchJSON(allProcessedJobs, keywords, config.city, outputDir);
    generateBatchHTML(allProcessedJobs, keywords, config.city, outputDir);

    // 统计预览
    const stats = computeStats(allProcessedJobs);
    console.log(`时薪统计: 均值 ${stats.mean?.toFixed(1)} | 中位数 ${stats.median?.toFixed(1)} | 范围 ${stats.min?.toFixed(1)}~${stats.max?.toFixed(1)} (${stats.count}条有效)`);
    console.log('\n✓ 批量爬取完成！');
    return;
  }

  // ===================== 单关键词模式 =====================
  console.log('========================================');
  console.log('  鱼泡网时薪爬取脚本');
  console.log('========================================');
  console.log(`  关键词: ${config.keyword}`);
  console.log(`  城市: ${config.city || '全国(不过滤)'}`);
  console.log(`  最大加载次数: ${config.maxPages}`);
  console.log('========================================\n');

  const { browser, context } = await createBrowser();
  let allRawJobs = [];

  try {
    console.log('正在打开鱼泡网首页建立会话...');
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    await page.goto('https://m.yupao.com/', { waitUntil: 'commit', timeout: 60000 });
    await page.waitForTimeout(3000);

    const searchUrl = `https://m.yupao.com/topic/a1?keywords=${encodeURIComponent(config.keyword)}`;
    console.log(`正在打开搜索页面...`);
    await page.goto(searchUrl, { waitUntil: 'commit', timeout: 60000 });

    const verified = await handleVerificationPage(page);
    if (!verified) console.log('安全验证未通过，继续尝试提取已有内容...');

    await page.waitForSelector('[class*="card___"]', { timeout: 45000 });
    console.log('页面加载完成，开始提取数据...\n');

    let rawJobs = await extractRawJobs(page);
    allRawJobs = rawJobs;
    console.log(`第 1 轮: 提取到 ${rawJobs.length} 条，累计 ${allRawJobs.length} 条`);

    for (let round = 2; round <= config.maxPages; round++) {
      const prevCount = allRawJobs.length;
      console.log(`\n正在执行第 ${round} 轮上拉加载...`);
      await swipeUpToLoadMore(page);
      rawJobs = await extractRawJobs(page);
      allRawJobs = rawJobs;
      const newCount = allRawJobs.length - prevCount;
      console.log(`第 ${round} 轮: 累计 ${allRawJobs.length} 条，本轮新增 ${newCount} 条`);

      const canLoadMore = await hasLoadMore(page);
      if (!canLoadMore && newCount === 0) { console.log('没有更多数据了，停止加载。'); break; }
      if (newCount === 0) { console.log('本轮无新数据，停止加载。'); break; }
    }
    await page.close();
  } catch (err) {
    if (allRawJobs.length === 0) { console.error('爬取失败:', err.message); await browser.close(); process.exit(1); }
    else { console.warn('爬取过程中出现错误（已有部分数据）:', err.message); }
  }

  await browser.close();

  console.log(`\n========================================`);
  console.log(`原始数据共 ${allRawJobs.length} 条`);

  let jobs = processJobs(allRawJobs);
  console.log(`去重后 ${jobs.length} 条`);

  if (config.city) {
    const cityLower = config.city.toLowerCase();
    jobs = jobs.filter((j) => j.city.toLowerCase().includes(cityLower) || cityLower.includes(j.city.toLowerCase()));
    console.log(`按城市"${config.city}"过滤后 ${jobs.length} 条`);
  }
  console.log(`========================================\n`);

  if (jobs.length === 0) { console.log('未获取到任何岗位数据。'); process.exit(0); }

  console.log('数据预览（前5条）:');
  console.log('----------------------------------------');
  jobs.slice(0, 5).forEach((job, i) => {
    console.log(`${i + 1}. ${job.title} | ${job.company} | ${job.city}`);
    console.log(`   薪资: ${job.salaryRaw} → ${formatHourlyWage(job.hourlyWage)} | ${job.date}`);
  });
  console.log('----------------------------------------\n');

  generateJSON(config.keyword, config.city, jobs, outputDir);
  generateHTML(config.keyword, config.city, jobs, outputDir);
  console.log('\n✓ 完成！');
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});
