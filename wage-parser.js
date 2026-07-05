/**
 * 薪资文本解析模块
 * 支持时薪、日薪、月薪、面议四种格式的解析与换算
 * 纯逻辑模块，不依赖浏览器环境
 */

// 中文数字字符映射
const CN_DIGITS = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};

/**
 * 将文本数字片段转为数字
 * 兼容阿拉伯数字（含小数）与简单中文数字（如 二十、十五、三百）
 * @param {string} str
 * @returns {number|null}
 */
function toNumber(str) {
  if (!str) return null;
  const trimmed = str.trim();
  // 纯阿拉伯数字
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseFloat(trimmed);
  // 中文数字
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(trimmed)) return null;

  let total = 0;
  let number = 0;
  for (const ch of trimmed) {
    if (ch === '十') {
      total += (number || 1) * 10;
      number = 0;
    } else if (ch === '百') {
      total += (number || 1) * 100;
      number = 0;
    } else if (CN_DIGITS[ch] !== undefined) {
      number = CN_DIGITS[ch];
    }
  }
  return total + number;
}

// 数字片段（阿拉伯数字或中文数字）
const NUM = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
// 范围分隔符：- – — ~ ～ 至 到
const SEP = '\\s*[-–—~～至到]\\s*';

/**
 * 解析薪资文本
 * 支持格式：时薪、日薪、月薪、面议
 * @param {string} text 薪资原文
 * @returns {{type: string, min: number|null, max: number|null, raw: string}}
 */
export function parseWage(text) {
  const raw = text ? String(text).trim() : '';
  const fallback = { type: 'unknown', min: null, max: null, raw };
  if (!raw) return fallback;

  // 面议
  if (/面议/.test(raw)) {
    return { type: 'negotiable', min: null, max: null, raw };
  }

  // 时薪：xx元/小时 或 xx元/时
  let m = raw.match(new RegExp(NUM + '(?:' + SEP + NUM + ')?\\s*元?\\s*[/／]\\s*(?:小时|时)'));
  if (m) {
    const min = toNumber(m[1]);
    const max = m[2] ? toNumber(m[2]) : min;
    return { type: 'hourly', min, max, raw };
  }

  // 日薪：xx元/天 或 xx元/日
  m = raw.match(new RegExp(NUM + '(?:' + SEP + NUM + ')?\\s*元?\\s*[/／]\\s*(?:天|日)'));
  if (m) {
    const min = toNumber(m[1]);
    const max = m[2] ? toNumber(m[2]) : min;
    return { type: 'daily', min, max, raw };
  }

  // 月薪：xx元/月 或 xx元/个月
  m = raw.match(new RegExp(NUM + '(?:' + SEP + NUM + ')?\\s*元?\\s*[/／]\\s*个?月'));
  if (m) {
    const min = toNumber(m[1]);
    const max = m[2] ? toNumber(m[2]) : min;
    return { type: 'monthly', min, max, raw };
  }

  return fallback;
}

/**
 * 将日薪/月薪统一换算为时薪
 * - 日薪 → 时薪：除以 10（每天工作 10 小时）
 * - 月薪 → 时薪：除以 260（每月工作 26 天 × 每天 10 小时）
 * - 时薪：直接返回
 * - 面议：返回 null
 * @param {{type: string, min: number|null, max: number|null}} parsed parseWage 的返回值
 * @returns {{min: number|null, max: number|null}}
 */
export function toHourlyWage(parsed) {
  if (!parsed) return { min: null, max: null };
  const { type, min, max } = parsed;

  if (type === 'hourly') {
    return { min, max };
  }
  if (type === 'daily') {
    return {
      min: min !== null ? min / 10 : null,
      max: max !== null ? max / 10 : null,
    };
  }
  if (type === 'monthly') {
    return {
      min: min !== null ? min / 260 : null,
      max: max !== null ? max / 260 : null,
    };
  }
  // negotiable / unknown
  return { min: null, max: null };
}

