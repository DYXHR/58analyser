/**
 * 58同城产线工人时薪爬取脚本
 * 使用 Playwright 爬取 m.58.com 招聘列表，提取薪资并换算为时薪
 * 输出 JSON 数据文件 + HTML 可视化报告
 *
 * 用法:
 *   node scrape-58.js                                       # 默认爬深圳普工/技工分类前3页
 *   node scrape-58.js --city 北京 --max-pages 5              # 指定城市和页数
 *   node scrape-58.js --city 深圳 --category zpshengchankaifa --max-pages 5
 *   node scrape-58.js --keyword 产线                        # 本地过滤岗位标题包含"产线"的
 *   node scrape-58.js --batch                               # 批量模式：15城市×3分类×10页
 */

import { chromium } from 'playwright';
import { parseWage, toHourlyWage, formatWage } from './wage-parser.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 城市名映射：中文城市名 → 58同城城市代码
// ============================================================
const CITY_MAP = {
  '深圳': 'sz', '北京': 'bj', '上海': 'sh', '广州': 'gz',
  '东莞': 'dg', '苏州': 'su', '杭州': 'hz', '成都': 'cd',
  '武汉': 'wh', '西安': 'xa', '南京': 'nj', '天津': 'tj',
  '重庆': 'cq', '佛山': 'fs', '郑州': 'zz',
  // 补充城市
  '青岛': 'qd', '沈阳': 'sy', '长沙': 'cs', '宁波': 'nb',
  '无锡': 'wx', '厦门': 'xm', '大连': 'dl', '福州': 'fz',
  '泉州': 'qz', '常州': 'cz', '惠州': 'hz2', '温州': 'wz',
};

// 城市代码 → 中文名（反查用）
const CITY_CODE_MAP = Object.fromEntries(
  Object.entries(CITY_MAP).map(([name, code]) => [code, name])
);

// ============================================================
// 分类映射：中文分类名 → 58同城分类代码
// ============================================================
const CATEGORY_MAP = {
  '普工': 'zpshengchankaifa',
  '技工': 'zpshengchankaifa',
  '物流仓储': 'zpwuliucangchu',
  '生产管理': 'zpshengchan',
};

// 分类代码 → 中文名（用于显示）
const CATEGORY_CODE_MAP = {
  'zpshengchankaifa': '普工/技工',
  'zpwuliucangchu': '物流仓储',
  'zpshengchan': '生产管理',
};

// 批量模式默认分类列表
const DEFAULT_CATEGORIES = ['zpshengchankaifa', 'zpwuliucangchu', 'zpshengchan'];

// ============================================================
// 命令行参数解析
// ============================================================
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    city: '深圳',
    category: 'zpshengchankaifa',
    maxPages: 3,
    keyword: null,
    batch: false,
    delay: 3,
    cities: null,    // 自定义城市列表（逗号分隔）
    append: false,   // 追加模式：加载已有数据后继续爬取
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--city' || arg === '-c') {
      config.city = args[++i];
    } else if (arg === '--category' || arg === '-cat') {
      config.category = args[++i];
    } else if (arg === '--max-pages' || arg === '-m') {
      config.maxPages = parseInt(args[++i], 10) || 3;
    } else if (arg === '--keyword' || arg === '-k') {
      config.keyword = args[++i];
    } else if (arg === '--batch' || arg === '-b') {
      config.batch = true;
      if (config.maxPages === 3) config.maxPages = 15; // 批量模式默认15页
    } else if (arg === '--delay' || arg === '-d') {
      config.delay = parseInt(args[++i], 10) || 3;
    } else if (arg === '--cities') {
      config.cities = args[++i];
    } else if (arg === '--append') {
      config.append = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`用法: node scrape-58.js [选项]

单城市模式:
  --city, -c <城市>          城市名（中文或代码），默认"深圳"
  --category, -cat <分类>    分类代码或中文名，默认"zpshengchankaifa"（普工/技工）
  --max-pages, -m <页数>     最大页数，默认3
  --keyword, -k <关键词>     本地过滤岗位标题关键词，可选

批量模式:
  --batch, -b                批量模式：15城市×3分类×10页
  --max-pages, -m <页数>     每个城市+分类爬取页数（批量默认10）
  --delay, -d <秒>           批量模式请求间延迟秒数，默认3

示例:
  node scrape-58.js
  node scrape-58.js --city 北京 --max-pages 5
  node scrape-58.js --city 深圳 --category 普工 --max-pages 5
  node scrape-58.js --keyword 产线
  node scrape-58.js --batch --delay 5`);
      process.exit(0);
    }
  }
  return config;
}

