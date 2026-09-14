// 朝花夕拾 Web 服务：静态页面 + 卡片/报告/复习队列 API
// vanilla Node，无构建步骤
// 单实例假设：OAuth 会话存进程内存；配额/订阅/卡册/快照等运行产物统一落 data/runtime/（Sealos 持久卷挂载点，见 HANDOFF.md）
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, readdir, writeFile, rename, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOAuth } from './lib/oauth.mjs';
import { computeReport } from './lib/report-core.mjs';
import { createAsk } from './lib/ask.mjs';
import { createMyCard } from './lib/mycard.mjs';
import { migrateRuntime, runtimeDir } from './lib/runtime.mjs';
import { cstDateStr, msUntilNextCst } from './lib/time.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;
const DAY = 86400;
const oauth = createOAuth();
const asker = createAsk(root);
const mycard = createMyCard(root);

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
    // reviewDetail（盲审判定明细）只在管线内部使用，不下发前端（#35：/api/cards 响应瘦身）
    delete c.reviewDetail;
    const a = authors.get(c.source?.url);
    if (!a) continue;
    c.source.authorUrlToken = a.UrlToken;
    const f = followees[a.UrlToken];
    if (f) { c.source.authorFollowed = true; c.source.authorAvatar = f.avatar; }
  }
  return cards;
}