/**
 * 格式化薪资为可读字符串
 * @param {{type: string, min: number|null, max: number|null, raw: string}} parsed
 * @returns {string}
 */
export function formatWage(parsed) {
  if (!parsed) return '';
  const { type, min, max, raw } = parsed;
  if (type === 'negotiable') return '面议';
  if (type === 'unknown' || min === null || min === undefined) return raw || '';

  const unit = { hourly: '元/小时', daily: '元/天', monthly: '元/月' }[type];
  if (!unit) return raw || '';

  if (max !== null && max !== undefined && min !== max) {
    return `${min}-${max}${unit}`;
  }
  return `${min}${unit}`;
}

// ===== 自测代码（node wage-parser.js 运行）=====
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  let pass = 0;
  let fail = 0;

  console.log('===== parseWage 测试 =====');
  const parseCases = [
    ['22元/小时', { type: 'hourly', min: 22, max: 22 }],
    ['24元/时', { type: 'hourly', min: 24, max: 24 }],
    ['17元/小时', { type: 'hourly', min: 17, max: 17 }],
    ['30元/时', { type: 'hourly', min: 30, max: 30 }],
    ['200-240元/天', { type: 'daily', min: 200, max: 240 }],
    ['320元/天', { type: 'daily', min: 320, max: 320 }],
    ['150-200元/天', { type: 'daily', min: 150, max: 200 }],
    ['6000-7000元/月', { type: 'monthly', min: 6000, max: 7000 }],
    ['8000-9000元/月', { type: 'monthly', min: 8000, max: 9000 }],
    ['6000-10000元/月', { type: 'monthly', min: 6000, max: 10000 }],
    ['面议', { type: 'negotiable', min: null, max: null }],
    ['薪资面议', { type: 'negotiable', min: null, max: null }],
  ];
  for (const [text, expect] of parseCases) {
    const r = parseWage(text);
    const ok = r.type === expect.type && r.min === expect.min && r.max === expect.max;
    if (ok) pass++; else fail++;
    console.log(
      `${ok ? '✓' : '✗'} "${text}" => type=${r.type} min=${r.min} max=${r.max}` +
      (ok ? '' : ` (期望 type=${expect.type} min=${expect.min} max=${expect.max})`)
    );
  }

  console.log('\n===== toHourlyWage 测试 =====');
  const wageCases = [
    [{ type: 'hourly', min: 22, max: 22 }, { min: 22, max: 22 }],
    [{ type: 'daily', min: 200, max: 240 }, { min: 20, max: 24 }],
    [{ type: 'daily', min: 320, max: 320 }, { min: 32, max: 32 }],
    [{ type: 'monthly', min: 6000, max: 7000 }, { min: 6000 / 260, max: 7000 / 260 }],
    [{ type: 'negotiable', min: null, max: null }, { min: null, max: null }],
  ];
  for (const [parsed, expect] of wageCases) {
    const r = toHourlyWage(parsed);
    const ok = r.min === expect.min && r.max === expect.max;
    if (ok) pass++; else fail++;
    console.log(
      `${ok ? '✓' : '✗'} ${parsed.type} ${parsed.min}-${parsed.max} => 时薪 min=${r.min} max=${r.max}` +
      (ok ? '' : ` (期望 min=${expect.min} max=${expect.max})`)
    );
  }

  console.log('\n===== formatWage 测试 =====');
  const formatCases = ['22元/小时', '200-240元/天', '6000-7000元/月', '面议', ''];
  for (const text of formatCases) {
    const out = formatWage(parseWage(text));
    console.log(`  "${text}" => "${out}"`);
  }

  console.log('\n===== 边界情况测试 =====');
  const edgeCases = ['', null, undefined, '无法识别的文本', '22元每小时'];
  for (const text of edgeCases) {
    const r = parseWage(text);
    console.log(`  输入=${JSON.stringify(text)} => ${r.type} min=${r.min} max=${r.max}`);
  }

  console.log(`\n总计: ${pass} 通过, ${fail} 失败`);
  if (fail > 0) process.exit(1);
}
