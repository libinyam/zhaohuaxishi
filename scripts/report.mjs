// 收藏考古报告：纯元数据计算，零接口消耗 -> data/report.json
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
const items = data.items;
const now = Date.now() / 1000;
const DAY = 86400;

const fmt = (t) => new Date(t * 1000).toISOString().slice(0, 10);

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

const report = {
  generatedAt: Date.now(),
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
};

await writeFile(path.join(root, 'data', 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ total: report.total, spanDays, persona, burstMonth: report.burstMonth, oldest: report.oldestItem.title?.slice(0, 20), dormantDays }, null, 2));
