// 收藏考古报告核心计算：纯函数，供 scripts/report.mjs（站主预生成）与 server.mjs（OAuth 用户现场算）复用
// 切日口径见 lib/time.mjs（UTC+8，与推送调度同来源）
import { cstFmt } from './time.mjs';

const DAY = 86400;

// 人格判定阈值（issue #50：魔数收敛为命名常量）
const DORMANT_DAYS = 180;          // 超过 N 天无新收藏 → 冬眠型
const BURST_MONTH_SHARE = 0.4;     // 单月收藏占比超过 → 爆发型囤积者
const SQUIRREL_MIN_SPAN_DAYS = 30; // 时间跨度不足 N 天不做年均速率判定（单日 6 条误判松鼠型）
const SQUIRREL_ANNUAL_RATE = 50;   // 年均收藏超过 N 条 → 松鼠型

const fmt = cstFmt;

function emptyReport(now) {
  return {
    generatedAt: now * 1000,
    total: 0,
    typeDist: {},
    spanDays: 0,
    oldestItem: { title: '', url: '', favDate: '', ageDays: 0 },
    newestItem: { title: '', url: '', favDate: '', daysAgo: 0 },
    burstMonth: { month: '', count: 0 },
    monthly: {},
    topAuthors: [],
    decayBuckets: { '3天内': 0, '1周内': 0, '1月内': 0, '半年内': 0, '1年内': 0, '1年以上': 0 },
    persona: { type: '还没开始收藏', description: '收藏夹还是空的。去知乎收藏几条感兴趣的内容，再回来看看你的收藏人格。' },
    cards: null,
    digestion: null,
  };
}

// items: CollectionContentItem[]（含 ContentType/Url/FavTime/Title/Author 等元数据）
// 契约：FavTime 是秒级 Unix 时间戳（知乎收藏 API 口径），与 now 同单位；lib/mycard.mjs 的 72h 窗口同理
// now: 秒级时间戳；cards/digestion 由调用方可选附加（评委报告没有卡片统计）
// 秒级时间戳在 5138 年前不可能超过 1e11，超过即视为毫秒级脏数据
const FAVTIME_MS_SUSPECT = 1e11;
export function computeReport(items, now = Math.floor(Date.now() / 1000)) {
  // 脏数据防护（issue #50）：FavTime 缺失/非数字会破坏排序与全部时间统计，整条剔除；
  // 毫秒级时间戳（> 1e11，#56）会把所有日期放大 1000 倍，同样剔除并告警一次
  let warnedMs = false;
  const valid = items.filter((it) => {
    if (!it || !Number.isFinite(it.FavTime)) return false;
    if (it.FavTime > FAVTIME_MS_SUSPECT) {
      if (!warnedMs) { warnedMs = true; console.warn('[report] FavTime 疑似毫秒级时间戳，已按脏数据剔除:', it.Url || it.Title || '(unknown)'); }
      return false;
    }
    return true;
  });
  if (!valid.length) return emptyReport(now);

  // 类型分布（ContentType 缺失归为「未知」，不产生 "undefined" 键）
  const typeDist = {};
  for (const it of valid) typeDist[it.ContentType || '未知'] = (typeDist[it.ContentType || '未知'] || 0) + 1;

  // 时间线
  const sorted = [...valid].sort((a, b) => a.FavTime - b.FavTime);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const spanDays = Math.round((newest.FavTime - oldest.FavTime) / DAY);

  // 月度直方图
  const monthly = {};
  for (const it of valid) {
    const m = fmt(it.FavTime).slice(0, 7);
    monthly[m] = (monthly[m] || 0) + 1;
  }

  // 收藏爆发期（单月最多；并列时取最近月份，破平确定——issue #50）
  const burstMonth = Object.entries(monthly).sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];

  // 最常收藏的作者
  const authorCount = {};
  for (const it of valid) {
    const name = it.Author?.Name;
    if (name) authorCount[name] = (authorCount[name] || 0) + 1;
  }
  const topAuthors = Object.entries(authorCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // 衰减曲线：按收藏距今时长分桶（时钟偏差/脏数据导致 FavTime 在未来时按「刚刚收藏」计，issue #50）
  const buckets = { '3天内': 0, '1周内': 0, '1月内': 0, '半年内': 0, '1年内': 0, '1年以上': 0 };
  for (const it of valid) {
    const age = Math.max(now - it.FavTime, 0);
    if (age <= 3 * DAY) buckets['3天内']++;
    else if (age <= 7 * DAY) buckets['1周内']++;
    else if (age <= 30 * DAY) buckets['1月内']++;
    else if (age <= 182 * DAY) buckets['半年内']++;
    else if (age <= 365 * DAY) buckets['1年内']++;
    else buckets['1年以上']++;
  }

  // 收藏人格判定（简单启发式，后续可调）
  const dormantDays = Math.max(Math.round((now - newest.FavTime) / DAY), 0);
  const maxMonthShare = burstMonth[1] / valid.length;
  let persona, personaDesc;
  if (dormantDays > DORMANT_DAYS) {
    persona = '冬眠型';
    personaDesc = `已经 ${dormantDays} 天没有新收藏了，收藏夹在沉睡`;
  } else if (maxMonthShare > BURST_MONTH_SHARE) {
    persona = '爆发型囤积者';
    personaDesc = `${burstMonth[0]} 月一口气收藏了 ${burstMonth[1]} 条，占全部的 ${Math.round(maxMonthShare * 100)}%`;
  } else if (spanDays >= SQUIRREL_MIN_SPAN_DAYS && valid.length / spanDays * 365 > SQUIRREL_ANNUAL_RATE) {
    persona = '松鼠型';
    personaDesc = '常年稳定囤积，年均收藏超过 50 条';
  } else {
    persona = '三分钟热度型';
    personaDesc = '收藏节奏断断续续，热情来得快去得也快';
  }

  return {
    generatedAt: now * 1000,
    total: valid.length,
    typeDist,
    spanDays,
    oldestItem: { title: oldest.Title, url: oldest.Url, favDate: fmt(oldest.FavTime), ageDays: Math.max(Math.round((now - oldest.FavTime) / DAY), 0) },
    newestItem: { title: newest.Title, url: newest.Url, favDate: fmt(newest.FavTime), daysAgo: dormantDays },
    burstMonth: { month: burstMonth[0], count: burstMonth[1] },
    monthly,
    topAuthors,
    decayBuckets: buckets,
    persona: { type: persona, description: personaDesc },
    cards: null,
    digestion: null,
  };
}