// ============================================================
// 解析城市名/代码为标准城市代码
// ============================================================
function resolveCityCode(input) {
  if (!input) return 'sz';
  // 如果直接是城市代码
  if (CITY_CODE_MAP[input]) return input;
  // 中文城市名
  if (CITY_MAP[input]) return CITY_MAP[input];
  // 未知，原样返回
  return input;
}

// ============================================================
// 解析分类名/代码为标准分类代码
// ============================================================
function resolveCategoryCode(input) {
  if (!input) return 'zpshengchankaifa';
  // 如果直接是分类代码
  if (CATEGORY_CODE_MAP[input]) return input;
  // 中文分类名
  if (CATEGORY_MAP[input]) return CATEGORY_MAP[input];
  // 未知，原样返回
  return input;
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
// 按分类分组统计（批量模式用）
// ============================================================
function computeCategoryStats(jobs) {
  const catMap = new Map();
  for (const job of jobs) {
    const cat = job.searchKeyword || '未知';
    if (!catMap.has(cat)) {
      catMap.set(cat, { category: cat, wages: [], count: 0 });
    }
    const entry = catMap.get(cat);
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
  for (const [, entry] of catMap) {
    if (entry.wages.length > 0) {
      const avg = entry.wages.reduce((a, b) => a + b, 0) / entry.wages.length;
      result.push({ category: entry.category, avgWage: avg, count: entry.count });
    } else {
      result.push({ category: entry.category, avgWage: null, count: entry.count });
    }
  }
  result.sort((a, b) => (b.avgWage || 0) - (a.avgWage || 0));
  return result;
}

// ============================================================
// 创建浏览器上下文（移动端UA + 隐藏自动化特征）
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
// 检测页面是否被重定向到验证页或登录页
// @returns {Promise<boolean>} true=页面正常，false=被重定向
// ============================================================
async function checkPageNormal(page) {
  const url = page.url();
  // 检测验证页/登录页特征
  if (url.includes('verify') || url.includes('login') || url.includes('captcha')) {
    return false;
  }
  // 检测页面标题中是否包含验证相关字样
  const title = await page.title().catch(() => '');
  if (title.includes('验证') || title.includes('人机验证') || title.includes('登录')) {
    return false;
  }
  return true;
}

// ============================================================
// 从当前页面提取列表项数据（在浏览器上下文中执行）
// ============================================================
async function extractRawJobs(page, cityCode, categoryCode) {
  return await page.evaluate((ctx) => {
    const jobs = [];
    const items = document.querySelectorAll('a.list-item-a');

    items.forEach((item) => {
      try {
        // 岗位标题
        const titleEl = item.querySelector('.info-title');
        const title = titleEl ? titleEl.innerText.trim() : '';

        // 薪资文本
        const salaryEl = item.querySelector('.info-salary');
        const salaryRaw = salaryEl ? salaryEl.innerText.trim() : '';

        // 地区
        const districtEl = item.querySelector('.local_quXianName');
        const district = districtEl ? districtEl.innerText.trim() : '';

        // 职位类别
        const jobCategoryEl = item.querySelector('.info-job');
        const jobCategory = jobCategoryEl ? jobCategoryEl.innerText.trim() : '';

        // 福利标签（多个）
        const tagEls = item.querySelectorAll('.info-tag');
        const tags = Array.from(tagEls)
          .map((el) => el.innerText.trim())
          .filter(Boolean);

        // 联系人
        const employerEl = item.querySelector('.employer');
        const contact = employerEl ? employerEl.innerText.trim() : '';

        // 公司名称
        const companyEl = item.querySelector('.company');
        const company = companyEl ? companyEl.innerText.trim() : '';

        // 详情页链接
        let detailUrl = item.href || '';
        if (detailUrl && !detailUrl.startsWith('http')) {
          detailUrl = 'https:' + (detailUrl.startsWith('//') ? '' : '//') + detailUrl;
        }

        if (!title && !salaryRaw) return; // 跳过空项

        jobs.push({
          title,
          salaryRaw,
          company,
          contact,
          cityCode: ctx.cityCode,
          categoryCode: ctx.categoryCode,
          district,
          jobCategory,
          tags,
          detailUrl,
        });
      } catch (e) {
        // 跳过解析失败的项
      }
    });
    return jobs;
  }, { cityCode, categoryCode });
}

// ============================================================
// 处理原始数据：薪资解析、时薪换算、城市名反查
// ============================================================
function processJobs(rawJobs) {
  const processed = [];
  for (const raw of rawJobs) {
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

    // 城市名反查
    const cityName = CITY_CODE_MAP[raw.cityCode] || raw.cityCode || '未知';
    // 分类名反查
    const categoryName = CATEGORY_CODE_MAP[raw.categoryCode] || raw.categoryCode || '未知';

    processed.push({
      title: raw.title,
      salaryRaw: raw.salaryRaw,
      salaryParsed,
      hourlyWage,
      hourlyWageDisplay,
      company: raw.company,
      contact: raw.contact,
      city: cityName,
      district: raw.district,
      jobCategory: raw.jobCategory,
      tags: raw.tags,
      detailUrl: raw.detailUrl,
      source: '58同城',
      searchKeyword: categoryName,
    });
  }
  return processed;
}

// ============================================================
// 爬取指定城市+分类的所有岗位数据
// @returns {Promise<Array>} 处理后的岗位列表
// ============================================================
async function scrapeCityCategory(context, cityCode, categoryCode, maxPages, delaySec) {
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  let allRawJobs = [];
  const cityName = CITY_CODE_MAP[cityCode] || cityCode;
  const categoryName = CATEGORY_CODE_MAP[categoryCode] || categoryCode;

  try {
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      // 构建URL：第1页不带pn，第2页开始带pn
      const url = pageNum === 1
        ? `https://m.58.com/${cityCode}/${categoryCode}/`
        : `https://m.58.com/${cityCode}/${categoryCode}/pn${pageNum}/`;

      console.log(`  正在爬取: ${cityName}/${categoryName} 第${pageNum}页`);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // 等待列表项加载
        await page.waitForTimeout(1500 + Math.random() * 1000);

        // 检测页面是否正常
        const isNormal = await checkPageNormal(page);
        if (!isNormal) {
          console.log(`  ⚠ 页面被重定向到验证页/登录页，停止该城市+分类的爬取`);
          break;
        }

        // 检查是否有列表项
        const itemCount = await page.evaluate(() => {
          return document.querySelectorAll('a.list-item-a').length;
        });

        if (itemCount === 0) {
          console.log(`  第${pageNum}页无列表项，已到末尾或被限制，停止`);
          break;
        }

        // 提取数据
        const rawJobs = await extractRawJobs(page, cityCode, categoryCode);
        console.log(`  第${pageNum}页: 提取到 ${rawJobs.length} 条`);
        allRawJobs = allRawJobs.concat(rawJobs);

        // 翻页间延迟
        if (pageNum < maxPages) {
          const waitSec = delaySec + Math.random() * 1.5;
          await page.waitForTimeout(waitSec * 1000);
        }
      } catch (err) {
        console.warn(`  第${pageNum}页爬取出错: ${err.message}`);
        // 出错后等待更长时间再继续
        await page.waitForTimeout(3000);
        break;
      }
    }
  } finally {
    await page.close();
  }

  console.log(`  ${cityName}/${categoryName} 共获取 ${allRawJobs.length} 条原始数据`);
  return processJobs(allRawJobs);
}

