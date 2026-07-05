import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const LIST_URL = 'https://services.iccchina.com/survey/trend?source_page=icc_home';
const DOWNLOAD_DIR = './downloads';
const PER_PAGE = 10;

/**
 * 获取所有报告分类
 */
async function getCategories(page) {
  return await page.$$eval('.search-sort', (sorts) => {
    const catSort = sorts.find((s) => s.innerText.includes('报告类别'));
    if (!catSort) return [];
    return Array.from(catSort.querySelectorAll('.search-label')).map((el) => el.innerText.trim());
  });
}

/**
 * 选择某个分类（点击对应标签）
 */
async function selectCategory(page, categoryName) {
  await page.$$eval('.search-sort', (sorts, target) => {
    const catSort = sorts.find((s) => s.innerText.includes('报告类别'));
    if (!catSort) return;
    const labels = catSort.querySelectorAll('.search-label');
    for (const el of labels) {
      if (el.innerText.trim() === target) {
        el.click();
        break;
      }
    }
  }, categoryName);
  await page.waitForTimeout(3000);
}

/**
 * 获取分页信息（总条数、总页数、当前页）
 */
async function getPaginationInfo(page) {
  const info = await page.$$eval('.ivu-page', (els) => {
    if (els.length === 0) return null;
    const el = els[0];
    const totalText = el.querySelector('.ivu-page-total')?.innerText || '';
    const match = totalText.match(/共\s*(\d+)\s*条/);
    const total = match ? parseInt(match[1]) : 0;
    const activeItem = el.querySelector('.ivu-page-item-active');
    const currentPage = activeItem ? parseInt(activeItem.innerText) : 1;
    const totalPages = Math.ceil(total / 10);
    const hasNext = !el.querySelector('.ivu-page-next')?.classList.contains('ivu-page-disabled');
    return { total, currentPage, totalPages, hasNext };
  });
  return info || { total: 0, currentPage: 1, totalPages: 0, hasNext: false };
}

/**
 * 获取当前页面显示的所有报告卡片信息（标题 + 详情页URL）
 * 通过点击每张卡片并拦截 window.open 来获取报告ID
 */
async function getReportsOnPage(page) {
  const cardCount = await page.$$eval('.trend-card', (els) => els.length);
  const reports = [];

  for (let i = 0; i < cardCount; i++) {
    const cards = await page.$$('.trend-card');
    if (i >= cards.length) break;

    const card = cards[i];
    const title = await card.$eval('h2', (el) => el.innerText.trim()).catch(() => `报告_${i + 1}`);

    await page.evaluate(() => { window.__capturedUrls = []; });
    await card.click();
    await page.waitForTimeout(1200);

    const capturedUrls = await page.evaluate(() => window.__capturedUrls);
    if (capturedUrls && capturedUrls.length > 0) {
      const detailPath = capturedUrls[0];
      const match = detailPath.match(/\/detail\/([^?]+)/);
      const reportId = match ? match[1] : null;
      const fullUrl = detailPath.startsWith('http') ? detailPath : 'https://services.iccchina.com' + detailPath;
      reports.push({ title, reportId, detailUrl: fullUrl });
    }
  }
  return reports;
}

/**
 * 翻到下一页
 */
async function goToNextPage(page) {
  const nextBtn = await page.$('.ivu-page-next:not(.ivu-page-disabled)');
  if (nextBtn) {
    await nextBtn.click();
    await page.waitForTimeout(3000);
    return true;
  }
  return false;
}

/**
 * 获取指定分类下的所有报告（自动翻页）
 */
async function getAllReportsByCategory(page, categoryName, maxPages) {
  await selectCategory(page, categoryName);

  const pageInfo = await getPaginationInfo(page);
  console.log(`  共 ${pageInfo.total} 条报告，${pageInfo.totalPages} 页`);

  const maxPagesToFetch = maxPages || pageInfo.totalPages;
  const allReports = [];

  for (let p = 1; p <= maxPagesToFetch; p++) {
    console.log(`  正在获取第 ${p}/${maxPagesToFetch} 页...`);
    const reports = await getReportsOnPage(page);
    allReports.push(...reports);
    console.log(`    获取到 ${reports.length} 个报告`);

    if (p < maxPagesToFetch) {
      const hasNext = await goToNextPage(page);
      if (!hasNext) {
        console.log('    没有更多页了');
        break;
      }
    }
  }

  return allReports;
}

/**
 * 从详情页下载PDF
 */
async function downloadReportPdf(context, report, categoryDir, index) {
  const { title, detailUrl } = report;
  const safeFilename = sanitizeFilename(title) + '.pdf';
  const filepath = path.join(categoryDir, safeFilename);

  if (fs.existsSync(filepath)) {
    console.log(`  [${index}] 已存在，跳过: ${safeFilename}`);
    return true;
  }

  console.log(`  [${index}] 下载: ${title}`);
  const page = await context.newPage();
  let downloadSaved = false;

  try {
    const downloadPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('下载超时(30s)')), 30000);
      page.on('download', async (download) => {
        clearTimeout(timeout);
        try {
          await download.saveAs(filepath);
          downloadSaved = true;
          console.log(`    已保存: ${filepath}`);
          resolve(filepath);
        } catch (e) {
          reject(e);
        }
      });
    });

    await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 60000 });

    try {
      await downloadPromise;
    } catch (e) {
      // 回退: 点击"下载试看"按钮
      if (!downloadSaved) {
        try {
          const btn = await page.waitForSelector('.down_load', { timeout: 5000 });
          if (btn) {
            const clickPromise = new Promise((resolve, reject) => {
              const t = setTimeout(() => reject(new Error('按钮下载超时')), 15000);
              page.on('download', async (dl) => {
                clearTimeout(t);
                try { await dl.saveAs(filepath); downloadSaved = true; resolve(); } catch (err) { reject(err); }
              });
            });
            await btn.click();
            await clickPromise;
          }
        } catch (btnErr) {
          // 回退: 从iframe提取PDF URL直接下载
          if (!downloadSaved) {
            try {
              const iframe = await page.$('iframe[src*=".pdf"]');
              if (iframe) {
                const pdfUrl = await iframe.getAttribute('src');
                if (pdfUrl) {
                  const base64 = await page.evaluate(async (url) => {
                    const res = await fetch(url);
                    const buf = await res.arrayBuffer();
                    return btoa(String.fromCharCode(...new Uint8Array(buf)));
                  }, pdfUrl);
                  if (base64) {
                    fs.writeFileSync(filepath, Buffer.from(base64, 'base64'));
                    downloadSaved = true;
                    console.log(`    已保存(直接下载): ${filepath}`);
                  }
                }
              }
            } catch (fetchErr) {
              console.log(`    下载失败: ${fetchErr.message}`);
            }
          }
        }
      }
    }
  } finally {
    await page.close();
  }

  return downloadSaved;
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 100);
}

