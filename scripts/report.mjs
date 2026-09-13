// 收藏考古报告：纯元数据计算，零接口消耗 -> data/report.json
// 核心计算在 lib/report-core.mjs（server.mjs 给 OAuth 用户现场算报告时复用）
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeReport } from '../lib/report-core.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const data = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
const items = data.items;

const report = computeReport(items);

// 领域分布 + 收藏 vs 消化比（join 卡片目录，零接口消耗）
try {
  const cardsDir = path.join(root, 'data', 'cache', 'cards');
  const files = (await readdir(cardsDir)).filter((f) => f.endsWith('.json'));
  const tagCount = {};
  const statusCount = {};
  let parsed = 0;
  for (const f of files) {
    let card;
    try {
      card = JSON.parse(await readFile(path.join(cardsDir, f), 'utf8'));
    } catch (e) {
      console.warn(`跳过损坏卡片 ${f}: ${e.message.slice(0, 80)}`);
      continue;
    }
    parsed++;
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
  report.cards = {
    total: parsed,
    corrupt: files.length - parsed,
    statusCount,
    // 计数口径：标签出现次数（每张卡 2-4 个标签）
    domainDist: Object.entries(domainCount).sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count })),
    topTags: Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([tag, count]) => ({ tag, count })),
  };
  report.digestion = {
    collected: items.length,
    approved: statusCount.approved || 0,
    // 占位口径：approved 卡片数 / 总收藏数；真实消化比待复习队列 digested 状态上线
    ratio: items.length ? +((statusCount.approved || 0) / items.length).toFixed(2) : 0,
  };
} catch (e) {
  console.warn(`cards 统计跳过: ${e.message.slice(0, 120)}`);
}

await writeFile(path.join(root, 'data', 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ total: report.total, spanDays: report.spanDays, persona: report.persona, burstMonth: report.burstMonth, oldest: report.oldestItem.title?.slice(0, 20), dormantDays: report.newestItem.daysAgo }, null, 2));
