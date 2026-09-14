// 端到端断言脚本：把人工走查过的用例固化下来防回归
// 在隔离副本上跑（复制 server.mjs/lib/public/data 到临时目录起服务），绝不碰真实数据
// Run: node scripts/test-e2e.mjs [--stress]
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReview } from '../lib/review.mjs';
import { computeReport } from '../lib/report-core.mjs';
import { msUntilNextCst } from '../lib/time.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stress = process.argv.includes('--stress') || process.env.E2E_STRESS === '1';

let pass = 0;
let fail = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    fail++;
    failures.push(name);
    console.log(`FAIL ${name} — ${e.message}`);
  }
}
function eq(actual, want, what) {
  if (actual !== want) throw new Error(`${what}：期望 ${want}，实际 ${actual}`);
}

// ---- 隔离副本 ----
const tmp = await mkdtemp(path.join(tmpdir(), 'zhsx-e2e-'));
for (const entry of ['server.mjs', 'lib', 'public', 'data']) {
  await cp(path.join(root, entry), path.join(tmp, entry), { recursive: true });
}

// 随机空闲端口
const port = await new Promise((resolve, reject) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
  s.on('error', reject);
});

// 显式清掉 OAuth / Server酱 / 直答配置：未配置 503、trigger 503 用例依赖这个前提
const env = { ...process.env, PORT: String(port), PUSH_TRIGGER_TOKEN: 'e2e-test-token' };
for (const k of ['SCT_SENDKEY', 'ZHIHU_OAUTH_APP_ID', 'ZHIHU_OAUTH_APP_KEY', 'ZHIHU_ACCESS_SECRET', 'SITE_BASE_URL']) {
  delete env[k];
}

const child = spawn(process.execPath, [path.join(tmp, 'server.mjs')], { cwd: tmp, env, stdio: ['ignore', 'pipe', 'pipe'] });
let childLog = '';
child.stdout.on('data', (c) => { childLog += c; });
child.stderr.on('data', (c) => { childLog += c; });

const base = `http://127.0.0.1:${port}`;
const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
const post = (p, body, headers = {}) =>
  get(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body });

// fetch（undici）会在客户端归一化点段，静态穿越用例必须发原始路径
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await get('/api/health');
      if (r.status === 200) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`服务 10s 内未就绪：\n${childLog}`);
}

// 从副本里挑一张真实卡片做打卡用例
async function pickCardId() {
  const dir = path.join(tmp, 'data', 'cache', 'cards');
  const f = (await readdir(dir)).find((x) => x.endsWith('.json'));
  const card = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
  return card.id;
}