// 匿名降敏（#43）：站主示例卡对匿名访客限量展示，并剥离原文链接/收藏时间/关注关系/头像
// 卡片标题与拆解内容是产品 demo 主体，保留公开（#38 温和版的取舍不变）
const ANON_CARD_LIMIT = 6;
function sanitizeCardPublic(c) {
  if (!c.source) return c;
  delete c.source.url;
  delete c.source.favTime;
  delete c.source.authorFollowed;
  delete c.source.authorAvatar;
  return c;
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
// 可变运行产物统一落 data/runtime/（Sealos 持久卷挂载点，发版不丢；lib/runtime.mjs）
const RUNTIME = runtimeDir(root);
const PUSH_STATE = path.join(RUNTIME, 'push-state.json');
const DEAD_LETTER = path.join(RUNTIME, 'push-deadletter.jsonl');
const SUBSCRIPTIONS = path.join(RUNTIME, 'push-subscriptions.json');
const MAX_SUBSCRIPTIONS = 100; // 不含站长 env key

// SendKey 是密钥：日志/死信只留前 8 位，完整值永不落日志
const maskKey = (k) => `${String(k).slice(0, 8)}…`;

// 订阅台账：{ "<uid>": { sendKey, name, subscribedAt } }，文件不存在按空处理
// 读-改-写用 Promise 链串行化（同 lib/ask.mjs 配额台账写法）
let subsLock = Promise.resolve();
function withSubsLock(fn) {
  const run = subsLock.then(fn);
  subsLock = run.catch(() => {});
  return run;
}
async function readSubs() {
  try { return JSON.parse(await readFile(SUBSCRIPTIONS, 'utf8')); } catch { return {}; }
}
async function writeSubs(subs) {
  const tmp = SUBSCRIPTIONS + '.tmp';
  await writeFile(tmp, JSON.stringify(subs, null, 2));
  await rename(tmp, SUBSCRIPTIONS);
}

// 容器时区不可靠，固定按 UTC+8（中国无夏令时）计算「下一个 08:00」（实现见 lib/time.mjs）
function msUntilNext8AM() {
  return msUntilNextCst(8);
}

// 向单个 SendKey 发一条消息，1s/5s/25s 指数退避重试 3 次
async function sendSct(sendKey, title, desp) {
  const delays = [1000, 5000, 25000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const resp = await fetch(`https://sctapi.ftqq.com/${sendKey}.send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, desp }),
      });
      const result = await resp.json();
      if (result.code === 0) return { ok: true };
      lastErr = new Error(`Server酱 code=${result.code}: ${result.message}`);
    } catch (e) { lastErr = e; }
    if (attempt < delays.length) await new Promise((r) => setTimeout(r, delays[attempt]));
  }
  return { ok: false, error: String(lastErr) };
}

// 订阅时的测试推送：单次不重试，errormsg 原样透传（Server酱错误信息不含密钥）
async function sendSctOnce(sendKey, title, desp) {
  try {
    const resp = await fetch(`https://sctapi.ftqq.com/${sendKey}.send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, desp }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await resp.json();
    if (result.code === 0) return { ok: true };
    return { ok: false, error: String(result.message || `Server酱 code=${result.code}`).slice(0, 200) };
  } catch { return { ok: false, error: '测试推送网络失败，请稍后重试' }; }
}

// 卡片列表 → Server酱消息体（站长通道与订阅者通道共用格式）
function cardsMsg(cards) {
  const title = `朝花夕拾｜今日 ${cards.length} 张复习卡`;
  const desp = cards.map((c, i) =>
    `### ${i + 1}. 《${c.source.title}》\n\n${c.coreView}\n\n[趁还记得为什么收藏它，花 2 分钟看完 →](${SITE_BASE}/#${c.id})`
  ).join('\n\n---\n\n');
  return { title, desp };
}

// 站长通道推全站卡库今日队列；订阅者各推自己卡册（mycard 台账）的今日队列，无到期卡时发炼卡提醒。各自独立重试，单失败不中断
async function pushDailyCards(trigger = 'cron') {
  const siteToday = buildQueue(await loadCardsEnriched()).today;

  // 站长通道：队列为空只跳过站长这一路，不挡订阅者的个人推送
  let owner = { ok: true };
  if (siteToday.length === 0) {
    console.log('[push] 站长今日队列为空，跳过站长通道');
  } else {
    const { title, desp } = cardsMsg(siteToday);
    owner = await sendSct(SENDKEY, title, desp);
    if (!owner.ok) {
      const record = { at: new Date().toISOString(), trigger, error: owner.error, cards: siteToday.map((c) => c.id) };
      await appendFile(DEAD_LETTER, JSON.stringify(record) + '\n');
      console.error('[push] 站长推送重试 3 次均失败，已记死信：', owner.error);
    } else {
      console.log(`[push] 站长推送成功（${trigger}），${siteToday.length} 张`);
    }
  }

  // 订阅者推送：每人独立组个人队列；卡册读取或发送失败都记死信（uid + sendKey 脱敏），不影响其他订阅者
  const subs = await readSubs();
  const entries = Object.entries(subs);
  let subOk = 0;
  let subFail = 0;
  for (const [uid, sub] of entries) {
    let msg;
    let cardIds = [];
    try {
      const mine = buildQueue(await mycard.listCards(uid)).today;
      if (mine.length > 0) {
        msg = cardsMsg(mine);
        cardIds = mine.map((c) => c.id);
      } else {
        msg = {
          title: '朝花夕拾｜今天没有到期复习卡',
          desp: `你的卡册里今天没有可复习的卡片（收藏库存可能已炼完）。\n\n[回网站看看，顺手刷新收藏库存 →](${SITE_BASE}/app.html#report)`,
        };
      }
    } catch (e) {
      subFail++;
      const record = { at: new Date().toISOString(), trigger, uid, sendKey: maskKey(sub.sendKey), error: `读取个人卡册失败：${String(e?.message || e)}`, cards: [] };
      await appendFile(DEAD_LETTER, JSON.stringify(record) + '\n');
      console.error(`[push] 订阅者 ${uid}（${maskKey(sub.sendKey)}）个人卡册读取失败，已记死信：`, e);
      continue;
    }
    const r = await sendSct(sub.sendKey, msg.title, msg.desp);
    if (r.ok) { subOk++; continue; }
    subFail++;
    const record = { at: new Date().toISOString(), trigger, uid, sendKey: maskKey(sub.sendKey), error: r.error, cards: cardIds };
    await appendFile(DEAD_LETTER, JSON.stringify(record) + '\n');
    console.error(`[push] 订阅者 ${uid}（${maskKey(sub.sendKey)}）推送失败，已记死信：`, r.error);
  }
  if (entries.length) console.log(`[push] 订阅者推送完成（${trigger}）：成功 ${subOk}，失败 ${subFail}`);

  // ownerOk 含「队列为空跳过」：当日已处理完毕，落盘防重启重推；只有站长通道真失败才留给下次重启重试
  return {
    pushed: owner.ok ? siteToday.length : 0,
    ownerOk: owner.ok,
    ...(owner.ok ? {} : { error: owner.error }),
    subs: { ok: subOk, fail: subFail },
  };
}

// cron 入口：每天只推一次（日期状态落盘，容器重启不重复推）
async function dailyPushJob() {
  let pushedDate = '';
  try { pushedDate = JSON.parse(await readFile(PUSH_STATE, 'utf8')).date || ''; } catch { /* 首次 */ }
  const todayCst = cstDateStr();
  if (pushedDate === todayCst) { console.log('[push] 今日已推送过，跳过'); return; }
  const result = await pushDailyCards('cron');
  // ownerOk 即「当日已处理」（含站长队列为空）：落盘防重启重推订阅者；站长通道失败则不落盘，留待重启重试
  if (result.ownerOk) {
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

// ---- 每日自动炼卡：07:00（UTC+8）给订阅用户从收藏快照炼新卡，赶在 08:00 推送前完工（实现见 lib/mycard.mjs autoMake）----
async function autoMakeJob() {
  const uids = Object.keys(await readSubs());
  if (!uids.length) { console.log('[mycard] 无订阅用户，自动炼卡跳过'); return; }
  await mycard.autoMake(uids);
}

function scheduleAutoMake() {
  const tick = () => {
    autoMakeJob().catch((e) => console.error('[mycard] 自动炼卡调度异常：', e));
    setTimeout(tick, msUntilNextCst(7));
  };
  const wait = msUntilNextCst(7);
  console.log(`[mycard] 每日 07:00（UTC+8）自动炼卡已调度，${Math.round(wait / 60000)} 分钟后首次触发`);
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

// 读请求体：超限后停止累积（返回 null），但继续排空剩余数据，避免半读响应导致连接被 RST
async function readBody(req, limit) {
  let body = '';
  let tooBig = false;
  for await (const chunk of req) {
    if (tooBig) continue;
    body += chunk;
    if (body.length > limit) { tooBig = true; body = ''; }
  }
  return tooBig ? null : body;
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

// 出口 IP：取 XFF 最后一跳（离本服务最近、由 Sealos 网关注入；首值可被客户端伪造轮换以绕过 IP 限流，issue #47）
// 无论网关是「覆写」还是「追加」XFF，最后一跳都是网关看到的真实客户端；直连时回退 socket.remoteAddress
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',').pop().trim() || req.socket.remoteAddress || 'unknown';

// 追问身份只认 OAuth 知乎 uid（issue #36：自报 UUID 头 / 匿名 cookie 全由客户端控制，轮换即重置配额，已关闭）
function askLogin(req, res) {
  const uid = oauth.currentUid(req, res);
  if (!uid) {
    json(res, { ok: false, error: '追问需要先登录知乎', loginRequired: true }, 401);
    return null;
  }
  return uid;
}

// ---- 路由表（issue #33）：方法白名单从表自动推导——GET/HEAD 放行所有路径，其他方法仅表内登记路径 ----
// 错误→状态码统一映射：handler 抛出带 code 的错误由分发层兜底（ENOENT→404 / LOGIN_REQUIRED→401 / ACCESS_SECRET_MISSING→503 / 其余→500）
const ROUTES = [
  { method: 'GET', path: '/api/health', handler: (req, res) => json(res, { ok: true, project: 'zhaohuaxishi', sessions: oauth.sessionCount() }) },

  // ---- 知乎 OAuth（黑客松流程，lib/oauth.mjs）----
  { method: 'GET', path: '/api/oauth/status', handler: (req, res) => json(res, oauth.status(req, res)) },
  {
    method: 'GET', path: '/auth/login', handler: (req, res) => {
      try { return redirect(res, oauth.loginUrl(req, res)); }
      catch (e) {
        console.error('[oauth] login 发起失败：', e.message);
        return json(res, { ok: false, error: e.message }, 503);
      }
    },
  },
  {
    method: 'GET', path: '/auth/callback', handler: async (req, res, url) => {
      try {
        await oauth.handleCallback(req, res, url);
        return redirect(res, '/app.html#report?oauth=ok');
      } catch (e) {
        // 错误明细只进服务端日志，不进 URL（防敏感信息泄露 + 防开放重定向注入）
        console.error('[oauth] 回调处理失败：', e.code || '', e.message);
        return redirect(res, '/app.html#report?oauth=error');
      }
    },
  },
  {
    method: 'POST', path: '/api/oauth/logout', handler: (req, res) => {
      oauth.logout(req, res);
      return json(res, { ok: true });
    },
  },
  // 评委自己的收藏考古报告：只拉元数据现场算，不炼卡（SPEC 能力矩阵）
  {
    method: 'GET', path: '/api/my/report', handler: async (req, res) => {
      try {
        const { items, meta } = await oauth.fetchMyFavorites(req, res);
        // 顺手刷新收藏快照（每日自动炼卡的原料）；失败不影响报告
        const uid = oauth.currentUid(req, res);
        if (uid) mycard.saveFavSnapshot(uid, items).catch((e) => console.warn('[mycard] 收藏快照保存失败：', e.message));
        return json(res, { ok: true, meta, report: computeReport(items) });
      } catch (e) {
        if (e.code === 'LOGIN_REQUIRED' || e.code === 'ACCESS_SECRET_MISSING') throw e; // 交分发层统一映射
        console.error('[oauth] 评委报告生成失败：', e.code || '', e.message);
        return json(res, { ok: false, error: e.message }, 502);
      }
    },
  },

  // 现场炼卡：登录用户每天 1 张、全站每天 20 张先到先得（lib/mycard.mjs：异步任务 + 落盘恢复，收藏走 fetchMyFavorites 会话缓存）
  {
    method: 'POST', path: '/api/my/card', handler: async (req, res) => {
      const uid = oauth.currentUid(req, res);
      if (!uid) return json(res, { ok: false, error: 'loginRequired', loginRequired: true }, 401);
      const r = await mycard.start(uid, async () => {
        const favs = await oauth.fetchMyFavorites(req, res);
        // 顺手刷新收藏快照；失败不影响炼卡
        mycard.saveFavSnapshot(uid, favs.items).catch((e) => console.warn('[mycard] 收藏快照保存失败：', e.message));
        return favs;
      });
      return json(res, r.body, r.code);
    },
  },
  {
    method: 'GET', path: '/api/my/card', handler: async (req, res) => {
      const uid = oauth.currentUid(req, res);
      if (!uid) return json(res, { ok: false, error: 'loginRequired', loginRequired: true }, 401);
      return json(res, await mycard.statusFor(uid));
    },
  },

  // ---- 追问：卡片详情接直答，每登录用户每日 2 次 + 每出口 IP 每日硬顶，缓存命中免费（SPEC「追问限流实现」）----
  {
    method: 'GET', path: '/api/ask/quota', handler: async (req, res) => {
      const uid = askLogin(req, res);
      if (!uid) return;
      return json(res, { ok: true, ...(await asker.quotaFor(uid, clientIp(req))) });
    },
  },
  {
    method: 'POST', path: '/api/ask', handler: async (req, res) => {
      const uid = askLogin(req, res);
      if (!uid) return;
      const body = await readBody(req, 4096);
      if (body === null) return json(res, { ok: false, error: '请求体过大' }, 413);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: 'bad json' }, 400); }
      const { cardId, question } = parsed;
      if (!/^[\w-]+$/.test(String(cardId || ''))) return json(res, { ok: false, error: 'invalid cardId' }, 400);
      const q = String(question || '').trim();
      if (!q || q.length > asker.MAX_QUESTION_LEN) {
        return json(res, { ok: false, error: `问题需 1-${asker.MAX_QUESTION_LEN} 字` }, 400);
      }
      let card = (await loadCardsEnriched()).find((c) => c.id === cardId);
      // 用户自己的卡册（现场炼卡产出）也可追问
      if (!card) card = (await mycard.listCards(uid)).find((c) => c.id === cardId);
      if (!card) return json(res, { ok: false, error: '卡片不存在' }, 404);
      try {
        const result = await asker.ask(uid, card, q, clientIp(req));
        if (!result.ok && result.quotaExceeded) return json(res, result, 429);
        if (!result.ok && result.notReady) return json(res, result, 503);
        return json(res, result);
      } catch (e) {
        console.error('[ask] 直答调用失败：', e.message);
        return json(res, { ok: false, error: '直答服务暂时不可用，请稍后重试' }, 502);
      }
    },
  },

  {
    method: 'GET', path: '/api/report', handler: async (req, res) => {
      const report = JSON.parse(await readFile(path.join(root, 'data', 'report.json'), 'utf8'));
      // 匿名访客只给脱敏聚合版：人格画像/最老收藏/领域分布属站主隐私（issue #38）
      if (!oauth.currentUid(req, res)) {
        return json(res, {
          sanitized: true,
          total: report.total,
          spanDays: report.spanDays,
          decayBuckets: report.decayBuckets,
          monthly: report.monthly,
          newestItem: report.newestItem ? { daysAgo: report.newestItem.daysAgo } : null,
        });
      }
      return json(res, report);
    },
  },
  {
    method: 'GET', path: '/api/cards', handler: async (req, res, url) => {
      // scope=mine：登录用户只看自己的卡册（现场炼卡产出），站长示例完全不可见
      if (url.searchParams.get('scope') === 'mine') {
        const uid = oauth.currentUid(req, res);
        if (!uid) return json(res, { ok: false, error: 'loginRequired', loginRequired: true }, 401);
        const mine = await mycard.listCards(uid);
        const status = url.searchParams.get('status');
        const filtered = status ? mine.filter((c) => c.status === status) : mine;
        filtered.sort((a, b) => (b.source?.favTime ?? 0) - (a.source?.favTime ?? 0));
        return json(res, { total: filtered.length, cards: filtered });
      }
      const cards = await loadCardsEnriched();
      const status = url.searchParams.get('status');
      const filtered = status ? cards.filter((c) => c.status === status) : cards;
      // 全员盲审 5 分，分数排序无信息量，改按收藏时间倒序
      filtered.sort((a, b) => (b.source?.favTime ?? 0) - (a.source?.favTime ?? 0));
      // 匿名访客：限量示例 + 剥离收藏时间/原文链接/关注关系（#43）；total 仍为全量数
      if (!oauth.currentUid(req, res)) {
        return json(res, { total: filtered.length, cards: filtered.slice(0, ANON_CARD_LIMIT).map(sanitizeCardPublic), sanitized: true });
      }
      return json(res, { total: filtered.length, cards: filtered });
    },
  },
  {
    method: 'GET', path: '/api/queue', handler: async (req, res, url) => {
      // scope=mine：登录用户的复习队列只由自己的卡册构成
      if (url.searchParams.get('scope') === 'mine') {
        const uid = oauth.currentUid(req, res);
        if (!uid) return json(res, { ok: false, error: 'loginRequired', loginRequired: true }, 401);
        return json(res, buildQueue(await mycard.listCards(uid)));
      }
      const queue = buildQueue(await loadCardsEnriched());
      if (!oauth.currentUid(req, res)) {
        for (const c of [...queue.today, ...queue.upNext]) sanitizeCardPublic(c);
        delete queue.stats.followed;
      }
      return json(res, queue);
    },
  },
  {
    method: 'POST', path: '/api/review', handler: async (req, res) => {
      const body = await readBody(req, 1e6);
      if (body === null) return json(res, { ok: false, error: 'payload too large' }, 413);
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { return json(res, { ok: false, error: 'invalid json' }, 400); }
      const { id, scope } = payload;
      if (!id) return json(res, { ok: false, error: 'missing id' }, 400);
      // id 白名单校验：合法格式 card_<key>，防路径穿越写出 cards 目录
      if (!/^[\w-]+$/.test(id)) return json(res, { ok: false, error: 'invalid id' }, 400);
      // scope=mine：复习进度写到用户自己的卡册，绝不动站长卡片（同 id 收藏可能两边都存在）
      if (scope === 'mine') {
        const uid = oauth.currentUid(req, res);
        if (!uid) return json(res, { ok: false, error: 'loginRequired', loginRequired: true }, 401);
        const card = await mycard.markReviewed(uid, id);
        if (!card) return json(res, { ok: false, error: '卡片不存在' }, 404);
        return json(res, { ok: true, card });
      }
      return json(res, { ok: true, card: await markReviewed(id) });
    },
  },
  // 手动触发当日推送（演示用；需 PUSH_TRIGGER_TOKEN，未配置则关闭）
  {
    method: 'POST', path: '/api/push/trigger', handler: async (req, res) => {
      const token = process.env.PUSH_TRIGGER_TOKEN;
      // token 走请求头（URL query 会进网关/访问日志），常量时间比较
      const given = Buffer.from(req.headers['x-push-token'] ?? '');
      const want = Buffer.from(token ?? '');
      const ok = given.length > 0 && given.length === want.length && timingSafeEqual(given, want);
      if (!ok) return json(res, { ok: false, error: 'forbidden' }, 403);
      if (!SENDKEY) return json(res, { ok: false, error: 'SCT_SENDKEY 未配置' }, 503);
      const result = await pushDailyCards('manual');
      return json(res, { ok: result.pushed > 0, ...result });
    },
  },

  // ---- 微信订阅推送：知乎登录用户绑自己的 Server酱 SendKey；每日 07:00 自动从收藏快照炼新卡，08:00 推自己卡册的到期复习卡 ----
  {
    method: 'GET', path: '/api/push/subscription', handler: async (req, res) => {
      const uid = oauth.currentUid(req, res);
      if (!uid) return json(res, { ok: false, error: 'loginRequired' }, 401);
      const subs = await readSubs();
      // 不回传 sendKey（密钥不出库）
      return json(res, { ok: true, subscribed: Boolean(subs[uid]) });
    },
  },
  {
    method: 'POST', path: '/api/push/subscribe', handler: async (req, res) => {
      const uid = oauth.currentUid(req, res);
      if (!uid) return json(res, { ok: false, error: 'loginRequired' }, 401);
      const body = await readBody(req, 4096);
      if (body === null) return json(res, { ok: false, error: '请求体过大' }, 413);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch { return json(res, { ok: false, error: 'bad json' }, 400); }
      const sendKey = String(parsed.sendKey ?? '').trim();
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sendKey)) {
        return json(res, { ok: false, error: 'SendKey 格式不正确（1-128 位，仅限字母/数字/_/-）' }, 400);
      }
      // 名额预检（写库前在锁内还会复核一次，并发订阅不超上限；同 uid 重复订阅=覆盖，不占新名额）
      const precheck = await withSubsLock(async () => {
        const subs = await readSubs();
        return { full: !subs[uid] && Object.keys(subs).length >= MAX_SUBSCRIPTIONS };
      });
      if (precheck.full) return json(res, { ok: false, error: '订阅名额已满（100）' }, 429);
      // 先验后写：测试推送通过才入库，失败透传 Server酱 errormsg
      const test = await sendSctOnce(sendKey, '朝花夕拾 · 订阅成功', '订阅成功！每天自动把你的收藏炼成新卡；每日 08:00（UTC+8）微信推送你卡册里的到期复习卡（最多 3 张）。');
      if (!test.ok) return json(res, { ok: false, error: `测试推送失败：${test.error}` }, 422);
      const written = await withSubsLock(async () => {
        const subs = await readSubs();
        if (!subs[uid] && Object.keys(subs).length >= MAX_SUBSCRIPTIONS) return false;
        subs[uid] = { sendKey, name: null, subscribedAt: Date.now() };
        await writeSubs(subs);
        return true;
      });
      if (!written) return json(res, { ok: false, error: '订阅名额已满（100）' }, 429);
      console.log(`[push] 新订阅 ${uid}（${maskKey(sendKey)}）`);
      // 订阅即建收藏快照，明早自动炼卡就有米下锅；拉取/保存失败不影响订阅本身
      oauth.fetchMyFavorites(req, res)
        .then(({ items }) => mycard.saveFavSnapshot(uid, items))
        .catch((e) => console.warn('[mycard] 订阅时收藏快照失败（不影响订阅）：', e.message));
      return json(res, { ok: true });
    },
  },
  {
    method: 'POST', path: '/api/push/unsubscribe', handler: async (req, res) => {
      const uid = oauth.currentUid(req, res);
      if (!uid) return json(res, { ok: false, error: 'loginRequired' }, 401);
      await withSubsLock(async () => {
        const subs = await readSubs();
        if (subs[uid]) {
          delete subs[uid];
          await writeSubs(subs);
        }
      });
      return json(res, { ok: true });
    },
  },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    // 方法白名单从路由表推导；HEAD 复用 GET handler（Node 自动省略响应体）
    const route = ROUTES.find((r) => r.path === url.pathname
      && (r.method === req.method || (req.method === 'HEAD' && r.method === 'GET')));
    const methodOk = req.method === 'GET' || req.method === 'HEAD'
      || ROUTES.some((r) => r.path === url.pathname && r.method === req.method);
    if (!methodOk) return json(res, { ok: false, error: 'method not allowed' }, 405);
    if (route) return await route.handler(req, res, url); // await 不能省：让 handler 的异常落进下面的统一映射
    // 静态文件
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(root, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(path.join(root, 'public'))) return json(res, { error: 'forbidden' }, 403);
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, { error: 'not found' }, 404);
    if (e.code === 'LOGIN_REQUIRED') return json(res, { ok: false, error: e.message, loginRequired: true }, 401);
    if (e.code === 'ACCESS_SECRET_MISSING') return json(res, { ok: false, error: e.message, notReady: true }, 503);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => console.log(`朝花夕拾 → http://127.0.0.1:${PORT}/`));
await migrateRuntime(root); // 老位置运行产物搬进 data/runtime/，再开调度（防调度先跑读空台账）
scheduleAutoMake();
scheduleDailyPush();
