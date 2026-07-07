# 58analyser

建筑材料价格报告下载与人工成本数据爬取工具。

## 功能模块

### 1. ICC China PDF报告下载 (`download-pdf.js`)
- 从 ICC China 网站下载建筑材料价格趋势 PDF 报告
- 支持按分类下载（水泥、混凝土、不锈钢等）
- 使用 Playwright 自动化浏览器操作

### 2. PDF转HTML (`pdf-to-html.js`)
- 使用 pdfjs-dist 解析 PDF 并渲染为高清页面图片
- 生成带缩放、翻页导航的 HTML 查看器
- 生成按分类分组的索引页

### 3. 鱼泡网时薪爬虫 (`scrape-yupao.js`)
- 从鱼泡网 (m.yupao.com) 爬取产线工人岗位薪资
- 支持30个关键词批量爬取
- 薪资统一换算为时薪（日薪÷10，月薪÷260）
- 输出 JSON 数据 + HTML 可视化报告
- **按城市搜索模式** (`--cities`)：针对指定城市（默认深圳/南京/西安/河源/长沙）逐城市主动搜索，扩量；通过页面城市选择器筛选 + 搜索框就地换关键词保留筛选；每条岗位显式标注目标城市

### 4. 58同城时薪爬虫 (`scrape-58.js`)
- 从58同城 (m.58.com) 爬取产线工人岗位薪资
- 支持23个城市 × 3个分类批量爬取
- 追加模式 (`--append`) 支持增量补充数据
- 输出 JSON 数据 + HTML 可视化报告

### 5. 产线工人时薪多城市对比报告 (`report-cities.py`)
- 基于鱼泡网批量数据，生成多城市时薪对比可视化报告（Python 实现，仅依赖标准库）
- 默认覆盖深圳、南京、西安、河源、长沙 5 城市，可用 `-c` 自定义城市列表
- 顶部五城市时薪总览 + 逐城市标签页（时薪分布直方图 / 各行政区 / 工种 / 薪资类型 / 福利与结算方式 / 岗位明细）
- 各城市行政区归一化（将「宝安区 福永」「南山中心区」「葵涌」等统一映射到标准区）
- 岗位明细表支持列头排序与行政区筛选；小样本城市（如河源）自动降级不崩溃
- 用法：`npm run cities` 或 `python report-cities.py`（自动选取最新批量 JSON）
  - 单城市：`npm run shenzhen` 或 `python report-cities.py -c 深圳`

### 6. 薪资解析模块 (`wage-parser.js`)
- 解析"元/小时"、"元/天"、"元/月"三种薪资格式
- 支持范围解析（如"200-240元/天"）
- 统一换算为时薪

## 快速开始

```bash
# 安装依赖
npm install

# 下载ICC China PDF报告
npm run download

# PDF转HTML
npm run convert

# 鱼泡网批量爬取（30关键词，5000+条数据）
npm run batch

# 鱼泡网按城市搜索扩量（5城市×12词，约40分钟，数据更聚焦）
npm run batchcities

# 58同城批量爬取（23城市×3分类，5000+条数据）
npm run batch58

# 生成产线工人时薪多城市对比报告（深圳/南京/西安/河源/长沙，Python）
npm run cities

# 启动本地服务器预览HTML报告
npm run serve
```

## 数据输出

```
downloads/           # ICC China PDF报告
html-output/         # PDF转HTML查看器
scrape-yupao-data/   # 鱼泡网爬取数据（JSON + HTML报告）
scrape-58-data/      # 58同城爬取数据（JSON + HTML报告）
```

## 技术栈

- **Playwright** - 浏览器自动化（反爬绕过、页面交互）
- **pdfjs-dist** - PDF 解析与渲染
- **@napi-rs/canvas** - Node.js Canvas（PDF页面渲染为图片）
- **ES Module** - 模块系统
