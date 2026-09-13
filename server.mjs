// 朝花夕拾 Web 服务：静态页面 + 卡片/报告/复习队列 API
// vanilla Node，无构建步骤
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, readdir, writeFile, rename, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOAuth } from './lib/oauth.mjs';
import { computeReport } from './lib/report-core.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;
const DAY = 86400;
const oauth = createOAuth();

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

async function loadCards() {
  const dir = path.join(root, 'data', 'cache', 'cards');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const cards = [];
  for (const f of files) {
    try { cards.push(JSON.parse(await readFile(path.join(dir, f), 'utf8'))); } catch { /* skip */ }
  }
  return cards;
}

// 关注数据：收藏 URL → 作者 UrlToken → 是否已关注（scripts/fetch-followees.mjs 生成）
async function loadFollowees() {
  try {
    const d = JSON.parse(await readFile(path.join(root, 'data', 'followees.json'), 'utf8'));
    return d.followees || {};
  } catch { return {}; }
}

async function loadAuthorIndex() {
  try {
    const d = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
    const m = new Map();
    for (const it of d.items || []) if (it.Url && it.Author?.UrlToken) m.set(it.Url, it.Author);
    return m;
  } catch { return new Map(); }
}

async function loadCardsEnriched() {
  const [cards, followees, authors] = await Promise.all([loadCards(), loadFollowees(), loadAuthorIndex()]);
  for (const c of cards) {
    const a = authors.get(c.source?.url);
    if (!a) continue;
    c.source.authorUrlToken = a.UrlToken;
    const f = followees[a.UrlToken];
    if (f) { c.source.authorFollowed = true; c.source.authorAvatar = f.avatar; }
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
  // 每层内已关注作者优先（sort 稳定，不打乱层内原有排序）
  const followedFirst = (arr) => arr.sort((a, b) => (b.source?.authorFollowed ? 1 : 0) - (a.source?.authorFollowed ? 1 : 0));
  const queue = [...followedFirst(fresh), ...followedFirst(due), ...followedFirst(backlog)];
  return { today: queue.slice(0, 3), upNext: queue.slice(3, 9), stats: { approved: approved.length, fresh: fresh.length, due: due.length, followed: approved.filter((c) => c.source?.authorFollowed).length } };
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
  const { today } = buildQueue(await loadCardsEnriched());
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

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // 方法白名单：只读端点只收 GET/HEAD，POST 仅限三个写端点，其余 405
    const POST_ROUTES = ['/api/review', '/api/push/trigger', '/api/oauth/logout'];
    const methodOk = req.method === 'GET' || req.method === 'HEAD'
      || (req.method === 'POST' && POST_ROUTES.includes(url.pathname));
    if (!methodOk) return json(res, { ok: false, error: 'method not allowed' }, 405);
    if (url.pathname === '/api/health') return json(res, { ok: true, project: 'zhaohuaxishi' });
    // ---- 知乎 OAuth（黑客松流程，lib/oauth.mjs）----
    if (url.pathname === '/api/oauth/status') return json(res, oauth.status(req, res));
    if (url.pathname === '/auth/login') {
      try { return redirect(res, oauth.loginUrl(req, res)); }
      catch (e) {
        console.error('[oauth] login 发起失败：', e.message);
        return json(res, { ok: false, error: e.message }, 503);
      }
    }
    if (url.pathname === '/auth/callback') {
      try {
        await oauth.handleCallback(req, res, url);
        return redirect(res, '/app.html#report?oauth=ok');
      } catch (e) {
        // 错误明细只进服务端日志，不进 URL（防敏感信息泄露 + 防开放重定向注入）
        console.error('[oauth] 回调处理失败：', e.code || '', e.message);
        return redirect(res, '/app.html#report?oauth=error');
      }
    }
    if (url.pathname === '/api/oauth/logout' && req.method === 'POST') {
      oauth.logout(req, res);
      return json(res, { ok: true });
    }
    // 评委自己的收藏考古报告：只拉元数据现场算，不炼卡（SPEC 能力矩阵）
    if (url.pathname === '/api/my/report') {
      try {
        const { items, meta } = await oauth.fetchMyFavorites(req, res);
        return json(res, { ok: true, meta, report: computeReport(items) });
      } catch (e) {
        if (e.code === 'LOGIN_REQUIRED') return json(res, { ok: false, error: e.message, loginRequired: true }, 401);
        if (e.code === 'ACCESS_SECRET_MISSING') return json(res, { ok: false, error: e.message, notReady: true }, 503);
        console.error('[oauth] 评委报告生成失败：', e.code || '', e.message);
        return json(res, { ok: false, error: e.message }, 502);
      }
    }
    if (url.pathname === '/api/report') {
      const report = JSON.parse(await readFile(path.join(root, 'data', 'report.json'), 'utf8'));
      return json(res, report);
    }
    if (url.pathname === '/api/cards') {
      const cards = await loadCardsEnriched();
      const status = url.searchParams.get('status');
      const filtered = status ? cards.filter((c) => c.status === status) : cards;
      // 全员盲审 5 分，分数排序无信息量，改按收藏时间倒序
      filtered.sort((a, b) => (b.source?.favTime ?? 0) - (a.source?.favTime ?? 0));
      return json(res, { total: filtered.length, cards: filtered });
    }
    if (url.pathname === '/api/queue') {
      return json(res, buildQueue(await loadCardsEnriched()));
    }
    if (url.pathname === '/api/followees') {
      const followees = await loadFollowees();
      const list = Object.values(followees).map((f) => ({ name: f.name, avatar: f.avatar }));
      return json(res, { total: list.length, followees: list });
    }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return json(res, { ok: false, error: 'invalid json' }, 400); }
      const { id } = payload;
      if (!id) return json(res, { ok: false, error: 'missing id' }, 400);
      // id 白名单校验：合法格式 card_<key>，防路径穿越写出 cards 目录
      if (!/^[\w-]+$/.test(id)) return json(res, { ok: false, error: 'invalid id' }, 400);
      return json(res, { ok: true, card: await markReviewed(id) });
    }
    // 手动触发当日推送（演示用；需 PUSH_TRIGGER_TOKEN，未配置则关闭）
    if (url.pathname === '/api/push/trigger' && req.method === 'POST') {
      const token = process.env.PUSH_TRIGGER_TOKEN;
      // token 走请求头（URL query 会进网关/访问日志），常量时间比较
      const given = Buffer.from(req.headers['x-push-token'] ?? '');
      const want = Buffer.from(token ?? '');
      const ok = given.length > 0 && given.length === want.length && timingSafeEqual(given, want);
      if (!ok) return json(res, { ok: false, error: 'forbidden' }, 403);
      if (!SENDKEY) return json(res, { ok: false, error: 'SCT_SENDKEY 未配置' }, 503);
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
