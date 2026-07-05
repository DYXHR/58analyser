import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import fs from 'fs';
import path from 'path';

const DOWNLOADS_DIR = './downloads';
const OUTPUT_DIR = './html-output';
const RENDER_SCALE = 2; // 渲染倍率，2x 高清

/**
 * 渲染PDF每页为PNG图片，生成HTML查看器
 */
async function convertPdfToHtml(pdfPath, category) {
  const reportName = path.basename(pdfPath, '.pdf');
  const safeName = sanitizeDirName(reportName);
  const categoryDir = category ? sanitizeDirName(category) : '未分类';
  const outDir = path.join(OUTPUT_DIR, categoryDir, safeName);
  const pagesDir = path.join(outDir, 'pages');

  // 如果已转换过，跳过
  const htmlPath = path.join(outDir, 'index.html');
  if (fs.existsSync(htmlPath)) {
    console.log(`  已转换，跳过: ${reportName}`);
    return { reportName, category: categoryDir, htmlPath, numPages: 0, skipped: true };
  }

  fs.mkdirSync(pagesDir, { recursive: true });

  console.log(`  正在解析: ${reportName}`);
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = getDocument({ data });
  const pdf = await loadingTask.promise;
  const numPages = pdf.numPages;
  console.log(`    共 ${numPages} 页，正在渲染...`);

  const pageImages = [];

  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: RENDER_SCALE });

    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, viewport.width, viewport.height);

    await page.render({ canvasContext: context, viewport }).promise;

    const imgName = `page-${p}.png`;
    const imgPath = path.join(pagesDir, imgName);
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(imgPath, buffer);
    pageImages.push({ number: p, src: `pages/${imgName}`, width: viewport.width, height: viewport.height });

    if (p % 2 === 0 || p === numPages) {
      console.log(`    已渲染 ${p}/${numPages} 页`);
    }
  }

  await loadingTask.destroy();

  // 生成HTML
  const html = generateViewerHtml(reportName, categoryDir, numPages, pageImages);
  fs.writeFileSync(htmlPath, html, 'utf-8');

  console.log(`    已生成: ${htmlPath}`);
  return { reportName, category: categoryDir, htmlPath, numPages, skipped: false };
}

/**
 * 生成单个报告的HTML查看器
 */