/**
 * 列出所有分类及报告数量
 */
async function listCategories(page) {
  const categories = await getCategories(page);
  console.log('\n可用的报告分类:\n');
  console.log('  序号  分类名称          报告数量');
  console.log('  ----  --------          --------');

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    if (cat === '全部') {
      // 全部默认已选中，直接读取
      const info = await getPaginationInfo(page);
      console.log(`  ${String(i).padStart(4)}  ${cat.padEnd(16)}  ${info.total} 条`);
    } else {
      await selectCategory(page, cat);
      const info = await getPaginationInfo(page);
      console.log(`  ${String(i).padStart(4)}  ${cat.padEnd(16)}  ${info.total} 条`);
    }
  }

  // 恢复到"全部"
  await selectCategory(page, '全部');
  console.log('\n使用方法:');
  console.log('  node download-pdf.js 水泥              # 下载"水泥"分类的所有报告');
  console.log('  node download-pdf.js 水泥 商品砼       # 下载多个分类');
  console.log('  node download-pdf.js 水泥 --max-pages 2 # 限制最多下载2页');
  console.log('  node download-pdf.js --list            # 列出所有分类');
  console.log('  node download-pdf.js --all             # 下载所有分类');
}

/**
 * 下载指定分类的报告
 */
async function downloadCategory(context, page, categoryName, maxPages) {
  console.log(`\n=== 分类: ${categoryName} ===`);

  const reports = await getAllReportsByCategory(page, categoryName, maxPages);
  console.log(`  共获取到 ${reports.length} 个报告\n`);

  if (reports.length === 0) {
    console.log('  该分类下没有报告');
    return { total: 0, success: 0 };
  }

  // 创建分类子目录
  const categoryDir = path.join(DOWNLOAD_DIR, sanitizeFilename(categoryName));
  if (!fs.existsSync(categoryDir)) {
    fs.mkdirSync(categoryDir, { recursive: true });
  }

  let successCount = 0;
  for (let i = 0; i < reports.length; i++) {
    const ok = await downloadReportPdf(context, reports[i], categoryDir, i + 1);
    if (ok) successCount++;
  }

  console.log(`\n  ${categoryName}: 成功 ${successCount}/${reports.length}`);
  return { total: reports.length, success: successCount };
}

async function main() {
  const args = process.argv.slice(2);

  // 解析参数
  const maxPagesIdx = args.indexOf('--max-pages');
  const maxPages = maxPagesIdx !== -1 ? parseInt(args[maxPagesIdx + 1]) : null;
  const categoriesToDownload = args.filter((a) => !a.startsWith('--') && !a.match(/^\d+$/));

  const isList = args.includes('--list');
  const isAll = args.includes('--all');

  console.log('=== ICC China 报告PDF下载工具（按分类） ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    const page = await context.newPage();

    // 拦截 window.open
    await page.addInitScript(() => {
      window.__capturedUrls = [];
      window.open = function (url) { window.__capturedUrls.push(url); };
    });

    console.log('正在打开报告列表页...');
    await page.goto(LIST_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    if (isList || categoriesToDownload.length === 0 && !isAll) {
      // 列出所有分类
      await listCategories(page);
      return;
    }

    // 确定要下载的分类
    let targetCategories;
    if (isAll) {
      targetCategories = await getCategories(page);
    } else {
      // 验证用户输入的分类名称
      const allCategories = await getCategories(page);
      targetCategories = [];
      for (const cat of categoriesToDownload) {
        if (allCategories.includes(cat)) {
          targetCategories.push(cat);
        } else {
          console.log(`警告: 未找到分类"${cat}"，可用分类: ${allCategories.join(', ')}`);
        }
      }
    }

    if (targetCategories.length === 0) {
      console.log('\n没有有效的分类可下载');
      return;
    }

    if (maxPages) {
      console.log(`限制: 每个分类最多下载 ${maxPages} 页（${maxPages * PER_PAGE} 个报告）`);
    }

    // 创建下载目录
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }

    // 逐个分类下载
    let totalSuccess = 0;
    let totalReports = 0;

    for (const cat of targetCategories) {
      const result = await downloadCategory(context, page, cat, maxPages);
      totalSuccess += result.success;
      totalReports += result.total;
    }

    console.log(`\n=== 全部完成 ===`);
    console.log(`总计: 成功 ${totalSuccess}/${totalReports}`);
    console.log(`文件保存在: ${path.resolve(DOWNLOAD_DIR)}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('程序出错:', err);
  process.exit(1);
});
