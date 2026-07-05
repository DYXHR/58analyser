/**
 * 58同城发布时间补充脚本
 * 读取已有批量数据，逐个访问详情页提取发布时间，更新JSON和HTML
 *
 * 用法:
 *   node supplement-58-date.js                    # 补充全部（从上次断点继续）
 *   node supplement-58-date.js --limit 50        # 只处理前50条（测试用）
 *   node supplement-58-date.js --concurrency 3   # 并发数（默认3）
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FILE = path.join(__dirname, 'scrape-58-data', 'wages-58-batch-2026-07-05.json');
const PROGRESS_FILE = path.join(__dirname, 'scrape-58-data', 'supplement-progress.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { limit: 0, concurrency: 3, delay: 1500 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') config.limit = parseInt(args[++i], 10) || 0;
    else if (args[i] === '--concurrency') config.concurrency = parseInt(args[++i], 10) || 3;
    else if (args[i] === '--delay') config.delay = parseInt(args[++i], 10) || 1500;
  }
  return config;
}

async function createBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
    isMobile: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    window.chrome = { runtime: {} };
  });
  return { browser, context };
}

/**
 * 从详情页提取发布时间
 * 58同城详情页的发布时间在 span.companyCommendtag 中，格式如"今日发布"、"昨天发布"、"2天前发布"
 */
async function extractDateFromDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(800);

    const dateText = await page.evaluate(() => {
      // 查找所有 companyCommendtag span，找包含"发布"的那个
      const tags = document.querySelectorAll('.companyCommendtag');
      for (const tag of tags) {
        const t = tag.innerText.trim();
        if (t.includes('发布')) return t;
      }

      // 备用：在 company_bottom 中查找包含"发布"的文本
      const bottom = document.querySelector('.company_bottom');
      if (bottom) {
        const spans = bottom.querySelectorAll('span');
        for (const s of spans) {
          const t = s.innerText.trim();
          if (t.includes('发布')) return t;
        }
      }

      // 备用：全局搜索包含"发布"的短span
      const allSpans = document.querySelectorAll('span');
      for (const s of allSpans) {
        const t = s.innerText.trim();
        if (t.length < 20 && t.includes('发布')) return t;
      }

      return '';
    });

    return dateText || '';
  } catch (e) {
    return '';
  }
}

/**
 * 处理一批任务（并发）
 */
async function processBatch(context, jobs, startIdx, batchEnd, concurrency, delay) {
  const results = [];
  const pages = [];
  for (let i = 0; i < concurrency; i++) {
    pages.push(await context.newPage());
  }

  console.log(`  处理 ${startIdx + 1}-${batchEnd} / ${jobs.length}...`);

  for (let i = startIdx; i < batchEnd; i += concurrency) {
    const promises = [];
    for (let c = 0; c < concurrency && i + c < batchEnd; c++) {
      const jobIdx = i + c;
      const job = jobs[jobIdx];
      const page = pages[c];

      if (!job.detailUrl || job.date) {
        // 无URL或已有日期，跳过
        promises.push(Promise.resolve({ idx: jobIdx, date: job.date || '' }));
        continue;
      }

      promises.push(
        extractDateFromDetail(page, job.detailUrl).then((date) => {
          if (date) {
            jobs[jobIdx].date = date;
          }
          return { idx: jobIdx, date };
        })
      );
    }

    const batchResults = await Promise.all(promises);
    results.push(...batchResults);

    // 进度输出
    const found = results.filter((r) => r.date).length;
    process.stdout.write(`\r  已处理 ${results.length}/${batchEnd - startIdx}，找到日期 ${found}`);
  }

  console.log('');
  // 关闭页面
  for (const page of pages) {
    await page.close();
  }
  return results;
}

async function main() {
  const config = parseArgs();

  console.log('=== 58同城发布时间补充工具 ===\n');

  // 读取数据
  if (!fs.existsSync(DATA_FILE)) {
    console.error('错误: 找不到数据文件', DATA_FILE);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const jobs = data.jobs;
  console.log(`总数据量: ${jobs.length} 条`);

  // 统计已有日期的
  const hasDate = jobs.filter((j) => j.date && j.date.length > 0).length;
  console.log(`已有日期: ${hasDate} 条`);
  console.log(`需补充: ${jobs.length - hasDate} 条`);

  // 读取进度（断点续传）
  let startIdx = 0;
  if (fs.existsSync(PROGRESS_FILE)) {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    startIdx = progress.lastIdx || 0;
    console.log(`从断点继续: 第 ${startIdx + 1} 条开始\n`);
  } else {
    console.log('');
  }

  // 限制处理数量
  let endIdx = jobs.length;
  if (config.limit > 0) {
    endIdx = Math.min(startIdx + config.limit, jobs.length);
    console.log(`限制处理: ${config.limit} 条（到第 ${endIdx} 条）`);
  }

  if (startIdx >= endIdx) {
    console.log('无需处理，已完成。');
    process.exit(0);
  }

  const { browser, context } = await createBrowser();

  const batchSize = 30; // 每批30条
  try {
    for (let i = startIdx; i < endIdx; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, endIdx);
      console.log(`\n--- 批次 ${Math.floor(i / batchSize) + 1} ---`);

      await processBatch(context, jobs, i, batchEnd, config.concurrency, config.delay);

      // 保存进度
      fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ lastIdx: batchEnd, total: jobs.length }), 'utf-8');

      // 增量保存JSON
      data.jobs = jobs;
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');

      const found = jobs.slice(0, batchEnd).filter((j) => j.date && j.date.length > 0).length;
      console.log(`  已保存进度: ${batchEnd}/${endIdx}，累计找到日期 ${found} 条`);

      // 批间延迟
      if (batchEnd < endIdx) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  } finally {
    await browser.close();
  }

  // 最终统计
  const finalHasDate = jobs.filter((j) => j.date && j.date.length > 0).length;
  console.log(`\n=== 补充完成 ===`);
  console.log(`总数据: ${jobs.length} 条`);
  console.log(`有日期: ${finalHasDate} 条 (${((finalHasDate / jobs.length) * 100).toFixed(1)}%)`);
  console.log(`无日期: ${jobs.length - finalHasDate} 条`);

  // 清理进度文件
  if (fs.existsSync(PROGRESS_FILE)) {
    fs.unlinkSync(PROGRESS_FILE);
  }

  // 重新生成HTML报告
  console.log('\n重新生成HTML报告...');
  // 导入并调用 scrape-58.js 的 generateBatchHTML（通过动态导入）
  // 由于 ES module 限制，这里直接重新生成简单报告
  console.log('请运行 node scrape-58.js --batch --append 来重新生成HTML报告');
  console.log('\n✓ 完成！');
}

main().catch((err) => {
  console.error('运行出错:', err);
  process.exit(1);
});