function generateViewerHtml(title, category, numPages, pages) {
  const pagesHtml = pages
    .map(
      (p) => `
      <div class="page-wrapper" id="page-${p.number}">
        <div class="page-img-box">
          <img src="${p.src}" alt="第${p.number}页" loading="${p.number <= 2 ? 'eager' : 'lazy'}" />
        </div>
        <div class="page-num">第 ${p.number} / ${numPages} 页</div>
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --bg: #e8e8e8; --card: #fff; --primary: #1890ff; --text: #333; --text-light: #999; }
    body { background: var(--bg); font-family: -apple-system, "Microsoft YaHei", "Segoe UI", sans-serif; color: var(--text); }

    .header {
      background: var(--card);
      padding: 16px 24px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      position: sticky; top: 0; z-index: 100;
      display: flex; align-items: center; justify-content: space-between;
    }
    .header-left h1 { font-size: 18px; font-weight: 600; }
    .header-left .meta { font-size: 13px; color: var(--text-light); margin-top: 4px; }
    .header-left .meta span { margin-right: 12px; }

    .toolbar {
      display: flex; gap: 8px; align-items: center;
    }
    .toolbar button {
      width: 36px; height: 36px; border: 1px solid #ddd; border-radius: 6px;
      background: var(--card); cursor: pointer; font-size: 16px; color: var(--text);
      display: flex; align-items: center; justify-content: center;
      transition: all 0.15s;
    }
    .toolbar button:hover { border-color: var(--primary); color: var(--primary); }
    .toolbar .zoom-val { font-size: 13px; color: var(--text-light); min-width: 48px; text-align: center; }

    .pages-container {
      max-width: 820px; margin: 0 auto; padding: 24px 16px 80px;
      transition: max-width 0.2s;
    }
    .page-wrapper { margin-bottom: 16px; }
    .page-img-box {
      background: var(--card);
      box-shadow: 0 2px 12px rgba(0,0,0,0.1);
      border-radius: 4px; overflow: hidden;
    }
    .page-img-box img { width: 100%; display: block; }
    .page-num { text-align: center; font-size: 12px; color: var(--text-light); padding: 6px 0; }

    .back-link {
      position: fixed; bottom: 24px; right: 24px;
      background: var(--primary); color: #fff; text-decoration: none;
      padding: 8px 18px; border-radius: 20px; font-size: 13px;
      box-shadow: 0 2px 8px rgba(24,144,255,0.4); z-index: 100;
      transition: opacity 0.2s;
    }
    .back-link:hover { opacity: 0.85; }

    .page-nav {
      position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,0.75); border-radius: 24px; padding: 8px 16px;
      display: flex; gap: 12px; align-items: center; z-index: 100;
    }
    .page-nav button {
      background: none; border: none; color: #fff; cursor: pointer;
      font-size: 14px; padding: 4px 8px; border-radius: 4px;
    }
    .page-nav button:hover { background: rgba(255,255,255,0.15); }
    .page-nav .cur { color: #fff; font-size: 13px; }

    @media (max-width: 600px) {
      .header { flex-direction: column; gap: 8px; align-items: flex-start; }
      .pages-container { padding: 12px 8px 80px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <h1>${title}</h1>
      <div class="meta">
        <span>分类: ${category}</span>
        <span>共 ${numPages} 页</span>
      </div>
    </div>
    <div class="toolbar">
      <button onclick="zoom(-0.1)" title="缩小">−</button>
      <span class="zoom-val" id="zoomVal">100%</span>
      <button onclick="zoom(0.1)" title="放大">+</button>
      <button onclick="resetZoom()" title="重置">↺</button>
    </div>
  </div>

  <div class="pages-container" id="pagesContainer">
    ${pagesHtml}
  </div>

  <div class="page-nav">
    <button onclick="scrollToPage(-1)">‹ 上页</button>
    <span class="cur" id="curPage">1 / ${numPages}</span>
    <button onclick="scrollToPage(1)">下页 ›</button>
  </div>

  <a href="../../index.html" class="back-link">← 返回目录</a>

  <script>
    let zoomLevel = 1;
    const baseWidth = 820;
    let currentPage = 1;
    const totalPages = ${numPages};

    function zoom(delta) {
      zoomLevel = Math.max(0.4, Math.min(3, Math.round((zoomLevel + delta) * 100) / 100));
      document.getElementById('pagesContainer').style.maxWidth = (baseWidth * zoomLevel) + 'px';
      document.getElementById('zoomVal').textContent = Math.round(zoomLevel * 100) + '%';
    }
    function resetZoom() {
      zoomLevel = 1;
      document.getElementById('pagesContainer').style.maxWidth = baseWidth + 'px';
      document.getElementById('zoomVal').textContent = '100%';
    }
    function scrollToPage(dir) {
      currentPage = Math.max(1, Math.min(totalPages, currentPage + dir));
      const el = document.getElementById('page-' + currentPage);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.getElementById('curPage').textContent = currentPage + ' / ' + totalPages;
    }
    // 滚动时自动更新当前页码
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const m = e.target.id.match(/page-(\\d+)/);
          if (m) {
            currentPage = parseInt(m[1]);
            document.getElementById('curPage').textContent = currentPage + ' / ' + totalPages;
          }
        }
      });
    }, { threshold: 0.5 });
    document.querySelectorAll('.page-wrapper').forEach(el => observer.observe(el));
  </script>
</body>
</html>`;
}

/**
 * 生成索引页（列出所有报告）
 */
function generateIndexHtml(reports) {
  // 按分类分组
  const groups = {};
  for (const r of reports) {
    if (!groups[r.category]) groups[r.category] = [];
    groups[r.category].push(r);
  }

  const groupKeys = Object.keys(groups).sort();
  const groupsHtml = groupKeys
    .map((cat) => {
      const items = groups[cat]
        .sort((a, b) => a.reportName.localeCompare(b.reportName, 'zh-CN'))
        .map((r) => {
          const relPath = path.relative(OUTPUT_DIR, r.htmlPath).replace(/\\/g, '/');
          const pagesInfo = r.numPages > 0 ? `<span class="pages">${r.numPages}页</span>` : '';
          return `<a href="${relPath}" class="report-card">
            <div class="report-name">${r.reportName}</div>
            <div class="report-meta">${pagesInfo}</div>
          </a>`;
        })
        .join('');
      return `<div class="category-group">
        <h2 class="category-title">${cat} <span class="count">(${groups[cat].length})</span></h2>
        <div class="report-grid">${items}</div>
      </div>`;
    })
    .join('');

  const totalReports = reports.length;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>建筑材料价格报告库</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root { --bg: #f5f7fa; --card: #fff; --primary: #1890ff; --text: #333; --text-light: #999; --border: #e8e8e8; }
    body { background: var(--bg); font-family: -apple-system, "Microsoft YaHei", "Segoe UI", sans-serif; color: var(--text); }

    .top-bar {
      background: linear-gradient(135deg, #1890ff, #096dd9);
      color: #fff; padding: 32px 24px; text-align: center;
    }
    .top-bar h1 { font-size: 24px; font-weight: 600; }
    .top-bar .subtitle { font-size: 14px; opacity: 0.85; margin-top: 8px; }
    .top-bar .stats { margin-top: 16px; font-size: 13px; opacity: 0.9; }

    .container { max-width: 1000px; margin: -20px auto 40px; padding: 0 16px; }

    .category-group { margin-bottom: 32px; }
    .category-title {
      font-size: 16px; font-weight: 600; color: var(--text);
      padding: 12px 16px; background: var(--card); border-radius: 8px;
      border-left: 4px solid var(--primary); margin-bottom: 12px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.06);
    }
    .category-title .count { font-weight: 400; color: var(--text-light); font-size: 14px; }

    .report-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;
    }
    .report-card {
      display: block; background: var(--card); border-radius: 8px; padding: 14px 16px;
      text-decoration: none; color: var(--text);
      border: 1px solid var(--border); transition: all 0.15s;
    }
    .report-card:hover { border-color: var(--primary); box-shadow: 0 2px 12px rgba(24,144,255,0.15); transform: translateY(-1px); }
    .report-name { font-size: 14px; line-height: 1.5; font-weight: 500; }
    .report-meta { font-size: 12px; color: var(--text-light); margin-top: 6px; }
    .report-meta .pages { background: #f0f5ff; color: var(--primary); padding: 1px 8px; border-radius: 10px; }

    .search-box {
      max-width: 400px; margin: 16px auto; display: flex;
    }
    .search-box input {
      flex: 1; padding: 8px 14px; border: 1px solid #ddd; border-radius: 20px;
      font-size: 14px; outline: none;
    }
    .search-box input:focus { border-color: var(--primary); }

    @media (max-width: 600px) {
      .report-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <h1>建筑材料价格报告库</h1>
    <div class="subtitle">ICC China · 瑞达恒研究院价格趋势报告</div>
    <div class="stats">共 ${totalReports} 份报告 · ${groupKeys.length} 个分类</div>
    <div class="search-box">
      <input type="text" id="searchInput" placeholder="搜索报告名称..." oninput="filterReports()" />
    </div>
  </div>
  <div class="container" id="container">
    ${groupsHtml}
  </div>
  <script>
    function filterReports() {
      const q = document.getElementById('searchInput').value.toLowerCase().trim();
      document.querySelectorAll('.report-card').forEach(card => {
        const name = card.querySelector('.report-name').textContent.toLowerCase();
        card.style.display = (!q || name.includes(q)) ? '' : 'none';
      });
      document.querySelectorAll('.category-group').forEach(g => {
        const visible = g.querySelectorAll('.report-card:not([style*="none"])').length;
        g.style.display = visible > 0 ? '' : 'none';
      });
    }
  </script>
</body>
</html>`;
}

function sanitizeDirName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().substring(0, 80);
}

/**
 * 扫描downloads目录下所有PDF文件
 */
function findPdfFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      // 子目录名作为分类名
      const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
      for (const sub of subEntries) {
        if (sub.isFile() && sub.name.endsWith('.pdf')) {
          results.push({ path: path.join(fullPath, sub.name), category: entry.name });
        }
      }
    } else if (entry.isFile() && entry.name.endsWith('.pdf')) {
      results.push({ path: fullPath, category: '未分类' });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);

  console.log('=== PDF → HTML 转换工具 ===\n');

  if (!fs.existsSync(DOWNLOADS_DIR)) {
    console.log('错误: downloads 目录不存在，请先运行 download-pdf.js 下载报告');
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // 查找所有PDF
  let pdfFiles = findPdfFiles(DOWNLOADS_DIR);

  // 过滤指定分类
  if (args.length > 0 && !args[0].endsWith('.pdf')) {
    pdfFiles = pdfFiles.filter((f) => args.includes(f.category));
    console.log(`筛选分类: ${args.join(', ')}`);
  }

  // 过滤指定文件
  if (args.length > 0 && args[0].endsWith('.pdf')) {
    pdfFiles = pdfFiles.filter((f) => f.path.includes(args[0]));
  }

  if (pdfFiles.length === 0) {
    console.log('未找到PDF文件');
    return;
  }

  console.log(`找到 ${pdfFiles.length} 个PDF文件\n`);

  // 逐个转换
  const results = [];
  for (let i = 0; i < pdfFiles.length; i++) {
    const { path: pdfPath, category } = pdfFiles[i];
    console.log(`[${i + 1}/${pdfFiles.length}] ${category}/${path.basename(pdfPath)}`);
    try {
      const result = await convertPdfToHtml(pdfPath, category);
      results.push(result);
    } catch (e) {
      console.log(`  转换失败: ${e.message}`);
      results.push({ reportName: path.basename(pdfPath, '.pdf'), category, htmlPath: '', numPages: 0, skipped: false, error: e.message });
    }
  }

  // 生成索引页
  console.log('\n生成索引页...');
  const validResults = results.filter((r) => r.htmlPath);
  const indexHtml = generateIndexHtml(validResults);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'), indexHtml, 'utf-8');

  const successCount = results.filter((r) => !r.error && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  console.log(`\n=== 转换完成 ===`);
  console.log(`新转换: ${successCount} | 已跳过: ${skipCount} | 失败: ${results.length - successCount - skipCount}`);
  console.log(`索引页: ${path.resolve(OUTPUT_DIR, 'index.html')}`);
  console.log(`输出目录: ${path.resolve(OUTPUT_DIR)}`);
}

main().catch((err) => {
  console.error('程序出错:', err);
  process.exit(1);
});