try {
  await waitReady();
  const cardId = await pickCardId();

  await test('静态路由：GET / 200 text/html，GET /app.html 200', async () => {
    const home = await get('/');
    eq(home.status, 200, 'GET / 状态码');
    if (!(home.headers.get('content-type') || '').includes('text/html')) throw new Error('GET / Content-Type 不是 text/html');
    eq((await get('/app.html')).status, 200, 'GET /app.html 状态码');
  });

  await test('静态路由：不存在的路径 404', async () => {
    eq((await get('/no-such-page.html')).status, 404, '不存在页面状态码');
  });

  await test('方法白名单 405 全表', async () => {
    // 只读端点：GET/HEAD 放行，POST/PUT/DELETE/PATCH 一律 405
    const readRoutes = ['/', '/api/health', '/api/cards', '/api/report', '/api/queue', '/api/oauth/status', '/api/ask/quota', '/api/my/report', '/auth/login', '/auth/callback'];
    for (const r of readRoutes) {
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        eq((await get(r, { method: m })).status, 405, `${m} ${r}`);
      }
      eq((await get(r, { method: 'HEAD' })).status === 405, false, `HEAD ${r} 不应 405`);
    }
    // 写端点：POST 放行（不落 405），其他方法 405
    for (const r of ['/api/review', '/api/push/trigger', '/api/oauth/logout', '/api/ask', '/api/my/card']) {
      for (const m of ['PUT', 'DELETE', 'PATCH']) {
        eq((await get(r, { method: m })).status, 405, `${m} ${r}`);
      }
      eq((await get(r, { method: 'POST' })).status === 405, false, `POST ${r} 不应 405`);
    }
  });

  await test('/api/review：坏 JSON → 400 invalid json', async () => {
    const r = await get('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    eq(r.status, 400, '状态码');
    eq((await r.json()).error, 'invalid json', 'error 字段');
  });

  await test('/api/review：缺 id → 400 missing id', async () => {
    const r = await post('/api/review', JSON.stringify({}));
    eq(r.status, 400, '状态码');
    eq((await r.json()).error, 'missing id', 'error 字段');
  });

  await test('/api/review：穿越/非法 id → 400 invalid id', async () => {
    for (const id of ['../x', '..\\..\\server', 'a/b', 'a.b', '']) {
      const r = await post('/api/review', JSON.stringify({ id }));
      eq(r.status, 400, `id=${JSON.stringify(id)} 状态码`);
    }
  });

  await test('/api/review：匿名复习站长卡片 → 401 loginRequired（issue #43：关闭匿名写入）', async () => {
    for (const id of [cardId, 'card_no_such_9']) {
      const r = await post('/api/review', JSON.stringify({ id }));
      eq(r.status, 401, `id=${id} 状态码`);
      eq((await r.json()).loginRequired, true, 'loginRequired 标记');
    }
  });

  await test('/api/review：超大 body（2MB）→ 413，且服务存活（#30）', async () => {
    const r = await post('/api/review', `{"id":"${'x'.repeat(2e6)}"}`);
    eq(r.status, 413, '状态码');
    eq((await get('/api/health')).status, 200, '超限后服务存活');
  });

  await test('站长卡复习单元（lib/review）：并发 4 次不丢计数、转 digested（#43 后 HTTP 成功路径需登录，下沉 lib 测）', async () => {
    const review = createReview(tmp);
    // 自建新卡（副本里的真实卡片可能已有 reviewCount）
    const freshId = 'card_e2e_review';
    const freshFile = path.join(tmp, 'data', 'cache', 'cards', `${freshId}.json`);
    await writeFile(freshFile, JSON.stringify({ id: freshId, status: 'approved' }));
    // 并发触发：读-改-写锁（withReviewLock）失效时会丢计数
    await Promise.all([0, 1, 2, 3].map(() => review.markReviewed(freshId)));
    const last = JSON.parse(await readFile(freshFile, 'utf8'));
    if (JSON.stringify(last).includes('NaN')) throw new Error('并发打卡结果含 NaN');
    eq(last.reviewCount, 4, '并发 4 次后 reviewCount（无锁会丢更新）');
    eq(last.status, 'digested', '4 次后 status');
    eq(last.nextReviewAt, null, 'digested 后 nextReviewAt');
    let enoent = false;
    try { await review.markReviewed('card_no_such_9'); } catch (e) { enoent = e.code === 'ENOENT'; }
    eq(enoent, true, '不存在卡片抛 ENOENT（分发层映射 404）');
  });

  await test('考古报告单元（lib/report-core，issue #50）：脏数据剔除 / 未来时间戳 / burstMonth 破平 / 短跨度不误判松鼠', async () => {
    const now = Math.floor(Date.UTC(2026, 8, 14, 4) / 1000); // 2026-09-14 12:00 CST
    const item = (favTime, extra = {}) => ({ ContentType: 'answer', Url: 'https://www.zhihu.com/x', Title: 't', FavTime: favTime, Author: { Name: 'a' }, ...extra });

    // 脏数据：FavTime 缺失/非数字整条剔除，不计 total、排序不 NaN
    const dirty = computeReport([item(now - 10 * 86400), { ContentType: 'answer', Title: 'no-favtime' }, item(now - 20 * 86400)], now);
    eq(dirty.total, 2, '脏数据剔除后 total');
    if (JSON.stringify(dirty).includes('NaN')) throw new Error('报告含 NaN');

    // ContentType 缺失归「未知」，不产生 "undefined" 键
    const noType = computeReport([item(now - 86400, { ContentType: undefined })], now);
    eq(noType.typeDist['未知'], 1, 'ContentType 缺失归未知');

    // 未来 FavTime：按「刚刚收藏」计 3天内 桶，daysAgo 不为负
    const future = computeReport([item(now + 3 * 86400), item(now - 400 * 86400)], now);
    eq(future.decayBuckets['3天内'], 1, '未来时间戳入 3天内 桶');
    eq(future.newestItem.daysAgo, 0, '未来时间戳 daysAgo 不为负');

    // burstMonth 并列（2025-08 与 2026-08 各 1 条）：取最近月份，破平确定
    const tie = computeReport([item(now - 400 * 86400), item(now - 30 * 86400)], now);
    eq(tie.burstMonth.month, '2026-08', 'burstMonth 并列取最近月份');

    // 单日 6 条：不得误判松鼠型（burst 先判；松鼠判定另要求跨度 ≥30 天）
    const singleDay = computeReport(Array.from({ length: 6 }, () => item(now - 5 * 86400)), now);
    if (singleDay.persona.type === '松鼠型') throw new Error(`单日 6 条误判松鼠型（实际 ${singleDay.persona.type}）`);

    // 长跨度稳定囤积仍判松鼠型：近 3 年每 5 天 1 条（单月占比 <40%，年均 ~73 条）
    const steady = computeReport(Array.from({ length: 200 }, (_, i) => item(now - i * 5 * 86400)), now);
    eq(steady.persona.type, '松鼠型', '长跨度稳定囤积人格');
  });

  await test('OAuth 未配置：GET /auth/login → 503', async () => {
    eq((await get('/auth/login')).status, 503, '状态码');
  });

  await test('OAuth 回调无 state → 302 到 oauth=error，错误明细不进 URL', async () => {
    const r = await get('/auth/callback?code=fake-code');
    eq(r.status, 302, '状态码');
    eq(r.headers.get('location'), '/app.html#report?oauth=error', 'Location');
  });

  await test('OAuth 未登录：GET /api/my/report → 401 loginRequired', async () => {
    const r = await get('/api/my/report');
    eq(r.status, 401, '状态码');
    eq((await r.json()).loginRequired, true, 'loginRequired 标记');
  });

  await test('OAuth status：未配置/未登录结构', async () => {
    const r = await get('/api/oauth/status');
    eq(r.status, 200, '状态码');
    const body = await r.json();
    eq(body.configured, false, 'configured');
    eq(body.authorized, false, 'authorized');
  });

  await test('/api/push/trigger：无 token → 403', async () => {
    eq((await post('/api/push/trigger', '{}')).status, 403, '无 token 状态码');
    eq((await post('/api/push/trigger', '{}', { 'x-push-token': 'wrong-token' })).status, 403, '错 token 状态码');
  });

  await test('/api/push/trigger：token 对但 SENDKEY 未配置 → 503', async () => {
    const r = await post('/api/push/trigger', '{}', { 'x-push-token': 'e2e-test-token' });
    eq(r.status, 503, '状态码');
    eq((await r.json()).ok, false, 'ok 字段');
  });

  await test('静态穿越四姿态：全部拒绝且不泄露源码', async () => {
    const paths = ['/../server.mjs', '/..%2f..%2fserver.mjs', '/%2e%2e/%2e%2e/server.mjs', '/..%5c..%5cserver.mjs'];
    for (const p of paths) {
      const r = await rawGet(p);
      if (![403, 404].includes(r.status)) throw new Error(`${p} → ${r.status}，期望 403/404`);
      if (r.body.includes('createServer')) throw new Error(`${p} 泄露了 server.mjs 内容`);
    }
  });

  await test('恶意 Cookie（zhsx_session=%）不再 500（issue #51：decodeURIComponent URIError 按无会话处理）', async () => {
    const r = await get('/api/health', { headers: { Cookie: 'zhsx_session=%' } });
    eq(r.status, 200, '恶意百分号编码 Cookie 状态码');
    eq((await r.json()).ok, true, '服务正常响应');
  });

  await test('调度单元（lib/time，issue #53）：hour 越界/NaN fail fast，合法值返回 0..24h', async () => {
    for (const bad of [25, -1, NaN, 7.5, '8']) {
      let threw = false;
      try { msUntilNextCst(bad); } catch (e) { threw = e instanceof RangeError; }
      eq(threw, true, `hour=${String(bad)} 抛 RangeError`);
    }
    const wait = msUntilNextCst(8);
    if (!(wait >= 0 && wait <= 24 * 3600 * 1000)) throw new Error(`合法 hour 返回异常：${wait}ms`);
  });

  await test('/api/cards：匿名降敏——限量 6 张、剥离 url/favTime/关注关系（#43）', async () => {
    const r = await get('/api/cards');
    eq(r.status, 200, '状态码');
    const body = await r.json();
    eq(typeof body.total, 'number', 'total 类型');
    if (!Array.isArray(body.cards)) throw new Error('cards 不是数组');
    if (body.cards.length > 6) throw new Error(`匿名下发超过 6 张：${body.cards.length}`);
    if (!(body.total >= body.cards.length)) throw new Error('total 小于 cards 长度');
    eq(body.sanitized, true, 'sanitized 标记');
    for (const c of body.cards) {
      if (!c.source) continue;
      for (const k of ['url', 'favTime', 'authorFollowed', 'authorAvatar']) {
        if (k in c.source) throw new Error(`匿名响应仍含 source.${k}`);
      }
    }
    const filtered = await (await get('/api/cards?status=approved')).json();
    if (filtered.cards.some((c) => c.status !== 'approved')) throw new Error('status=approved 过滤混入其他状态');
  });

  await test('/api/queue：匿名降敏——剥离 url/favTime/关注关系与 followed 统计（#43）', async () => {
    const body = await (await get('/api/queue')).json();
    for (const c of [...(body.today || []), ...(body.upNext || [])]) {
      if (!c.source) continue;
      for (const k of ['url', 'favTime', 'authorFollowed', 'authorAvatar']) {
        if (k in c.source) throw new Error(`匿名队列仍含 source.${k}`);
      }
    }
    if (body.stats && 'followed' in body.stats) throw new Error('匿名队列 stats 仍含 followed');
  });

  await test('/api/cards：不下发 reviewDetail，保留 reviewScore（#35）', async () => {
    const body = await (await get('/api/cards')).json();
    if (body.cards.length === 0) throw new Error('无卡片，无法校验');
    if (body.cards.some((c) => 'reviewDetail' in c)) throw new Error('响应仍含 reviewDetail');
    if (!body.cards.some((c) => typeof c.reviewScore === 'number')) throw new Error('响应缺 reviewScore');
  });

  await test('/api/ask：未登录追问 → 401 loginRequired（issue #36）', async () => {
    const r = await post('/api/ask', JSON.stringify({ cardId, question: '这张卡片讲了什么？' }));
    eq(r.status, 401, '状态码');
    const body = await r.json();
    eq(body.ok, false, 'ok 字段');
    eq(body.loginRequired, true, 'loginRequired 引导标记');
  });

  await test('/api/ask：大 body 未登录 → 401（鉴权先于 body 校验）', async () => {
    eq((await post('/api/ask', JSON.stringify({ cardId, question: '长'.repeat(5000) }))).status, 401, '状态码');
  });

  await test('/api/ask：轮换 25 个自报 X-ZHSX-UID / 匿名 cookie → 全部 401', async () => {
    for (let i = 0; i < 25; i++) {
      const r = await post('/api/ask', JSON.stringify({ cardId, question: `问题${i}` }),
        i % 2 ? { 'X-ZHSX-UID': `fake-uid-${i}` } : { Cookie: `zhsx_uid=fake-uid-${i}` });
      eq(r.status, 401, `第 ${i} 个自报身份状态码`);
      eq((await r.json()).loginRequired, true, `第 ${i} 个自报身份 loginRequired`);
    }
  });

  await test('/api/ask/quota：未登录 → 401', async () => {
    const r = await get('/api/ask/quota', { headers: { 'X-ZHSX-UID': 'fake-uid-quota' } });
    eq(r.status, 401, '状态码');
    eq((await r.json()).loginRequired, true, 'loginRequired 标记');
  });

  // 限流内核直测（HTTP 层登录路径无法伪造 OAuth 会话，直接驱动 lib/ask 模块验证配额语义）
  await test('限流单元（lib/ask）：每用户 2 次/天、每 IP 20 次/天、缓存命中免费、并发不丢计数', async () => {
    const { createAsk } = await import(new URL('../lib/ask.mjs', import.meta.url));
    const unitRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-ask-unit-'));
    const realFetch = globalThis.fetch;
    const realSecret = process.env.ZHIHU_ACCESS_SECRET;
    process.env.ZHIHU_ACCESS_SECRET = 'e2e-fake-secret';
    globalThis.fetch = async () => ({
      json: async () => ({ choices: [{ message: { content: '直答回答' } }], model: 'zhida-fast-1p5' }),
    });
    try {
      const unitAsker = createAsk(unitRoot);
      const card = { id: 'card_unit', source: { title: '测试', contentType: 'answer' } };
      // 每用户每日 2 次
      eq((await unitAsker.ask('u_1', card, '问题一', '1.1.1.1')).ok, true, 'u_1 第 1 次');
      eq((await unitAsker.ask('u_1', card, '问题二', '1.1.1.1')).ok, true, 'u_1 第 2 次');
      const third = await unitAsker.ask('u_1', card, '问题三', '1.1.1.1');
      eq(third.ok, false, 'u_1 第 3 次被拒');
      eq(third.quotaExceeded, true, 'u_1 第 3 次 quotaExceeded');
      // 并发 3 问同用户：串行化后恰好 2 过 1 拒（无锁会 3 过丢计数）
      const rs = await Promise.all([0, 1, 2].map((i) => unitAsker.ask('u_2', card, `并发${i}`, '2.2.2.2')));
      eq(rs.filter((r) => r.ok).length, 2, 'u_2 并发通过数');
      eq(rs.filter((r) => r.quotaExceeded).length, 1, 'u_2 并发被拒数');
      // IP 硬顶：2.2.2.2 已计 2 次，换 18 个 uid 打满 20，第 21 次拒
      for (let i = 3; i <= 20; i++) {
        eq((await unitAsker.ask(`u_${i}`, card, `问题${i}`, '2.2.2.2')).ok, true, `同 IP u_${i}`);
      }
      const over = await unitAsker.ask('u_21', card, '问题21', '2.2.2.2');
      eq(over.ok, false, '同 IP 第 21 次被拒');
      eq(over.ipLimited, true, 'ipLimited 标记');
      eq((await unitAsker.ask('u_21', card, '问题21', '3.3.3.3')).ok, true, '换 IP 后放行');
      // 缓存命中免费：新用户新 IP 重复 u_1 问过的问题
      const cached = await unitAsker.ask('u_99', card, '问题一', '9.9.9.9');
      eq(cached.ok, true, '缓存命中 ok');
      eq(cached.cached, true, 'cached 标记');
      // quotaFor 取用户与 IP 限额的较小值
      eq((await unitAsker.quotaFor('u_new', '2.2.2.2')).remaining, 0, 'IP 打满后 quotaFor remaining=0');
      eq((await unitAsker.quotaFor('u_1', '4.4.4.4')).remaining, 0, '用户打满后 quotaFor remaining=0');
      eq((await unitAsker.quotaFor('u_new', '4.4.4.4')).remaining, 2, '新用户新 IP remaining=2');
    } finally {
      globalThis.fetch = realFetch;
      if (realSecret === undefined) delete process.env.ZHIHU_ACCESS_SECRET;
      else process.env.ZHIHU_ACCESS_SECRET = realSecret;
      await rm(unitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  await test('/api/my/card：未登录 GET/POST → 401 loginRequired', async () => {
    for (const m of ['GET', 'POST']) {
      const r = await get('/api/my/card', { method: m });
      eq(r.status, 401, `${m} 状态码`);
      eq((await r.json()).loginRequired, true, `${m} loginRequired 标记`);
    }
  });

  // 现场炼卡内核直测（HTTP 层无法伪造 OAuth 会话，直接驱动 lib/mycard 模块；fetch 全部打桩，零真实额度消耗）
  await test('现场炼卡单元（lib/mycard）：状态机/同天缓存/全局 20 张/无收藏/失败重试/直答阈值', async () => {
    const { createMyCard } = await import(new URL('../lib/mycard.mjs', import.meta.url));
    const unitRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-mycard-unit-'));
    const realFetch = globalThis.fetch;
    const saved = {};
    for (const k of ['ZHIHU_ACCESS_SECRET', 'GEMINI_BASE_URL', 'GEMINI_API_KEY']) {
      saved[k] = process.env[k];
    }
    process.env.ZHIHU_ACCESS_SECRET = 'e2e-fake-secret';
    process.env.GEMINI_BASE_URL = 'http://fake-gemini';
    process.env.GEMINI_API_KEY = 'e2e-fake-key';
    let zhidaCalls = 0;
    let geminiFailOnce = false;
    const cardJson = JSON.stringify({
      coreView: '核心观点', thread: [{ step: 's1', detail: 'd1' }, { step: 's2', detail: 'd2' }, { step: 's3', detail: 'd3' }],
      keyInsight: '', points: ['p1', 'p2', 'p3'], quote: '金句', difficulty: 'easy', topicTags: ['测试'],
    });
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('developer.zhihu.com')) {
        zhidaCalls++;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '拆解原文：核心观点与论证结构' } }], model: 'zhida-thinking-1p5' }) };
      }
      // Gemini 中转站：盲审 prompt 含「盲审考官」，其余为炼卡
      if (geminiFailOnce) { geminiFailOnce = false; return { ok: false, status: 500, text: async () => 'boom' }; }
      const prompt = JSON.parse(opts.body).messages[0].content;
      const out = prompt.includes('盲审考官')
        ? { faithful: true, unsupportedClaims: [], coreCovered: true, missingCore: [], score: 5, comment: '忠实' }
        : JSON.parse(cardJson);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) };
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const fav = (over = {}) => ({ ContentType: 'answer', Url: 'https://www.zhihu.com/answer/12345', Title: '测试问题？', FavTime: nowSec, Author: { Name: 'Tester' }, LikeCount: 1, ...over });
    const waitJob = async (mc, uid) => {
      for (let i = 0; i < 200; i++) {
        const s = await mc.statusFor(uid);
        if (s.status === 'done' || s.status === 'failed') return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('任务 5s 内未完成');
    };
    try {
      const mc = createMyCard(unitRoot);
      const favs = async () => ({ items: [fav()] });
      // 完整管线：发起 → 状态机 → done，卡片过盲审
      const start = await mc.start('u_a', favs);
      eq(start.code, 200, '发起状态码');
      eq(start.body.status, 'breaking_down', '初始阶段');
      const done = await waitJob(mc, 'u_a');
      eq(done.status, 'done', '任务完成');
      eq(done.card.status, 'approved', '盲审通过');
      eq(done.card.id, 'card_answer_12345', '卡片 id');
      if ('reviewDetail' in done.card) throw new Error('下发结果含 reviewDetail');
      eq(zhidaCalls, 1, '直答调用次数');
      // 同天重复请求：直接返回缓存结果，不再烧额度
      const again = await mc.start('u_a', favs);
      eq(again.body.status, 'done', '重复请求返回 done');
      eq(again.body.already, true, 'already 标记');
      eq(zhidaCalls, 1, '重复请求未再调直答');
      // 服务重启恢复：新建实例读落盘结果
      const mc2 = createMyCard(unitRoot);
      eq((await mc2.statusFor('u_a')).status, 'done', '重启后恢复 done');
      // 我的卡册（/api/cards?scope=mine 数据源）：累积列出 + 独立复习进度
      const mineCards = await mc2.listCards('u_a');
      eq(mineCards.length, 1, '卡册列出 1 张');
      eq(mineCards[0].id, 'card_answer_12345', '卡册卡片 id');
      if ('reviewDetail' in mineCards[0]) throw new Error('卡册下发含 reviewDetail');
      eq((await mc2.listCards('u_nobody')).length, 0, '无记录用户空卡册');
      const reviewed = await mc2.markReviewed('u_a', 'card_answer_12345');
      eq(reviewed.reviewCount, 1, '复习计数 +1');
      if (!(reviewed.nextReviewAt > nowSec)) throw new Error('nextReviewAt 未推进');
      await mc2.markReviewed('u_a', 'card_answer_12345');
      const third = await mc2.markReviewed('u_a', 'card_answer_12345');
      eq(third.status, 'digested', '3 次复习后 digested');
      eq(third.nextReviewAt, null, 'digested 后 nextReviewAt 清空');
      eq(await mc2.markReviewed('u_a', 'card_nope'), null, '未知 id 返回 null');
      eq((await mc2.listCards('u_a'))[0].status, 'digested', '复习进度落盘');
      // 无收藏 → 422
      const empty = await mc.start('u_empty', async () => ({ items: [] }));
      eq(empty.code, 422, '无收藏状态码');
      eq(empty.body.noFavorites, true, 'noFavorites 标记');
      // 失败后重试：Gemini 挂一次 → failed，再发起成功（失败不算用户的 1 张）
      geminiFailOnce = true;
      await mc.start('u_b', favs);
      const failedJob = await waitJob(mc, 'u_b');
      eq(failedJob.status, 'failed', 'Gemini 故障任务失败');
      // 内部错误不原样透出前端：非用户可读文案映射为通用提示（issue #54）
      eq(failedJob.error, '卡片生成失败，请稍后重试', '内部错误映射通用文案');
      await mc.start('u_b', favs);
      eq((await waitJob(mc, 'u_b')).status, 'done', '失败后重试成功');
      // 直答台账阈值：count=90 时新内容（无缓存）任务失败且不发出请求
      const quotaPath = path.join(unitRoot, 'data', 'runtime', 'quota');
      const today = JSON.parse(await readFile(path.join(quotaPath, `${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.json`), 'utf8'));
      today.count = 90;
      await import('node:fs/promises').then((fs) => fs.writeFile(path.join(quotaPath, `${today.date}.json`), JSON.stringify(today)));
      await mc.start('u_c', async () => ({ items: [fav({ Url: 'https://www.zhihu.com/answer/99999' })] }));
      const throttled = await waitJob(mc, 'u_c');
      eq(throttled.status, 'failed', '阈值任务失败');
      if (!throttled.error.includes('直答')) throw new Error(`阈值错误文案异常：${throttled.error}`);
      // 全局 20 张已满 → 429（用新用户绕过 done 缓存）
      today.mycards = 20;
      await import('node:fs/promises').then((fs) => fs.writeFile(path.join(quotaPath, `${today.date}.json`), JSON.stringify(today)));
      const full = await mc.start('u_d', favs);
      eq(full.code, 429, '全局满状态码');
      eq(full.body.quotaExceeded, true, 'quotaExceeded 标记');
    } finally {
      globalThis.fetch = realFetch;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await rm(unitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  // #38 跨天日期闸门 / #39 并发串行只烧 1 名额 / #40 尝试上限与 MYCARD_GLOBAL_CAP / #42 直答 502 可读文案
  await test('现场炼卡单元②（#38-#40/#42）：跨天闸门 / 并发串行 / 尝试上限 3 次 / env 覆盖 / 502 文案', async () => {
    const { createMyCard } = await import(new URL('../lib/mycard.mjs', import.meta.url));
    const unitRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-mycard-unit2-'));
    const realFetch = globalThis.fetch;
    const saved = {};
    for (const k of ['ZHIHU_ACCESS_SECRET', 'GEMINI_BASE_URL', 'GEMINI_API_KEY', 'MYCARD_GLOBAL_CAP']) {
      saved[k] = process.env[k];
    }
    process.env.ZHIHU_ACCESS_SECRET = 'e2e-fake-secret';
    process.env.GEMINI_BASE_URL = 'http://fake-gemini';
    process.env.GEMINI_API_KEY = 'e2e-fake-key';
    let zhida502 = false;
    const cardJson = JSON.stringify({
      coreView: '核心观点', thread: [{ step: 's1', detail: 'd1' }, { step: 's2', detail: 'd2' }, { step: 's3', detail: 'd3' }],
      keyInsight: '', points: ['p1', 'p2', 'p3'], quote: '金句', difficulty: 'easy', topicTags: ['测试'],
    });
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('developer.zhihu.com')) {
        if (zhida502) return { ok: false, status: 502, text: async () => '<html>bad gateway</html>', json: async () => { throw new Error('not json'); } };
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '拆解原文' } }], model: 'zhida-thinking-1p5' }) };
      }
      const prompt = JSON.parse(opts.body).messages[0].content;
      const out = prompt.includes('盲审考官')
        ? { faithful: true, unsupportedClaims: [], coreCovered: true, missingCore: [], score: 5, comment: '忠实' }
        : JSON.parse(cardJson);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) };
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const fav = (over = {}) => ({ ContentType: 'answer', Url: 'https://www.zhihu.com/answer/777', Title: '测试问题？', FavTime: nowSec, Author: { Name: 'T' }, LikeCount: 1, ...over });
    const waitJob = async (mc, uid) => {
      for (let i = 0; i < 200; i++) {
        const s = await mc.statusFor(uid);
        if (s.status === 'done' || s.status === 'failed') return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('任务 5s 内未完成');
    };
    const quotaToday = async () => JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'quota', `${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.json`), 'utf8'));
    try {
      const mc = createMyCard(unitRoot);
      // #38：昨天的落盘 done 记录不得阻挡今天（日期闸门），可重新发起
      const mycardsDir = path.join(unitRoot, 'data', 'runtime', 'mycards');
      await mkdir(mycardsDir, { recursive: true });
      await writeFile(path.join(mycardsDir, `${encodeURIComponent('u_stale')}.json`), JSON.stringify({
        date: '2000-01-01', uid: 'u_stale', status: 'done', card: { id: 'card_old' }, source: { title: '旧卡' }, finishedAt: 0,
      }));
      eq((await mc.statusFor('u_stale')).status, 'idle', '跨天落盘 done 记录应失效为 idle');
      const restart = await mc.start('u_stale', async () => ({ items: [fav()] }));
      eq(restart.body.already, undefined, '跨天后重新发起不带 already');
      eq((await waitJob(mc, 'u_stale')).status, 'done', '跨天后重新炼卡成功');

      // #39：同 uid 并发双发——串行化后第二个看到占位返回 already，全局名额只烧 1
      const before = (await quotaToday()).mycards;
      let release;
      const gateP = new Promise((r) => { release = r; });
      const slowFavs = async () => { await gateP; return { items: [fav({ Url: 'https://www.zhihu.com/answer/888' })] }; };
      const p1 = mc.start('u_race', slowFavs);
      const p2 = mc.start('u_race', slowFavs);
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      eq([r1, r2].filter((r) => r.body.already).length, 1, '并发双发恰有一个 already');
      eq([r1, r2].filter((r) => r.body.jobId).length, 2, '两个请求都有 jobId');
      eq((await quotaToday()).mycards - before, 1, '并发双发只烧 1 个全站名额');
      eq((await waitJob(mc, 'u_race')).status, 'done', '并发任务完成');

      // #40 + #42.1：直答 502 HTML → 可读文案；失败可重试但每天限 3 次，第 4 次 429 且不再烧名额
      const countBeforeFail = (await quotaToday()).count;
      zhida502 = true;
      const failFavs = async () => ({ items: [fav({ Url: 'https://www.zhihu.com/answer/999' })] });
      for (let attempt = 1; attempt <= 3; attempt++) {
        await mc.start('u_fail', failFavs);
        const s = await waitJob(mc, 'u_fail');
        eq(s.status, 'failed', `第 ${attempt} 次尝试失败`);
        if (!s.error.includes('直答服务暂时不可用（HTTP 502）')) throw new Error(`502 文案不可读：${s.error}`);
      }
      eq((await quotaToday()).count, countBeforeFail, '直答 502 失败回滚全局台账计数（#44 口径跟进 mycard，mycards 名额不退但 count 退）');
      const blocked = await mc.start('u_fail', failFavs);
      eq(blocked.code, 429, '第 4 次尝试状态码');
      eq(blocked.body.attemptsExceeded, true, 'attemptsExceeded 标记');
      if (!blocked.body.error.includes('尝试次数')) throw new Error(`尝试上限文案异常：${blocked.body.error}`);
      zhida502 = false;

      // #40：MYCARD_GLOBAL_CAP 环境变量覆盖（新模块实例 + 新台账目录，cap=1 时第二人 429）
      process.env.MYCARD_GLOBAL_CAP = '1';
      const { createMyCard: createMyCardCapped } = await import(new URL('../lib/mycard.mjs?cap-override', import.meta.url));
      const cappedRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-mycard-cap-'));
      try {
        const mcCapped = createMyCardCapped(cappedRoot);
        eq(mcCapped.GLOBAL_DAILY_CAP, 1, 'env 覆盖全局名额');
        await mcCapped.start('u_x', async () => ({ items: [fav()] }));
        eq((await waitJob(mcCapped, 'u_x')).status, 'done', 'cap=1 第一人成功');
        const over = await mcCapped.start('u_y', async () => ({ items: [fav()] }));
        eq(over.code, 429, 'cap=1 第二人状态码');
        eq(over.body.quotaExceeded, true, 'cap=1 quotaExceeded 标记');
      } finally {
        await rm(cappedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    } finally {
      globalThis.fetch = realFetch;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await rm(unitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  await test('现场炼卡单元③（#49）：auto 让路运行中手动管线 / 手动遇 auto 管线 already 不烧名额 / 闸门故障清占位可重试', async () => {
    const { createMyCard } = await import(new URL('../lib/mycard.mjs', import.meta.url));
    const unitRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-mycard-unit3-'));
    const realFetch = globalThis.fetch;
    const saved = {};
    for (const k of ['ZHIHU_ACCESS_SECRET', 'GEMINI_BASE_URL', 'GEMINI_API_KEY']) {
      saved[k] = process.env[k];
    }
    process.env.ZHIHU_ACCESS_SECRET = 'e2e-fake-secret';
    process.env.GEMINI_BASE_URL = 'http://fake-gemini';
    process.env.GEMINI_API_KEY = 'e2e-fake-key';
    let zhidaGate = null; // 挂起直答响应，模拟管线运行中
    const cardJson = JSON.stringify({
      coreView: '核心观点', thread: [{ step: 's1', detail: 'd1' }, { step: 's2', detail: 'd2' }, { step: 's3', detail: 'd3' }],
      keyInsight: '', points: ['p1', 'p2', 'p3'], quote: '金句', difficulty: 'easy', topicTags: ['测试'],
    });
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('developer.zhihu.com')) {
        if (zhidaGate) await zhidaGate;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '拆解原文' } }], model: 'zhida-thinking-1p5' }) };
      }
      const prompt = JSON.parse(opts.body).messages[0].content;
      const out = prompt.includes('盲审考官')
        ? { faithful: true, unsupportedClaims: [], coreCovered: true, missingCore: [], score: 5, comment: '忠实' }
        : JSON.parse(cardJson);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) };
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const fav = (n) => ({ ContentType: 'answer', Url: `https://www.zhihu.com/answer/${n}`, Title: `问题${n}？`, FavTime: nowSec, Author: { Name: 'T' }, LikeCount: 1 });
    const waitJob = async (mc, uid) => {
      for (let i = 0; i < 200; i++) {
        const s = await mc.statusFor(uid);
        if (s.status === 'done' || s.status === 'failed') return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('任务 5s 内未完成');
    };
    const quotaToday = async () => JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'quota', `${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)}.json`), 'utf8'));
    try {
      const mc = createMyCard(unitRoot);

      // A：手动管线在后台运行（start 已返回、inflight 已释放、zhida 挂起中）——autoMake 必须通过 running 看到并让路
      await mc.saveFavSnapshot('u_busy', [fav(6661)]);
      let releaseA;
      zhidaGate = new Promise((r) => { releaseA = r; });
      const startRes = await mc.start('u_busy', async () => ({ items: [fav(6661)] }));
      eq(startRes.code, 200, '手动发起状态码');
      const autoRes = await mc.autoMake(['u_busy']);
      eq(autoRes.users.u_busy, 'busy', '手动管线运行中 autoMake 让路');
      eq(autoRes.made, 0, '让路不烧自动名额');
      releaseA();
      zhidaGate = null;
      eq((await waitJob(mc, 'u_busy')).status, 'done', '手动管线放行后完成');

      // B：自动管线运行中（zhida 挂起）——手动入口返回 already，不重复发起、不烧手动名额
      await mc.saveFavSnapshot('u_auto2', [fav(6662)]);
      let releaseB;
      zhidaGate = new Promise((r) => { releaseB = r; });
      const autoP = mc.autoMake(['u_auto2']);
      await new Promise((r) => setTimeout(r, 100)); // 等自动管线登记 running 并挂进 zhida
      eq((await mc.statusFor('u_auto2')).status, 'breaking_down', '自动管线运行中 statusFor 显示进度而非 idle');
      const beforeB = (await quotaToday()).mycards;
      const manualDuring = await mc.start('u_auto2', async () => ({ items: [fav(6662)] }));
      eq(manualDuring.body.already, true, '自动管线运行中手动返回 already');
      eq((await quotaToday()).mycards, beforeB, 'already 不烧手动名额');
      releaseB();
      zhidaGate = null;
      const autoDone = await autoP;
      eq(autoDone.made, 1, '自动管线放行后炼成');

      // C：闸门自身故障（台账目录路径被文件占用 → writeQuota 抛错）——占位必须清理，用户不当场锁死
      const quotaPath = path.join(unitRoot, 'data', 'runtime', 'quota');
      await rm(quotaPath, { recursive: true, force: true });
      await writeFile(quotaPath, 'blocked');
      let threw = false;
      try { await mc.start('u_gate', async () => ({ items: [fav(6663)] })); } catch { threw = true; }
      eq(threw, true, '闸门故障 start 抛错');
      eq((await mc.statusFor('u_gate')).status, 'idle', '占位已清理，状态回 idle 而非卡在 breaking_down');
      await rm(quotaPath, { force: true });
      const retry = await mc.start('u_gate', async () => ({ items: [fav(6663)] }));
      eq(retry.code, 200, '故障恢复后可重新发起（不被幽灵占位 already）');
      eq((await waitJob(mc, 'u_gate')).status, 'done', '重新发起炼卡成功');
    } finally {
      globalThis.fetch = realFetch;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await rm(unitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  // 自动炼卡单元（lib/mycard.autoMake + 收藏快照）：快照存取 / 每用户 3 张 / via=auto 不挡手动 / 去重与 tried 标记
  await test('自动炼卡单元（lib/mycard）：快照 / 每用户 3 张上限 / 手动入口不受 auto 影响 / exhausted / tried 3 天免重试', async () => {
    const { createMyCard } = await import(new URL('../lib/mycard.mjs', import.meta.url));
    const unitRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-mycard-auto-'));
    const realFetch = globalThis.fetch;
    const saved = {};
    for (const k of ['ZHIHU_ACCESS_SECRET', 'GEMINI_BASE_URL', 'GEMINI_API_KEY']) {
      saved[k] = process.env[k];
    }
    process.env.ZHIHU_ACCESS_SECRET = 'e2e-fake-secret';
    process.env.GEMINI_BASE_URL = 'http://fake-gemini';
    process.env.GEMINI_API_KEY = 'e2e-fake-key';
    let zhidaCalls = 0;
    const cardJson = JSON.stringify({
      coreView: '核心观点', thread: [{ step: 's1', detail: 'd1' }, { step: 's2', detail: 'd2' }, { step: 's3', detail: 'd3' }],
      keyInsight: '', points: ['p1', 'p2', 'p3'], quote: '金句', difficulty: 'easy', topicTags: ['测试'],
    });
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('developer.zhihu.com')) {
        zhidaCalls++;
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '拆解原文' } }], model: 'zhida-thinking-1p5' }) };
      }
      const prompt = JSON.parse(opts.body).messages[0].content;
      const out = prompt.includes('盲审考官')
        ? { faithful: true, unsupportedClaims: [], coreCovered: true, missingCore: [], score: 5, comment: '忠实' }
        : JSON.parse(cardJson);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(out) } }] }) };
    };
    const nowSec = Math.floor(Date.now() / 1000);
    const todayCst = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const fav = (n, over = {}) => ({ ContentType: 'answer', Url: `https://www.zhihu.com/answer/${n}`, Title: `问题${n}？`, FavTime: nowSec, Author: { Name: 'T' }, LikeCount: 1, ...over });
    const waitJob = async (mc, uid) => {
      for (let i = 0; i < 200; i++) {
        const s = await mc.statusFor(uid);
        if (s.status === 'done' || s.status === 'failed') return s;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('任务 5s 内未完成');
    };
    try {
      const mc = createMyCard(unitRoot);
      // 快照：保存 → 读回；再次保存保留 tried 标记
      await mc.saveFavSnapshot('u_auto', [fav(1001), fav(1002), fav(1003), fav(1004)]);
      eq((await mc.readFavSnapshot('u_auto')).items.length, 4, '快照读回 4 条');
      eq(await mc.readFavSnapshot('u_nosnap'), null, '无快照返回 null');

      // 自动炼卡：4 条候选但每用户每日 3 张 → 成 3、user_cap；直答烧 3 次
      const r1 = await mc.autoMake(['u_auto', 'u_nosnap']);
      eq(r1.ok, true, 'autoMake ok');
      eq(r1.made, 3, '自动炼成 3 张');
      eq(r1.users.u_auto, 'user_cap', '第 4 条被每用户上限拦下');
      eq(r1.users.u_nosnap, 'no_snapshot', '无快照用户跳过');
      eq(zhidaCalls, 3, '直答调用 3 次');
      eq((await mc.listCards('u_auto')).length, 3, '卡册累积 3 张');

      // via=auto：落盘记录标 auto；不当「今日已炼」——statusFor 仍 idle，手动入口可炼且只挑没炼过的第 4 条
      const recAuto = JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'mycards', `${encodeURIComponent('u_auto')}.json`), 'utf8'));
      eq(recAuto.via, 'auto', '落盘 via=auto');
      eq((await mc.statusFor('u_auto')).status, 'idle', 'auto 产物不挡手动入口');
      const manual = await mc.start('u_auto', async () => ({ items: [fav(1001), fav(1002), fav(1003), fav(1004)] }));
      eq(manual.code, 200, '手动发起状态码');
      const manualDone = await waitJob(mc, 'u_auto');
      eq(manualDone.status, 'done', '手动炼卡完成');
      eq(manualDone.card.source.url, 'https://www.zhihu.com/answer/1004', '手动只挑未炼过的收藏');
      eq(zhidaCalls, 4, '手动新内容再烧 1 次直答');
      const recManual = JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'mycards', `${encodeURIComponent('u_auto')}.json`), 'utf8'));
      eq(recManual.via, 'manual', '手动落盘 via=manual');
      eq((await mc.statusFor('u_auto')).status, 'done', '手动成功后恢复今日闸门');

      // 快照重存保留 tried；新快照里都是已炼条目 → 去重后不烧额度
      await mc.saveFavSnapshot('u_auto', [fav(1001), fav(1002)]);
      const snap2 = await mc.readFavSnapshot('u_auto');
      eq(snap2.items.length, 2, '快照更新为新列表');
      eq(Object.keys(snap2.tried).length >= 3, true, 'tried 标记保留');
      const r2 = await mc.autoMake(['u_auto']);
      eq(r2.made, 0, '当天再跑不再炼');
      eq(r2.users.u_auto, 'exhausted', '已炼条目被卡册历史去重');
      eq(zhidaCalls, 4, '重复跑未烧直答');

      // exhausted：快照里唯一收藏已在该用户自己的卡册历史 → 跳过（预写 u_tired 的历史卡册）
      const mycardsDir = path.join(unitRoot, 'data', 'runtime', 'mycards');
      await mkdir(mycardsDir, { recursive: true });
      await writeFile(path.join(mycardsDir, `${encodeURIComponent('u_tired')}.json`), JSON.stringify({
        date: '2000-01-01', uid: 'u_tired', status: 'done', via: 'manual',
        card: { id: 'card_answer_3001', source: { url: 'https://www.zhihu.com/answer/3001' } },
        cards: [{ id: 'card_answer_3001', status: 'approved', source: { url: 'https://www.zhihu.com/answer/3001' } }],
        finishedAt: 0,
      }));
      await mc.saveFavSnapshot('u_tired', [fav(3001)]);
      const r3 = await mc.autoMake(['u_tired']);
      eq(r3.users.u_tired, 'exhausted', '库存耗尽跳过');

      // tried 窗口：今天试过的跳过，3 天前试过的允许重试（u_retry 快照手写 tried）
      const favsDir = path.join(unitRoot, 'data', 'runtime', 'favs');
      await mkdir(favsDir, { recursive: true });
      await writeFile(path.join(favsDir, `${encodeURIComponent('u_retry')}.json`), JSON.stringify({
        uid: 'u_retry', savedAt: Date.now(), items: [fav(2001), fav(2002)],
        tried: { answer_2001: todayCst, answer_2002: '2000-01-01' },
      }));
      const r4 = await mc.autoMake(['u_retry']);
      eq(r4.made, 1, '仅旧 tried 允许重试');
      eq((await mc.listCards('u_retry'))[0].source.url, 'https://www.zhihu.com/answer/2002', '重试命中旧 tried 条目');
      eq(zhidaCalls, 5, '仅多烧 1 次直答');
    } finally {
      globalThis.fetch = realFetch;
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      await rm(unitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  // 运行产物迁移：老位置文件搬进 data/runtime/（目标已存在则不覆盖）
  await test('runtime 迁移（lib/runtime）：老位置 → data/runtime/，已有目标不覆盖', async () => {
    const { migrateRuntime } = await import(new URL('../lib/runtime.mjs', import.meta.url));
    const unitRoot = await mkdtemp(path.join(tmpdir(), 'zhsx-runtime-'));
    try {
      await mkdir(path.join(unitRoot, 'data', 'quota'), { recursive: true });
      await writeFile(path.join(unitRoot, 'data', 'quota', '2026-01-01.json'), '{"count":7}');
      await writeFile(path.join(unitRoot, 'data', 'push-subscriptions.json'), '{"u_1":{}}');
      await migrateRuntime(unitRoot);
      eq(JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'quota', '2026-01-01.json'), 'utf8')).count, 7, 'quota 目录迁移');
      eq(typeof JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'push-subscriptions.json'), 'utf8')).u_1, 'object', '订阅台账迁移');
      await writeFile(path.join(unitRoot, 'data', 'push-state.json'), '{"date":"old"}');
      await writeFile(path.join(unitRoot, 'data', 'runtime', 'push-state.json'), '{"date":"new"}');
      await migrateRuntime(unitRoot);
      eq(JSON.parse(await readFile(path.join(unitRoot, 'data', 'runtime', 'push-state.json'), 'utf8')).date, 'new', '已有目标不覆盖');
    } finally {
      await rm(unitRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  await test('并发 20 路：全部 200', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => get(i % 2 ? '/api/cards' : '/')));
    for (const [i, r] of rs.entries()) eq(r.status, 200, `第 ${i} 路状态码`);
  });

  if (stress) {
    await test('压测：600 次无 Cookie 请求后会话淘洗（sessions ≤ 500），服务仍存活', async () => {
      for (let round = 0; round < 12; round++) {
        await Promise.all(Array.from({ length: 50 }, () => get('/api/oauth/status')));
      }
      const health = await (await get('/api/health')).json();
      if (!(health.sessions <= 500)) throw new Error(`sessions=${health.sessions}，淘洗失效`);
      eq((await get('/api/health')).status, 200, '压测后健康检查');
    });
  } else {
    console.log('SKIP 压测（600 次会话淘洗）— 加 --stress 开启');
  }
} finally {
  child.kill();
  await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`\n汇总：${pass} PASS / ${fail} FAIL${failures.length ? `（${failures.join('；')}）` : ''}`);
process.exitCode = fail;
