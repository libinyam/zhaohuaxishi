// 收藏考古报告：纯元数据计算，零接口消耗 -> data/report.json
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
const items = data.items;
const now = Date.now() / 1000;
const DAY = 86400;

// 本地时区切日（UTC 会把月末最后一天 16:00 后的收藏算进下个月）
const fmt = (t) => {
  const d = new Date(t * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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

// 领域分布 + 收藏 vs 消化比（join 卡片目录，零接口消耗）
let cards = null;
let digestion = null;
try {
  const cardsDir = path.join(root, 'data', 'cache', 'cards');
  const files = (await readdir(cardsDir)).filter((f) => f.endsWith('.json'));
  const tagCount = {};
  const statusCount = {};
  for (const f of files) {
    const card = JSON.parse(await readFile(path.join(cardsDir, f), 'utf8'));
    statusCount[card.status] = (statusCount[card.status] || 0) + 1;
    for (const t of card.topicTags || []) tagCount[t] = (tagCount[t] || 0) + 1;
  }
  // 长尾标签归并为顶层领域，避免上百个标签直接糊上报告
  const DOMAINS = [
    ['数学', /数学|代数|几何|数论|微积分|概率|统计|圆锥曲线|函数|方程|分析|拓扑|矩阵|积分|极限|不等式|逼近|定理|行列式|多项式|数列|优化|控制|动力系统|试题|解题|微分|导数|级数|猜想|证明|化归|不动点|内积|实数|复数|集合论|插值|渐近|极值|连分数|竞赛|备考|高考|期末|应试|试卷|联赛/],
    ['编程/CS', /编程|计算机|算法|代码|Python|Java|前端|后端|机器学习|深度学习|AI|神经网络|检索|大模型/i],
    ['自然科学', /物理|化学|生物|天文|地理|科普/],
    ['人文社科', /历史|哲学|经济|心理|社会|政治|文学|法律|写作|叙事|奇幻|九州|考证|人际|亲密|送礼|沟通|诗词|小说|美学|审美/],
    ['学习方法', /学习|思维模型|知识转化|内容创作/],
  ];
  const domainCount = {};
  for (const [tag, count] of Object.entries(tagCount)) {
    const domain = DOMAINS.find(([, re]) => re.test(tag))?.[0] ?? '其他';
    domainCount[domain] = (domainCount[domain] || 0) + count;
  }
  cards = {
    total: files.length,
    statusCount,
    // 计数口径：标签出现次数（每张卡 2-4 个标签）
    domainDist: Object.entries(domainCount).sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count })),
    topTags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count })),
  };
  digestion = {
    collected: items.length,
    approved: statusCount.approved || 0,
    // 占位口径：approved 卡片数 / 总收藏数；真实消化比待复习队列 digested 状态上线
    ratio: items.length ? +((statusCount.approved || 0) / items.length).toFixed(2) : 0,
  };
} catch { /* 卡片目录不存在则跳过 */ }

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
  cards,
  digestion,
};

await writeFile(path.join(root, 'data', 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ total: report.total, spanDays, persona, burstMonth: report.burstMonth, oldest: report.oldestItem.title?.slice(0, 20), dormantDays }, null, 2));
