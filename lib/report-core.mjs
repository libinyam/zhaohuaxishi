// 收藏考古报告核心计算：纯函数，供 scripts/report.mjs（站主预生成）与 server.mjs（OAuth 用户现场算）复用
// 容器时区不可靠，固定按 UTC+8 切日（中国无夏令时），与 server.mjs 推送调度同思路
const DAY = 86400;
const CST_OFFSET = 8 * 3600 * 1000;

const fmt = (t) => {
  const d = new Date(t * 1000 + CST_OFFSET);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

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
// now: 秒级时间戳；cards/digestion 由调用方可选附加（评委报告没有卡片统计）
export function computeReport(items, now = Math.floor(Date.now() / 1000)) {
  if (!items.length) return emptyReport(now);

  // 类型分布
  const typeDist = {};
  for (const it of items) typeDist[it.ContentType] = (typeDist[it.ContentType] || 0) + 1;

  // 时间线
  const sorted = [...items].sort((a, b) => a.FavTime - b.FavTime);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const spanDays = Math.round((newest.FavTime - oldest.FavTime) / DAY);

  // 月度直方图
  const monthly = {};
  for (const it of items) {
    const m = fmt(it.FavTime).slice(0, 7);
    monthly[m] = (monthly[m] || 0) + 1;
  }

  // 收藏爆发期（单月最多）
  const burstMonth = Object.entries(monthly).sort((a, b) => b[1] - a[1])[0];

  // 最常收藏的作者
  const authorCount = {};
  for (const it of items) {
    const name = it.Author?.Name;
    if (name) authorCount[name] = (authorCount[name] || 0) + 1;
  }
  const topAuthors = Object.entries(authorCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  // 衰减曲线：按收藏距今时长分桶
  const buckets = { '3天内': 0, '1周内': 0, '1月内': 0, '半年内': 0, '1年内': 0, '1年以上': 0 };
  for (const it of items) {
    const age = now - it.FavTime;
    if (age <= 3 * DAY) buckets['3天内']++;
    else if (age <= 7 * DAY) buckets['1周内']++;
    else if (age <= 30 * DAY) buckets['1月内']++;
    else if (age <= 182 * DAY) buckets['半年内']++;
    else if (age <= 365 * DAY) buckets['1年内']++;
    else buckets['1年以上']++;
  }

  // 收藏人格判定（简单启发式，后续可调）
  const dormantDays = Math.round((now - newest.FavTime) / DAY);
  const maxMonthShare = burstMonth[1] / items.length;
  let persona, personaDesc;
  if (dormantDays > 180) {
    persona = '冬眠型';
    personaDesc = `已经 ${dormantDays} 天没有新收藏了，收藏夹在沉睡`;
  } else if (maxMonthShare > 0.4) {
    persona = '爆发型囤积者';
    personaDesc = `${burstMonth[0]} 月一口气收藏了 ${burstMonth[1]} 条，占全部的 ${Math.round(maxMonthShare * 100)}%`;
  } else if (items.length / Math.max(spanDays / 365, 0.1) > 50) {
    persona = '松鼠型';
    personaDesc = '常年稳定囤积，年均收藏超过 50 条';
  } else {
    persona = '三分钟热度型';
    personaDesc = '收藏节奏断断续续，热情来得快去得也快';
  }

  return {
    generatedAt: now * 1000,
    total: items.length,
    typeDist,
    spanDays,
    oldestItem: { title: oldest.Title, url: oldest.Url, favDate: fmt(oldest.FavTime), ageDays: Math.round((now - oldest.FavTime) / DAY) },
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
