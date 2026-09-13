// 追问：卡片详情接知乎直答，每用户每日限 2 次，缓存命中不烧额度（SPEC「追问限流实现」）
// 直答走 HTTP API（容器内没有 zhihu-cli）：POST developer.zhihu.com/v1/chat/completions
import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { cstDateStr } from './time.mjs';

const PER_USER_DAILY = 2;
const PER_IP_DAILY = 20;   // 同一出口 IP 每日追问硬顶（issue #36：演示现场多人同 IP 场景的兜底）
const ZHIDA_DAILY_LIMIT = 100;   // SPEC 台账口径：全账号共享，阈值 90 拒绝
const ZHIDA_THRESHOLD = 90;
const MAX_QUESTION_LEN = 200;

// 切日口径见 lib/time.mjs（UTC+8），与 breakdown / 推送调度共用同一来源

// 规范化问题文本做缓存 key：去空白去标点转小写；按卡片隔离，防止「为什么」跨卡串答案
const normalize = (q) => q.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const cacheKey = (cardId, question) =>
  createHash('sha256').update(`${cardId}\n${normalize(question)}`).digest('hex').slice(0, 24);

export function createAsk(root) {
  const quotaDir = path.join(root, 'data', 'quota');
  const answersDir = path.join(root, 'data', 'cache', 'answers');
  const accessSecret = process.env.ZHIHU_ACCESS_SECRET || '';

  const quotaFile = () => path.join(quotaDir, `${cstDateStr()}.json`);

  // 台账与 breakdown.mjs 共用同一文件：{ date, count（直答总台账）, asks: { userKey: n }, ips: { ip: n } }
  // breakdown 只读写 count，asks/ips 字段向后兼容
  async function readQuota() {
    try {
      const q = JSON.parse(await readFile(quotaFile(), 'utf8'));
      return { date: cstDateStr(), count: 0, asks: {}, ips: {}, ...q };
    } catch { return { date: cstDateStr(), count: 0, asks: {}, ips: {} }; }
  }
  async function writeQuota(q) {
    await mkdir(quotaDir, { recursive: true });
    const tmp = quotaFile() + '.tmp';
    await writeFile(tmp, JSON.stringify(q, null, 2));
    await rename(tmp, quotaFile());
  }

  function remaining(q, userKey) {
    return Math.max(0, PER_USER_DAILY - (q.asks[userKey] || 0));
  }
  function ipRemaining(q, ip) {
    return Math.max(0, PER_IP_DAILY - (q.ips[ip] || 0));
  }

  // 台账读-改-写串行化：单进程内并发追问不丢计数
  let quotaLock = Promise.resolve();
  function withQuotaLock(fn) {
    const run = quotaLock.then(fn);
    quotaLock = run.catch(() => {});
    return run;
  }

  // userKey：只认 OAuth 用户 'u_<uid>'（issue #36：匿名身份已关闭，server.mjs 已拦截未登录）
  // ip：出口 IP，与用户限流取交集——两者任一超限都拒绝
  async function ask(userKey, card, question, ip = 'unknown') {
    const key = cacheKey(card.id, question);
    const cacheFile = path.join(answersDir, `${key}.json`);

    // 先查缓存：命中不烧直答额度，也不占用户当日 2 次 / IP 当日上限
    try {
      const hit = JSON.parse(await readFile(cacheFile, 'utf8'));
      const q = await readQuota();
      return { ok: true, answer: hit.answer, cached: true, remaining: remaining(q, userKey) };
    } catch { /* 无缓存，继续 */ }

    // 限额检查 + 计数前置在同一把锁里完成，并发追问不会超发
    const gate = await withQuotaLock(async () => {
      const q = await readQuota();
      if (remaining(q, userKey) <= 0) {
        return { reject: { ok: false, quotaExceeded: true, error: '今日额度已用完，明天再来', remaining: 0 } };
      }
      if (ipRemaining(q, ip) <= 0) {
        return { reject: { ok: false, quotaExceeded: true, ipLimited: true, error: '当前网络今日追问次数已达上限，明天再来', remaining: 0 } };
      }
      if (q.count >= ZHIDA_THRESHOLD) {
        return { reject: { ok: false, quotaExceeded: true, error: '今日直答总额度紧张，追问暂停开放，明天再来', remaining: remaining(q, userKey) } };
      }
      if (!accessSecret) {
        return { reject: { ok: false, notReady: true, error: '追问功能未就绪（服务端缺少 ZHIHU_ACCESS_SECRET 配置）', remaining: remaining(q, userKey) } };
      }
      // 计数前置：即将发请求，无论成败计 1 次（与 breakdown 台账同口径）
      q.count++;
      q.asks[userKey] = (q.asks[userKey] || 0) + 1;
      q.ips[ip] = (q.ips[ip] || 0) + 1;
      q.updatedAt = Date.now();
      await writeQuota(q);
      return { q };
    });
    if (gate.reject) return gate.reject;

    const anchor = card.source?.contentType === 'article'
      ? `关于知乎专栏文章《${card.source?.title}》：`
      : `关于知乎问题「${card.source?.title}」下的讨论：`;
    const resp = await fetch('https://developer.zhihu.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessSecret}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'zhida-fast-1p5',
        messages: [{ role: 'user', content: `${anchor}${question}` }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const payload = await resp.json();
    const answer = payload?.choices?.[0]?.message?.content;
    if (!answer) throw new Error(`直答返回异常（HTTP ${resp.status}）`);

    await mkdir(answersDir, { recursive: true });
    const tmp = cacheFile + '.tmp';
    await writeFile(tmp, JSON.stringify({
      key, cardId: card.id, question, answer,
      model: payload.model, fetchedAt: Date.now(),
    }, null, 2));
    await rename(tmp, cacheFile);

    return { ok: true, answer, cached: false, remaining: remaining(gate.q, userKey) };
  }

  async function quotaFor(userKey, ip = 'unknown') {
    const q = await readQuota();
    return { remaining: Math.min(remaining(q, userKey), ipRemaining(q, ip)), daily: PER_USER_DAILY };
  }

  return { ask, quotaFor, MAX_QUESTION_LEN };
}
