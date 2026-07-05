# Tasks

- [x] Task 1: 探索鱼泡网页面结构，确定搜索URL和DOM选择器
  - [x] SubTask 1.1: 使用 Playwright 打开 m.yupao.com，找到搜索入口和搜索结果页结构
  - [x] SubTask 1.2: 确定列表项的 DOM 选择器（薪资、标题、公司、地区、时间）
  - [x] SubTask 1.3: 确定分页机制（页码按钮 / 无限滚动）

- [x] Task 2: 实现薪资文本解析函数
  - [x] SubTask 2.1: 编写 `parseWage(text)` 函数，支持解析"元/小时"、"元/天"、"元/月"三种格式
  - [x] SubTask 2.2: 编写 `toHourlyWage(parsed)` 函数，将日薪/月薪统一换算为时薪
  - [x] SubTask 2.3: 处理薪资范围（如 "200-240元/天"），取最低和最高值

- [x] Task 3: 实现核心爬虫逻辑 `scrape-yupao.js`
  - [x] SubTask 3.1: 实现搜索功能（导航到搜索页、输入关键词、获取结果）
  - [x] SubTask 3.2: 实现列表页数据提取（遍历列表项，提取结构化数据）
  - [x] SubTask 3.3: 实现分页爬取（点击下一页或翻页，累计结果）
  - [x] SubTask 3.4: 实现城市筛选逻辑

- [x] Task 4: 实现数据输出
  - [x] SubTask 4.1: 将爬取结果输出为 JSON 文件（含原始文本和解析后的结构化数据）
  - [x] SubTask 4.2: 生成 HTML 报告（时薪统计、城市分组对比、可排序岗位表格）

- [x] Task 5: 添加命令行参数支持
  - [x] SubTask 5.1: 支持 `--keyword`（搜索关键词，默认"产线工人"）
  - [x] SubTask 5.2: 支持 `--city`（城市筛选，可选）
  - [x] SubTask 5.3: 支持 `--max-pages`（最大爬取页数，默认3）

- [x] Task 6: 测试与验证
  - [x] SubTask 6.1: 运行脚本爬取"产线工人"关键词前1页数据，验证数据完整性
  - [x] SubTask 6.2: 验证薪资解析正确性（时薪/日薪/月薪三种格式）
  - [x] SubTask 6.3: 验证 HTML 报告展示效果

# Task Dependencies
- [Task 2] 独立，可先实现
- [Task 3] 依赖 [Task 1] 的页面结构探索结果
- [Task 4] 依赖 [Task 2] 和 [Task 3]
- [Task 5] 依赖 [Task 3]
- [Task 6] 依赖 [Task 3]、[Task 4]、[Task 5]