// ============================================================
// JSON 输出（单城市模式）
// ============================================================
function generateJSON(city, category, jobs, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const safeCity = city.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const safeCategory = category.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const filename = `wages-58-${safeCity}-${safeCategory}-${dateStr}.json`;
  const filepath = path.join(outputDir, filename);

  const data = {
    city,
    category,
    scrapeDate: dateStr,
    totalJobs: jobs.length,
    jobs,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`✓ JSON 数据已保存: ${filepath}`);
  return filepath;
}

// ============================================================
// HTML 报告生成（单城市模式）
// ============================================================
function generateHTML(city, category, jobs, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const safeCity = city.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const safeCategory = category.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  const filename = `report-58-${safeCity}-${safeCategory}-${dateStr}.html`;
  const filepath = path.join(outputDir, filename);

  const stats = computeStats(jobs);
  const fmtStat = (v) => (v !== null ? v.toFixed(1) + ' 元/时' : '-');

  const statsCards = `
    <div class="stat-card">
      <div class="stat-label">总岗位数</div>
      <div class="stat-value">${jobs.length}</div>
      <div class="stat-sub">${escapeHtml(city)} · ${escapeHtml(category)}</div>
    </div>
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
      <div class="stat-label">时薪范围</div>
      <div class="stat-value" style="font-size:18px">${fmtStat(stats.min)} ~ ${fmtStat(stats.max)}</div>
      <div class="stat-sub">最低 ~ 最高</div>
    </div>`;

  // 岗位表格行
  const tableRows = jobs
    .map((job, i) => {
      const sortVal = getHourlyWageSortValue(job.hourlyWage);
      const hourlyStr = formatHourlyWage(job.hourlyWage);
      const tagsStr = job.tags.length > 0
        ? job.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')
        : '';
      const companyLink = job.detailUrl
        ? `<a href="${escapeHtml(job.detailUrl)}" target="_blank">${escapeHtml(job.company)}</a>`
        : escapeHtml(job.company);
      return `
      <tr data-sort-idx="${i}">
        <td>${escapeHtml(job.title)}</td>
        <td>${companyLink}</td>
        <td>${escapeHtml(job.district)}</td>
        <td>${escapeHtml(job.jobCategory)}</td>
        <td>${escapeHtml(job.salaryRaw)}</td>
        <td data-sort-num="${sortVal}">${escapeHtml(hourlyStr)}</td>
        <td>${escapeHtml(job.contact)}</td>
        <td>${tagsStr}</td>
      </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>58同城时薪报告 - ${escapeHtml(city)} - ${dateStr}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f5f7fa;
    color: #333;
    line-height: 1.6;
  }
  .header {
    background: linear-gradient(135deg, #ff6a00, #d32f2f);
    color: #fff;
    padding: 32px 24px;
    text-align: center;
  }
  .header h1 { font-size: 24px; margin-bottom: 8px; }
  .header .meta { font-size: 14px; opacity: 0.9; }
  .header .meta span { margin: 0 12px; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px 16px; }

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
  .stat-value { font-size: 28px; font-weight: 700; color: #ff6a00; }
  .stat-sub { font-size: 12px; color: #aaa; margin-top: 4px; }

  .section { margin-bottom: 32px; }
  .section-title {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
    padding-left: 12px;
    border-left: 4px solid #ff6a00;
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
  thead { background: #fff3e0; }
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
  th:hover { background: #ffe0b2; }
  th.sort-asc::after { content: " ▲"; font-size: 11px; color: #ff6a00; }
  th.sort-desc::after { content: " ▼"; font-size: 11px; color: #ff6a00; }
  td {
    padding: 10px 14px;
    border-bottom: 1px solid #f0f0f0;
    vertical-align: top;
  }
  tbody tr:hover { background: #fff8f0; }
  tbody tr:nth-child(even) { background: #fcfcfe; }
  tbody tr:nth-child(even):hover { background: #fff8f0; }

  .tag {
    display: inline-block;
    background: #fff3e0;
    color: #e65100;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 12px;
    margin: 2px;
    white-space: nowrap;
  }

  td a { color: #ff6a00; text-decoration: none; }
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
    <h1>58同城时薪数据报告</h1>
    <div class="meta">
      <span>城市: ${escapeHtml(city)}</span>
      <span>分类: ${escapeHtml(category)}</span>
      <span>日期: ${dateStr}</span>
      <span>岗位总数: ${jobs.length}</span>
    </div>
  </div>

  <div class="container">
    <div class="stats-grid">${statsCards}</div>

    <div class="section">
      <div class="section-title">岗位列表（点击列头排序）</div>
      <div class="table-wrapper">
        <table id="jobsTable">
          <thead>
            <tr>
              <th data-col="0" data-type="text">岗位标题</th>
              <th data-col="1" data-type="text">公司</th>
              <th data-col="2" data-type="text">地区</th>
              <th data-col="3" data-type="text">职位类别</th>
              <th data-col="4" data-type="text">薪资原文</th>
              <th data-col="5" data-type="num">换算时薪</th>
              <th data-col="6" data-type="text">联系人</th>
              <th data-col="7" data-type="text">标签</th>
            </tr>
          </thead>
          <tbody id="jobsBody">${tableRows}</tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="footer">
    数据来源: 58同城 m.58.com · 生成时间: ${today.toLocaleString('zh-CN')}
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
// 批量模式：生成合并的 JSON
// ============================================================
function generateBatchJSON(allJobs, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const filename = `wages-58-batch-${dateStr}.json`;
  const filepath = path.join(outputDir, filename);

  const data = {
    scrapeDate: dateStr,
    totalJobs: allJobs.length,
    cities: Object.keys(CITY_MAP).length,
    categories: DEFAULT_CATEGORIES.length,
    jobs: allJobs,
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`✓ 批量JSON已保存: ${filepath} (${allJobs.length} 条)`);
  return filepath;
}

// ============================================================
// 批量模式：生成合并的 HTML 报告
// ============================================================
function generateBatchHTML(allJobs, outputDir) {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const filename = `report-58-batch-${dateStr}.html`;
  const filepath = path.join(outputDir, filename);

  const stats = computeStats(allJobs);
  const cityStats = computeCityStats(allJobs);
  const catStats = computeCategoryStats(allJobs);
  const maxCityWage = Math.max(...cityStats.map((c) => c.avgWage || 0), 1);

  const fmtStat = (v) => (v !== null ? v.toFixed(1) + ' 元/时' : '-');

  const statsCards = `
    <div class="stat-card"><div class="stat-label">总岗位数</div><div class="stat-value">${allJobs.length}</div><div class="stat-sub">${Object.keys(CITY_MAP).length}城市 × ${DEFAULT_CATEGORIES.length}分类</div></div>
    <div class="stat-card"><div class="stat-label">时薪均值</div><div class="stat-value">${fmtStat(stats.mean)}</div><div class="stat-sub">${stats.count} 条有效</div></div>
    <div class="stat-card"><div class="stat-label">时薪中位数</div><div class="stat-value">${fmtStat(stats.median)}</div><div class="stat-sub">50% 分位</div></div>
    <div class="stat-card"><div class="stat-label">时薪范围</div><div class="stat-value" style="font-size:18px">${fmtStat(stats.min)} ~ ${fmtStat(stats.max)}</div><div class="stat-sub">最低 ~ 最高</div></div>`;

  const cityRows = cityStats.map((c) => {
    const pct = c.avgWage ? (c.avgWage / maxCityWage) * 100 : 0;
    return `<tr><td class="city-name">${escapeHtml(c.city)}</td><td>${c.count}</td><td class="wage-cell">${c.avgWage !== null ? c.avgWage.toFixed(1) + ' 元/时' : '-'}</td><td class="bar-cell"><div class="bar" style="width:${pct}%"></div></td></tr>`;
  }).join('');

  const catRows = catStats.map((c) => `
    <tr><td>${escapeHtml(c.category)}</td><td>${c.count}</td><td class="wage-cell">${c.avgWage !== null ? c.avgWage.toFixed(1) + ' 元/时' : '-'}</td></tr>
  `).join('');

  const tableRows = allJobs.map((job, i) => {
    const sortVal = getHourlyWageSortValue(job.hourlyWage);
    const hourlyStr = formatHourlyWage(job.hourlyWage);
    const tagsStr = job.tags.length > 0 ? job.tags.slice(0, 4).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('') : '';
    const companyLink = job.detailUrl ? `<a href="${escapeHtml(job.detailUrl)}" target="_blank">${escapeHtml(job.company)}</a>` : escapeHtml(job.company);
    return `<tr data-sort-idx="${i}"><td>${escapeHtml(job.title)}</td><td>${companyLink}</td><td>${escapeHtml(job.city)}</td><td>${escapeHtml(job.district)}</td><td>${escapeHtml(job.salaryRaw)}</td><td data-sort-num="${sortVal}">${escapeHtml(hourlyStr)}</td><td><span class="kw-tag">${escapeHtml(job.searchKeyword || '')}</span></td><td>${tagsStr}</td></tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>58同城批量时薪报告 - ${dateStr}</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, "Microsoft YaHei", sans-serif; background: #f5f7fa; color: #333; line-height: 1.6; }
.header { background: linear-gradient(135deg, #ff6a00, #d32f2f); color: #fff; padding: 32px 24px; text-align: center; }
.header h1 { font-size: 24px; margin-bottom: 8px; } .header .meta { font-size: 14px; opacity: 0.9; } .header .meta span { margin: 0 12px; }
.container { max-width: 1400px; margin: 0 auto; padding: 24px 16px; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
.stat-card { background: #fff; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.stat-label { font-size: 13px; color: #888; margin-bottom: 8px; } .stat-value { font-size: 28px; font-weight: 700; color: #ff6a00; } .stat-sub { font-size: 12px; color: #aaa; margin-top: 4px; }
.section { margin-bottom: 32px; } .section-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; padding-left: 12px; border-left: 4px solid #ff6a00; }
.dual-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
@media (max-width: 768px) { .dual-grid { grid-template-columns: 1fr; } }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); font-size: 13px; }
thead { background: #fff3e0; } th { padding: 12px 14px; text-align: left; font-weight: 600; color: #555; cursor: pointer; user-select: none; white-space: nowrap; }
th:hover { background: #ffe0b2; } th.sort-asc::after { content: " ▲"; font-size: 11px; color: #ff6a00; } th.sort-desc::after { content: " ▼"; font-size: 11px; color: #ff6a00; }
td { padding: 8px 12px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
tbody tr:hover { background: #fff8f0; } tbody tr:nth-child(even) { background: #fcfcfe; }
.city-name { font-weight: 600; } .wage-cell { font-weight: 600; color: #ff6a00; white-space: nowrap; }
.bar-cell { width: 150px; } .bar { height: 20px; background: linear-gradient(90deg, #ffb74d, #ff6a00); border-radius: 4px; min-width: 2px; }
.tag { display: inline-block; background: #fff3e0; color: #e65100; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin: 1px; white-space: nowrap; }
.kw-tag { display: inline-block; background: #e3f2fd; color: #1565c0; padding: 2px 6px; border-radius: 4px; font-size: 11px; white-space: nowrap; }
td a { color: #ff6a00; text-decoration: none; } td a:hover { text-decoration: underline; }
.table-wrapper { overflow-x: auto; max-height: 800px; overflow-y: auto; }
.footer { text-align: center; padding: 24px; color: #aaa; font-size: 13px; }
</style></head>
<body>
<div class="header"><h1>58同城批量时薪数据报告</h1>
<div class="meta"><span>15城市 × 3分类</span><span>日期: ${dateStr}</span><span>岗位总数: ${allJobs.length}</span></div></div>
<div class="container">
  <div class="stats-grid">${statsCards}</div>
  <div class="dual-grid">
    <div class="section"><div class="section-title">按城市分组</div><div class="table-wrapper"><table><thead><tr><th>城市</th><th>岗位数</th><th>平均时薪</th><th>占比</th></tr></thead><tbody>${cityRows}</tbody></table></div></div>
    <div class="section"><div class="section-title">按分类分组</div><div class="table-wrapper"><table><thead><tr><th>分类</th><th>岗位数</th><th>平均时薪</th></tr></thead><tbody>${catRows}</tbody></table></div></div>
  </div>
  <div class="section"><div class="section-title">全部岗位列表（点击列头排序）</div><div class="table-wrapper"><table id="jobsTable"><thead><tr><th data-col="0" data-type="text">岗位标题</th><th data-col="1" data-type="text">公司</th><th data-col="2" data-type="text">城市</th><th data-col="3" data-type="text">地区</th><th data-col="4" data-type="text">薪资原文</th><th data-col="5" data-type="num">换算时薪</th><th data-col="6" data-type="text">来源分类</th><th data-col="7" data-type="text">标签</th></tr></thead><tbody id="jobsBody">${tableRows}</tbody></table></div></div>
</div>
<div class="footer">数据来源: 58同城 m.58.com · 生成时间: ${today.toLocaleString('zh-CN')}</div>
<script>(function(){var sC=-1,sD=1;var hs=document.querySelectorAll('#jobsTable th');hs.forEach(function(th){th.addEventListener('click',function(){var c=parseInt(th.dataset.col),t=th.dataset.type;if(sC===c){sD=-sD}else{sC=c;sD=1}hs.forEach(function(h){h.classList.remove('sort-asc','sort-desc')});th.classList.add(sD===1?'sort-asc':'sort-desc');var tb=document.getElementById('jobsBody'),rs=Array.from(tb.querySelectorAll('tr'));rs.sort(function(a,b){var ca=a.children[c],cb=b.children[c],va,vb;if(t==='num'){va=parseFloat(ca.dataset.sortNum)||-1;vb=parseFloat(cb.dataset.sortNum)||-1}else{va=ca.textContent.trim();vb=cb.textContent.trim()}if(va<vb)return -1*sD;if(va>vb)return 1*sD;return 0});rs.forEach(function(r){tb.appendChild(r)})})})})();</script>
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

  const outputDir = path.join(__dirname, 'scrape-58-data');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // ===================== 批量模式 =====================
  if (config.batch) {
    // 确定要爬取的城市列表
    let cityCodes;
    if (config.cities) {
      // 自定义城市列表
      const cityNames = config.cities.split(',').map((s) => s.trim()).filter(Boolean);
      cityCodes = cityNames.map((name) => CITY_MAP[name]).filter(Boolean);
      if (cityCodes.length === 0) {
        console.error('错误: 未找到匹配的城市代码，请检查城市名称');
        process.exit(1);
      }
    } else {
      cityCodes = Object.values(CITY_MAP);
    }
    const categories = DEFAULT_CATEGORIES;

    // 追加模式：加载已有数据
    const globalDedup = new Set();
    let allProcessedJobs = [];
    const summary = [];
    const today = new Date().toISOString().slice(0, 10);
    const batchJsonPath = path.join(outputDir, `wages-58-batch-${today}.json`);

    if (config.append && fs.existsSync(batchJsonPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(batchJsonPath, 'utf-8'));
        allProcessedJobs = existing.jobs || [];
        for (const job of allProcessedJobs) {
          const key = job.detailUrl || `${job.title}|${job.company}|${job.district}`;
          globalDedup.add(key);
        }
        console.log(`✓ 追加模式: 已加载 ${allProcessedJobs.length} 条历史数据`);
      } catch (e) {
        console.warn(`加载历史数据失败: ${e.message}，将从头开始`);
      }
    }

    console.log('========================================');
    console.log('  58同城批量时薪爬取');
    console.log('========================================');
    console.log(`  城市数: ${cityCodes.length}`);
    console.log(`  分类数: ${categories.length}`);
    console.log(`  每个城市+分类爬取: ${config.maxPages} 页`);
    console.log(`  请求间延迟: ${config.delay} 秒`);
    console.log(`  已有数据: ${allProcessedJobs.length} 条`);
    console.log('========================================\n');

    const { browser, context } = await createBrowser();

    try {
      for (let ci = 0; ci < cityCodes.length; ci++) {
        const cityCode = cityCodes[ci];
        const cityName = CITY_CODE_MAP[cityCode];

        for (let cati = 0; cati < categories.length; cati++) {
          const categoryCode = categories[cati];
          const categoryName = CATEGORY_CODE_MAP[categoryCode];

          const taskIdx = ci * categories.length + cati + 1;
          const totalTasks = cityCodes.length * categories.length;
          console.log(`\n[${taskIdx}/${totalTasks}] ${cityName} / ${categoryName}`);
          console.log('----------------------------------------');

          const jobs = await scrapeCityCategory(
            context, cityCode, categoryCode, config.maxPages, config.delay
          );

          // 跨城市+跨分类去重（以 detailUrl 为唯一标识）
          let newCount = 0;
          for (const job of jobs) {
            const dedupeKey = job.detailUrl || `${job.title}|${job.company}|${job.district}`;
            if (globalDedup.has(dedupeKey)) continue;
            globalDedup.add(dedupeKey);
            allProcessedJobs.push(job);
            newCount++;
          }

          console.log(`  去重后新增: ${newCount} 条 (全局累计: ${allProcessedJobs.length} 条)`);
          summary.push({
            city: cityName, category: categoryName,
            raw: jobs.length, new: newCount,
          });

          // 增量保存（防止中途崩溃丢数据）
          generateBatchJSON(allProcessedJobs, outputDir);

          // 城市+分类间延迟
          if (taskIdx < totalTasks) {
            const delaySec = config.delay + Math.random() * 2;
            console.log(`  等待 ${delaySec.toFixed(1)} 秒...`);
            await new Promise((r) => setTimeout(r, delaySec * 1000));
          }
        }
      }
    } finally {
      await browser.close();
    }

    console.log('\n========================================');
    console.log('  批量爬取完成');
    console.log('========================================');
    console.log(`  总岗位数: ${allProcessedJobs.length}`);

    // 关键词过滤
    if (config.keyword) {
      const kw = config.keyword.toLowerCase();
      allProcessedJobs = allProcessedJobs.filter((j) =>
        j.title.toLowerCase().includes(kw)
      );
      console.log(`  按标题关键词"${config.keyword}"过滤后: ${allProcessedJobs.length} 条`);
    }

    console.log('\n  分类统计:');
    summary.forEach((s) => {
      console.log(`    ${s.city}/${s.category}: 原始${s.raw}条 → 新增${s.new}条`);
    });
    console.log('========================================\n');

    if (allProcessedJobs.length === 0) {
      console.log('未获取到任何数据。');
      process.exit(0);
    }

    // 最终输出
    generateBatchJSON(allProcessedJobs, outputDir);
    generateBatchHTML(allProcessedJobs, outputDir);

    // 统计预览
    const stats = computeStats(allProcessedJobs);
    console.log(`时薪统计: 均值 ${stats.mean?.toFixed(1)} | 中位数 ${stats.median?.toFixed(1)} | 范围 ${stats.min?.toFixed(1)}~${stats.max?.toFixed(1)} (${stats.count}条有效)`);
    console.log('\n✓ 批量爬取完成！');
    return;
  }

  // ===================== 单城市模式 =====================
  const cityCode = resolveCityCode(config.city);
  const categoryCode = resolveCategoryCode(config.category);
  const cityName = CITY_CODE_MAP[cityCode] || config.city;
  const categoryName = CATEGORY_CODE_MAP[categoryCode] || config.category;

  console.log('========================================');
  console.log('  58同城时薪爬取脚本');
  console.log('========================================');
  console.log(`  城市: ${cityName} (${cityCode})`);
  console.log(`  分类: ${categoryName} (${categoryCode})`);
  console.log(`  最大页数: ${config.maxPages}`);
  console.log(`  标题关键词: ${config.keyword || '不过滤'}`);
  console.log('========================================\n');

  const { browser, context } = await createBrowser();
  let jobs = [];

  try {
    jobs = await scrapeCityCategory(
      context, cityCode, categoryCode, config.maxPages, config.delay
    );
  } catch (err) {
    console.error('爬取失败:', err.message);
  } finally {
    await browser.close();
  }

  console.log(`\n========================================`);
  console.log(`处理后的岗位数据共 ${jobs.length} 条`);

  // 标题关键词过滤
  if (config.keyword) {
    const kw = config.keyword.toLowerCase();
    jobs = jobs.filter((j) => j.title.toLowerCase().includes(kw));
    console.log(`按标题关键词"${config.keyword}"过滤后 ${jobs.length} 条`);
  }
  console.log(`========================================\n`);

  if (jobs.length === 0) {
    console.log('未获取到任何岗位数据。');
    process.exit(0);
  }

  console.log('数据预览（前5条）:');
  console.log('----------------------------------------');
  jobs.slice(0, 5).forEach((job, i) => {
    console.log(`${i + 1}. ${job.title} | ${job.company} | ${job.district}`);
    console.log(`   薪资: ${job.salaryRaw} → ${formatHourlyWage(job.hourlyWage)} | 联系人: ${job.contact}`);
  });
  console.log('----------------------------------------\n');

  generateJSON(cityName, categoryName, jobs, outputDir);
  generateHTML(cityName, categoryName, jobs, outputDir);

  // 统计预览
  const stats = computeStats(jobs);
  console.log(`时薪统计: 均值 ${stats.mean?.toFixed(1)} | 中位数 ${stats.median?.toFixed(1)} | 范围 ${stats.min?.toFixed(1)}~${stats.max?.toFixed(1)} (${stats.count}条有效)`);
  console.log('\n✓ 完成！');
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});
