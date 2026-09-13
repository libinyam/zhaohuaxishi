// 端到端断言脚本：把人工走查过的用例固化下来防回归
// 在隔离副本上跑（复制 server.mjs/lib/public/data 到临时目录起服务），绝不碰真实数据
// Run: node scripts/test-e2e.mjs [--stress]
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    for (const r of ['/api/review', '/api/push/trigger', '/api/oauth/logout', '/api/ask']) {
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

  await test('/api/review：合法格式但卡片不存在 → 404', async () => {
    eq((await post('/api/review', JSON.stringify({ id: 'card_no_such_9' }))).status, 404, '状态码');
  });

  await test('/api/review：连打 4 次转 digested，无 NaN', async () => {
    let last;
    for (let i = 0; i < 4; i++) {
      const r = await post('/api/review', JSON.stringify({ id: cardId }));
      eq(r.status, 200, `第 ${i + 1} 次打卡状态码`);
      const text = await r.text();
      if (text.includes('NaN')) throw new Error(`第 ${i + 1} 次打卡响应含 NaN`);
      last = JSON.parse(text);
    }
    eq(last.ok, true, '第 4 次打卡 ok');
    eq(last.card.status, 'digested', '4 次后 status');
    eq(last.card.nextReviewAt, null, 'digested 后 nextReviewAt');
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

  await test('/api/cards：响应结构 + favTime 倒序 + status 过滤', async () => {
    const r = await get('/api/cards');
    eq(r.status, 200, '状态码');
    const body = await r.json();
    eq(typeof body.total, 'number', 'total 类型');
    if (!Array.isArray(body.cards)) throw new Error('cards 不是数组');
    eq(body.total, body.cards.length, 'total 与 cards 长度一致');
    for (let i = 1; i < body.cards.length; i++) {
      const prev = body.cards[i - 1].source?.favTime ?? 0;
      const cur = body.cards[i].source?.favTime ?? 0;
      if (cur > prev) throw new Error('cards 未按 favTime 倒序');
    }
    const filtered = await (await get('/api/cards?status=approved')).json();
    if (filtered.cards.some((c) => c.status !== 'approved')) throw new Error('status=approved 过滤混入其他状态');
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
