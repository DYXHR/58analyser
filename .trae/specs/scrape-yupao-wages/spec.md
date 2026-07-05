# 鱼泡网产线工人时薪爬取 Spec

## Why
当前项目已具备从 ICC China 下载建筑材料价格报告的能力。为了更全面地分析建筑/制造业成本，需要获取产线工人的时薪数据作为人工成本参考。鱼泡网（yupao.com）是国内领先的蓝领招聘平台，每日更新大量工厂普工、操作工等岗位，薪资信息公开可获取。

## What Changes
- 新增 `scrape-yupao.js` 脚本：使用 Playwright 爬取鱼泡网上产线工人岗位的薪资信息
- 支持按关键词搜索（如"产线工人"、"普工"、"操作工"）和城市筛选
- 从招聘列表页提取岗位标题、公司名称、地区、薪资（时薪/日薪/月薪）、发布时间、详情页URL
- 将日薪/月薪统一换算为时薪（按标准工时转换）
- 结果输出为 JSON 数据文件 + HTML 可视化报告
- 支持分页爬取（可配置页数上限）

## Impact
- 新增文件: `scrape-yupao.js`（爬虫脚本）、`scrape-yupao-data/`（数据输出目录）
- 依赖: 复用项目已有的 `playwright` 依赖，无需新增
- 不影响现有 `download-pdf.js` 和 `pdf-to-html.js` 功能

## ADDED Requirements

### Requirement: 搜索产线工人岗位
系统 SHALL 能在鱼泡网（m.yupao.com）上搜索产线工人相关岗位。

#### Scenario: 按关键词搜索
- **WHEN** 用户运行 `node scrape-yupao.js --keyword 产线工人`
- **THEN** 脚本打开鱼泡网搜索页，输入关键词并获取搜索结果列表

#### Scenario: 按城市筛选
- **WHEN** 用户运行 `node scrape-yupao.js --keyword 产线工人 --city 深圳`
- **THEN** 脚本在搜索结果中筛选指定城市的岗位

### Requirement: 提取薪资信息
系统 SHALL 从每个岗位列表项中提取结构化薪资数据。

#### Scenario: 提取时薪
- **WHEN** 岗位薪资文本为 "22元/小时" 或 "24元/时"
- **THEN** 解析为 `{ type: "hourly", amount: 22, unit: "元/小时" }`

#### Scenario: 提取日薪并换算时薪
- **WHEN** 岗位薪资文本为 "200-240元/天"
- **THEN** 解析为日薪范围，按每天工作10小时换算时薪为 20-24元/小时

#### Scenario: 提取月薪并换算时薪
- **WHEN** 岗位薪资文本为 "6000-7000元/月"
- **THEN** 解析为月薪范围，按每月工作26天、每天10小时换算时薪约为 23-27元/小时

### Requirement: 分页爬取
系统 SHALL 支持多页爬取，默认爬取前3页。

#### Scenario: 限制页数
- **WHEN** 用户运行 `node scrape-yupao.js --keyword 产线工人 --max-pages 5`
- **THEN** 脚本爬取最多5页搜索结果（每页约20条），共计约100条岗位信息

### Requirement: 数据输出
系统 SHALL 将爬取结果输出为 JSON 和 HTML 两种格式。

#### Scenario: JSON输出
- **WHEN** 爬取完成
- **THEN** 在 `scrape-yupao-data/` 目录下生成 `wages-{keyword}-{date}.json` 文件，包含所有岗位的结构化数据

#### Scenario: HTML报告
- **WHEN** 爬取完成
- **THEN** 在 `scrape-yupao-data/` 目录下生成 `report-{keyword}-{date}.html` 文件，包含：
  - 时薪分布统计（均值、中位数、范围）
  - 按城市分组的薪资对比
  - 岗位列表表格（可排序）
