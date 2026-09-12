// 朝花夕拾 Web 服务：静态页面 + 卡片/报告/复习队列 API
// vanilla Node，无构建步骤
import http from 'node:http';
import { readFile, readdir, writeFile, rename, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;
const DAY = 86400;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function loadCards() {
  const dir = path.join(root, 'data', 'cache', 'cards');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const cards = [];
  for (const f of files) {
    try { cards.push(JSON.parse(await readFile(path.join(dir, f), 'utf8'))); } catch { /* skip */ }
  }
  return cards;
}

// 复习队列：72h 新收藏 > 到期复习 > 老收藏补位，每日 min(3, 到期数)
function buildQueue(cards) {
  const now = Math.floor(Date.now() / 1000);
  const approved = cards.filter((c) => c.status === 'approved');
  const fresh = approved.filter((c) => now - (c.source?.favTime ?? 0) <= 3 * DAY)
    .sort((a, b) => b.source.favTime - a.source.favTime);
  const due = approved.filter((c) => now - (c.source?.favTime ?? 0) > 3 * DAY && (c.nextReviewAt ?? 0) <= now)
    .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));
  const backlog = approved.filter((c) => !fresh.includes(c) && !due.includes(c))
    .sort((a, b) => (b.source?.favTime ?? 0) - (a.source?.favTime ?? 0));
  const queue = [...fresh, ...due, ...backlog];
  return { today: queue.slice(0, 3), upNext: queue.slice(3, 9), stats: { approved: approved.length, fresh: fresh.length, due: due.length } };
}

const INTERVALS = [1 * DAY, 3 * DAY, 7 * DAY]; // 复习间隔：+1/+3/+7 天后 digested

// ---- Server酱每日推送 ----
const SENDKEY = process.env.SCT_SENDKEY || '';
const SITE_BASE = (process.env.SITE_BASE_URL || 'https://lnuhxmgreuxd.sealoshzh.site').replace(/\/+$/, '');
const PUSH_STATE = path.join(root, 'data', 'push-state.json');
const DEAD_LETTER = path.join(root, 'data', 'push-deadletter.jsonl');

// 容器时区不可靠，固定按 UTC+8（中国无夏令时）计算「下一个 08:00」
function msUntilNext8AM() {
  const now = Date.now();
  const cstNow = new Date(now + 8 * 3600 * 1000); // UTC 字段按 CST 墙钟解读
  const cstNext = new Date(cstNow);
  cstNext.setUTCHours(8, 0, 0, 0);
  if (cstNext <= cstNow) cstNext.setUTCDate(cstNext.getUTCDate() + 1);
  return cstNext.getTime() - 8 * 3600 * 1000 - now;
}

// 选卡 → 组装 Server酱消息 → 指数退避重试（1s/5s/25s），仍失败记死信
async function pushDailyCards(trigger = 'cron') {
  const { today } = buildQueue(await loadCards());
  if (today.length === 0) { console.log('[push] 今日队列为空，跳过'); return { pushed: 0 }; }
  const title = `朝花夕拾｜今日 ${today.length} 张复习卡`;
  const desp = today.map((c, i) =>
    `### ${i + 1}. 《${c.source.title}》\n\n${c.coreView}\n\n[趁还记得为什么收藏它，花 2 分钟看完 →](${SITE_BASE}/#${c.id})`
  ).join('\n\n---\n\n');
  const delays = [1000, 5000, 25000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const resp = await fetch(`https://sctapi.ftqq.com/${SENDKEY}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, desp }),
      });
      const result = await resp.json();
      if (result.code === 0) {
        console.log(`[push] 成功（${trigger}），${today.length} 张`);
        return { pushed: today.length };
      }
      lastErr = new Error(`Server酱 code=${result.code}: ${result.message}`);
    } catch (e) { lastErr = e; }
    if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  const record = { at: new Date().toISOString(), trigger, error: String(lastErr), cards: today.map((c) => c.id) };
  await appendFile(DEAD_LETTER, JSON.stringify(record) + '\n');
  console.error('[push] 重试 3 次均失败，已记死信：', lastErr);
  return { pushed: 0, error: String(lastErr) };
}

// cron 入口：每天只推一次（日期状态落盘，容器重启不重复推）
async function dailyPushJob() {
  let pushedDate = '';
  try { pushedDate = JSON.parse(await readFile(PUSH_STATE, 'utf8')).date || ''; } catch { /* 首次 */ }
  const todayCst = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (pushedDate === todayCst) { console.log('[push] 今日已推送过，跳过'); return; }
  const result = await pushDailyCards('cron');
  if (result.pushed > 0) {
    const tmp = PUSH_STATE + '.tmp';
    await writeFile(tmp, JSON.stringify({ date: todayCst, at: Date.now() }));
    await rename(tmp, PUSH_STATE);
  }
}

function scheduleDailyPush() {
  if (!SENDKEY) { console.log('[push] 未配置 SCT_SENDKEY，每日推送未启用'); return; }
  const tick = () => {
    dailyPushJob().catch((e) => console.error('[push] 调度异常：', e));
    setTimeout(tick, msUntilNext8AM());
  };
  const wait = msUntilNext8AM();
  console.log(`[push] 每日 08:00（UTC+8）推送已调度，${Math.round(wait / 60000)} 分钟后首次触发`);
  setTimeout(tick, wait);
}

async function markReviewed(id) {
  const file = path.join(root, 'data', 'cache', 'cards', `${id}.json`);
  const card = JSON.parse(await readFile(file, 'utf8'));
  card.reviewCount = (card.reviewCount ?? 0) + 1;
  const now = Math.floor(Date.now() / 1000);
  if (card.reviewCount >= 3) {
    card.status = 'digested';
    card.nextReviewAt = null;
  } else {
    card.nextReviewAt = now + INTERVALS[card.reviewCount - 1];
  }
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(card, null, 2));
  await rename(tmp, file);
  return card;
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/health') return json(res, { ok: true, project: 'zhaohuaxishi' });
    if (url.pathname === '/api/report') {
      const report = JSON.parse(await readFile(path.join(root, 'data', 'report.json'), 'utf8'));
      return json(res, report);
    }
    if (url.pathname === '/api/cards') {
      const cards = await loadCards();
      const status = url.searchParams.get('status');
      const filtered = status ? cards.filter((c) => c.status === status) : cards;
      filtered.sort((a, b) => (b.reviewScore ?? 0) - (a.reviewScore ?? 0));
      return json(res, { total: filtered.length, cards: filtered });
    }
    if (url.pathname === '/api/queue') {
      return json(res, buildQueue(await loadCards()));
    }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      if (!id) return json(res, { ok: false, error: 'missing id' }, 400);
      return json(res, { ok: true, card: await markReviewed(id) });
    }
    // 手动触发当日推送（演示用；需 PUSH_TRIGGER_TOKEN，未配置则关闭）
    if (url.pathname === '/api/push/trigger' && req.method === 'POST') {
      const token = process.env.PUSH_TRIGGER_TOKEN;
      if (!token || url.searchParams.get('token') !== token) return json(res, { ok: false, error: 'forbidden' }, 403);
      const result = await pushDailyCards('manual');
      return json(res, { ok: result.pushed > 0, ...result });
    }
    // 静态文件
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(root, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(path.join(root, 'public'))) return json(res, { error: 'forbidden' }, 403);
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, { error: 'not found' }, 404);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => console.log(`朝花夕拾 → http://127.0.0.1:${PORT}/`));
scheduleDailyPush();
