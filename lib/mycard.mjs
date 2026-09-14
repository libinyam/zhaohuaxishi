// 现场炼卡：登录用户把自己的一条收藏现场走完整管线（直答拆解 → Gemini 炼卡 → 盲审门禁）
// 异步任务模式：POST 立即返回 jobId，内存 Map 存任务状态（盖 CST 日期戳，跨天自动失效），结果落盘 data/runtime/mycards/<uid>.json（页面重进可恢复）
// 限流：每用户每天 1 张（仅成功计入）+ 每天 3 次尝试上限（#40）；全站每天 20 张（MYCARD_GLOBAL_CAP 可覆盖），任务发起即写台账、失败不退（防刷）
// 自动炼卡：用户拉收藏时快照落盘 data/runtime/favs/<uid>.json（OAuth token 会过期、快照不过期）；每日 07:00 给订阅用户从快照炼新卡（autoMake），
//   独立配额每用户 3 张/天 + 全站 30 张/天（MYCARD_AUTO_GLOBAL_CAP 可覆盖），台账记 auto 字段；via='auto' 的结果不挡当日手动入口
// 三道工序的 prompt/校验逻辑原样复制自 scripts/（breakdown / make_card / blind_review），scripts 的 CLI 用法不受影响
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { cstDateStr, cstFmt } from './time.mjs';
import { createGeminiChat, parseLlmJson } from './gemini.mjs';
import { runtimeDir } from './runtime.mjs';
import { fetchZhidaAnswer } from './zhida.mjs';

const DAY = 86400;
const GLOBAL_DAILY_CAP = Number(process.env.MYCARD_GLOBAL_CAP) > 0 ? Number(process.env.MYCARD_GLOBAL_CAP) : 20; // Sealos 环境变量覆盖（演示兜底，#40）
const PER_USER_ATTEMPTS_DAILY = 3; // 每用户每日尝试上限：失败可重试，但重试也烧全站名额，不能无限（#40）
const AUTO_PER_USER_DAILY = 3; // 自动炼卡：每订阅用户每日最多 3 张
const AUTO_GLOBAL_DAILY_CAP = Number(process.env.MYCARD_AUTO_GLOBAL_CAP) > 0 ? Number(process.env.MYCARD_AUTO_GLOBAL_CAP) : 30; // 自动炼卡全站日上限（独立于手动 20 张）
const AUTO_RETRY_AFTER_DAYS = 3; // 自动尝试过的收藏（含盲审打回）3 天内不再自动重试
const ZHIDA_THRESHOLD = 90; // 直答日台账阈值，与 lib/ask.mjs / scripts/breakdown.mjs 同口径
// 模型照抄 scripts/breakdown.mjs（zhida-thinking-1p5）：异步任务不怕慢，HTTP 超时放宽到 120s
const ZHIDA_MODEL = 'zhida-thinking-1p5';
const ZHIDA_TIMEOUT = 120000;

// ---- 以下三段原样复制自 scripts/breakdown.mjs / make_card.mjs / blind_review.mjs ----
const legacyKey = (url) => (url || '').split('?')[0].split('/').pop();
const contentKey = (item) => `${item.ContentType}_${legacyKey(item.Url)}`;

function buildQuery(item) {
  if (item.ContentType === 'answer') {
    return `知乎上「${item.Title}」这个问题下的高赞回答，核心观点是什么？请拆解它的内容框架和论证结构。`;
  }
  return `知乎专栏文章《${item.Title}》的核心观点是什么？请拆解它的内容框架和论证结构，并总结作者的主要论据。`;
}

const CARD_PROMPT = (title, breakdown) => `你是知识卡片制作专家。下面是一条知乎收藏和 AI 对该问题下优质讨论的拆解。
请把拆解整理成一张学习卡片，输出严格 JSON（不要 markdown 代码块），字段：
coreView: string 核心观点一句话（≤50字）
thread: {step: string, detail: string}[] 讲解脉络（3-5步，step 小标题≤12字，detail≤60字）。还原讲解的推进顺序和逻辑转折
keyInsight: string 关键洞察——这个东西为什么成立/为什么巧妙：核心证明思路、关键技巧或直觉类比（≤100字；涉及公式一律用 LaTeX 保留，如 $A^TP+PA=-Q$；纯观点类内容可留空字符串）
points: string[] 恰好3个关键知识点（每条≤40字，可含 LaTeX）
quote: string 金句一条（≤30字）
difficulty: "easy"|"medium"|"hard"
topicTags: string[] 2-4个领域标签

内容类型要求：
- 理科/知识类：thread 必须还原「问题是什么 → 直觉怎么想 → 关键技巧 → 严格论证 → 应用与局限」的推进路径；keyInsight 必填；绝不能为了简短丢掉推导亮点和公式
- 观点/讨论类：thread 还原观点交锋与论证结构；keyInsight 可留空
通用要求：忠于拆解内容，不编造拆解里没有的事实；语言说人话。

收藏标题：${title}
拆解内容：
${breakdown}`;

function parseCard(text) {
  const obj = parseLlmJson(text);
  if (typeof obj.coreView !== 'string' || !Array.isArray(obj.points) || obj.points.length !== 3
    || typeof obj.quote !== 'string' || !['easy', 'medium', 'hard'].includes(obj.difficulty)
    || !Array.isArray(obj.topicTags)) throw new Error('schema invalid');
  if (!Array.isArray(obj.thread) || obj.thread.length < 3 || obj.thread.length > 5
    || obj.thread.some((s) => typeof s?.step !== 'string' || typeof s?.detail !== 'string')) {
    throw new Error('thread invalid (need 3-5 steps with step/detail)');
  }
  if (typeof obj.keyInsight !== 'string') throw new Error('keyInsight must be string');
  return obj;
}

// 只取 schema 字段组装卡片，防止模型回显多余键覆盖身份字段（id/source 等）
const pickCardFields = ({ coreView, thread, keyInsight, points, quote, difficulty, topicTags }) =>
  ({ coreView, thread, keyInsight, points, quote, difficulty, topicTags });

const REVIEW_PROMPT = (card, breakdown) => `你是盲审考官。一张学习卡片声称是对「拆解原文」的忠实浓缩。卡片的产品定位是 2 分钟读完的精华摘要，不要求包含原文全部细节。

请做两项检查：
1. 忠实性：卡片中的每个事实性陈述（含公式），是否都能在拆解原文中找到依据？列出任何原文不支持的内容（幻觉）。卡片比原文简略不算问题，编造才算。
2. 核心覆盖：拆解原文的核心观点和最关键的论证步骤，卡片是否捕捉到了？只要求覆盖「核心」，细节缺失不算问题。

输出严格 JSON：{
  "faithful": bool,
  "unsupportedClaims": string[] (幻觉清单，没有则空数组),
  "coreCovered": bool,
  "missingCore": string[] (漏掉的核心点，没有则空数组),
  "score": number (0-5，5=忠实且核心全覆盖),
  "comment": string (一句话评语)
}
判定：faithful=true 且 coreCovered=true 为通过。

卡片：
核心观点：${card.coreView}
讲解脉络：${(card.thread || []).map((s) => s.step + ': ' + s.detail).join('；')}
关键洞察：${card.keyInsight || '（无）'}
要点：${card.points.join('；')}
金句：${card.quote}

拆解原文：
${breakdown}`;
// ---- 复制段落结束 ----

// 选收藏：72h 内最新的一条；72h 内没有新收藏则降级选最新一条；pin 无实质内容不参与
// excludeUrls：已炼过的收藏（卡册历史）不再重复炼——自动炼卡天天跑，手动入口也不同日重复烧额度
function pickFavorite(items, excludeUrls) {
  const eligible = (items || []).filter((i) => i && i.Url && i.FavTime && i.ContentType !== 'pin' && !excludeUrls?.has(i.Url));
  if (!eligible.length) return null;
  eligible.sort((a, b) => b.FavTime - a.FavTime);
  const now = Math.floor(Date.now() / 1000);
  const fresh = eligible.find((i) => now - i.FavTime <= 3 * DAY);
  return fresh ? { item: fresh, fresh: true } : { item: eligible[0], fresh: false };
}

// reviewDetail 是管线内部字段，不下发前端（与 server.mjs /api/cards 同口径）
function publicCard(card) {
  if (!card) return null;
  const { reviewDetail, ...rest } = card;
  return rest;
}

export function createMyCard(root) {
  const jobs = new Map(); // uid -> job（内存态；落盘文件兜底页面重进/重启恢复）
  // 管线运行中标志：覆盖 runJob 全生命周期（手动 start 返回后后台管线仍在跑、inflight 已释放，issue #49）
  // 供 autoMake 让路判断与手动入口去重；auto job 也登记，但不进 jobs Map（auto 产物不挡当日手动闸门）
  const running = new Map(); // uid -> job
  const quotaDir = path.join(runtimeDir(root), 'quota');
  const zhidaDir = path.join(root, 'data', 'cache', 'zhida');
  const mycardsDir = path.join(runtimeDir(root), 'mycards');
  const accessSecret = process.env.ZHIHU_ACCESS_SECRET || '';
  const geminiBase = process.env.GEMINI_BASE_URL || '';
  const geminiKey = process.env.GEMINI_API_KEY || '';
  const geminiReady = Boolean(geminiBase && geminiKey);
  // 炼卡/盲审模型与 scripts 同来源：GEMINI_MODEL_FLASH（炼卡，默认 gemini-2.5-flash）/ GEMINI_MODEL_PRO（盲审，默认 gemini-3.8-flash-high）
  const cardChat = geminiReady
    ? createGeminiChat({ base: geminiBase, key: geminiKey, model: process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash', temperature: 0.3 }) : null;
  const reviewChat = geminiReady
    ? createGeminiChat({ base: geminiBase, key: geminiKey, model: process.env.GEMINI_MODEL_PRO || 'gemini-3.8-flash-high', temperature: 0.1 }) : null;

  const resultFile = (uid) => path.join(mycardsDir, `${encodeURIComponent(uid)}.json`);

  // 台账与 ask/breakdown 共用 data/runtime/quota/<yyyy-mm-dd>.json：{ count（直答总账）, mycards（今日炼卡发起数）, mytries（每用户今日尝试数） }，字段向后兼容
  // 读-改-写用 Promise 链串行化（同 lib/ask.mjs 写法）
  const quotaFile = () => path.join(quotaDir, `${cstDateStr()}.json`);
  async function readQuota() {
    try {
      const q = JSON.parse(await readFile(quotaFile(), 'utf8'));
      return { date: cstDateStr(), count: 0, mycards: 0, mytries: {}, ...q };
    } catch { return { date: cstDateStr(), count: 0, mycards: 0, mytries: {} }; }
  }
  async function writeQuota(q) {
    await mkdir(quotaDir, { recursive: true });
    const tmp = quotaFile() + '.tmp';
    await writeFile(tmp, JSON.stringify(q, null, 2));
    await rename(tmp, quotaFile());
  }
  let quotaLock = Promise.resolve();
  function withQuotaLock(fn) {
    const run = quotaLock.then(fn);
    quotaLock = run.catch(() => {});
    return run;
  }

  // 结果文件读-改-写按 uid 串行化（issue #49：auto 与 manual 并发、快速连点会互相覆盖卡册记录或复习进度）
  const resultLocks = new Map(); // uid -> 链尾 Promise
  function withResultLock(uid, fn) {
    const prev = resultLocks.get(uid) || Promise.resolve();
    const run = prev.then(fn);
    const tracked = run.catch(() => {});
    resultLocks.set(uid, tracked);
    tracked.finally(() => { if (resultLocks.get(uid) === tracked) resultLocks.delete(uid); });
    return run;
  }

  async function persist(job, card) {
    await mkdir(mycardsDir, { recursive: true });
    await withResultLock(job.uid, async () => {
      // 历史卡册：approved 卡按 id 去重累积（新的在前），供 /api/cards?scope=mine 与复习队列使用；封顶 50 防文件膨胀
      let history = [];
      if (card?.status === 'approved') history.push(publicCard(card));
      try {
        const prev = JSON.parse(await readFile(resultFile(job.uid), 'utf8'));
        for (const c of prev.cards || []) if (!history.some((h) => h.id === c.id)) history.push(c);
      } catch { /* 无历史 */ }
      history = history.slice(0, 50);
      const rec = {
        date: cstDateStr(),
        uid: job.uid,
        jobId: job.jobId,
        via: job.via || 'manual', // auto 产物不挡当日手动入口（statusFor/startInner 的今日闸门只看 manual）
        status: job.status === 'done' ? 'done' : 'failed',
        error: job.error || null,
        card: card || null,
        cards: history,
        source: {
          contentType: job.item.ContentType, title: job.item.Title, url: job.item.Url,
          favTime: job.item.FavTime, pickedFrom72h: job.pickedFrom72h,
        },
        finishedAt: Date.now(),
      };
      const tmp = resultFile(job.uid) + '.tmp';
      await writeFile(tmp, JSON.stringify(rec, null, 2));
      await rename(tmp, resultFile(job.uid));
    });
  }

  // 下发前端的错误文案：已是用户可读的（盲审打回 / 直答类 / 额度紧张）原样放行，
  // 其余内部错误（gemini http 报文、schema invalid 等）映射为通用文案，不向前端透出实现细节（#54）
  const USER_READABLE_ERROR = /^(盲审未通过|直答|今日直答总额度紧张)/;
  function publicError(raw) {
    const msg = String(raw || '');
    return USER_READABLE_ERROR.test(msg) ? msg : '卡片生成失败，请稍后重试';
  }

  function publicJob(job) {
    const source = {
      title: job.item.Title, url: job.item.Url, favTime: job.item.FavTime, pickedFrom72h: job.pickedFrom72h,
    };
    if (job.status === 'done') return { ok: true, jobId: job.jobId, status: 'done', card: publicCard(job.result?.card), source };
    if (job.status === 'failed') return { ok: true, jobId: job.jobId, status: 'failed', error: publicError(job.error), source };
    return { ok: true, jobId: job.jobId, status: job.status, source };
  }

  // 直答拆解：先查缓存（命中零额度，与 breakdown.mjs 同目录、新旧两套命名都查），未命中走 HTTP 直答
  async function ensureBreakdown(item, key) {
    for (const f of [path.join(zhidaDir, `${key}.json`), path.join(zhidaDir, `${legacyKey(item.Url)}.json`)]) {
      try { return JSON.parse(await readFile(f, 'utf8')); } catch { /* 无缓存，继续 */ }
    }
    // 计数前置：即将发请求先计 1 次；上游失败在下方回滚（与 ask.mjs issue #44 同口径——breakdown.mjs 离线脚本仍计尝试，口径自此分化）；阈值检查与计数在同一锁内
    await withQuotaLock(async () => {
      const q = await readQuota();
      // code 供自动炼卡识别「全局停跑」；文案不变（手动入口原样透出）
      if (q.count >= ZHIDA_THRESHOLD) throw Object.assign(new Error('今日直答总额度紧张，现场拆解暂停开放，明天再来'), { code: 'ZHIDA_THROTTLED' });
      q.count++;
      q.updatedAt = Date.now();
      await writeQuota(q);
    });
    const query = buildQuery(item);
    let parsed;
    try {
      // 共享直答调用层（lib/zhida.mjs）：鉴权/解析/#42 可读错误文案与 ask.mjs 同口径
      parsed = await fetchZhidaAnswer({ apiKey: accessSecret, model: ZHIDA_MODEL, prompt: query, timeoutMs: ZHIDA_TIMEOUT });
    } catch (e) {
      // 上游失败回滚直答台账（mycards/mytries 名额「失败不退」是防刷设计，保留不动）
      try {
        await withQuotaLock(async () => {
          const q = await readQuota();
          q.count = Math.max(0, q.count - 1);
          q.updatedAt = Date.now();
          await writeQuota(q);
        });
      } catch { /* 回滚失败不掩盖原始错误 */ }
      throw e;
    }
    // 落盘缓存：铁律「同一收藏永不重复请求」，后续炼卡/重试直接命中
    const rec = { key, url: item.Url, title: item.Title, query, model: parsed.model, content: parsed.content, fetchedAt: Date.now() };
    await mkdir(zhidaDir, { recursive: true });
    const tmp = path.join(zhidaDir, `${key}.json.tmp`);
    await writeFile(tmp, JSON.stringify(rec, null, 2));
    await rename(tmp, path.join(zhidaDir, `${key}.json`));
    return rec;
  }

  async function runJob(job) {
    const item = job.item;
    const key = contentKey(item);

    // 工序 1：直答拆解
    const breakdown = await ensureBreakdown(item, key);

    // 工序 2：Gemini 炼卡（LaTeX 转义坑防护原样保留：sanitizer 在 parseLlmJson 内，失败重试一次并降级公式为中文描述）
    job.status = 'making_card';
    const text = await cardChat(CARD_PROMPT(breakdown.title, breakdown.content));
    let parsed;
    try {
      parsed = parseCard(text);
    } catch {
      const retryText = await cardChat(CARD_PROMPT(breakdown.title, breakdown.content) + '\n\n重要：JSON 字符串中所有反斜杠必须双写（\\\\），LaTeX 公式改用中文文字描述。');
      parsed = parseCard(retryText);
    }
    const card = {
      id: `card_${key}`,
      source: {
        contentType: item.ContentType, title: item.Title, url: item.Url,
        authorName: item.Author?.Name ?? '', favTime: item.FavTime, likeCount: item.LikeCount,
      },
      ...pickCardFields(parsed),
      status: 'pending_review', reviewScore: null,
      nextReviewAt: Math.floor(Date.now() / 1000), reviewCount: 0,
      createdAt: Math.floor(Date.now() / 1000),
    };

    // 工序 3：盲审门禁 v2（基于缓存的拆解原文，不重新请求直答）
    job.status = 'reviewing';
    const judged = parseLlmJson(await reviewChat(REVIEW_PROMPT(card, breakdown.content)));
    card.reviewScore = judged.score;
    card.reviewDetail = judged;
    if (judged.faithful && judged.coreCovered) {
      card.status = 'approved';
      job.status = 'done';
      job.result = { card };
      await persist(job, card);
      console.log(`[mycard] ${job.uid} 炼卡完成：${card.id}（盲审 ${judged.score}/5）`);
    } else {
      card.status = 'rejected';
      const why = [
        !judged.faithful && `卡片与原文有出入（${(judged.unsupportedClaims || []).length} 处）`,
        !judged.coreCovered && '漏掉了核心内容',
      ].filter(Boolean).join('；');
      job.status = 'failed';
      job.error = `盲审未通过：${why || '整体质量不达标'}。这张不算你今天的 1 张，可以重试`;
      await persist(job, card);
      console.log(`[mycard] ${job.uid} 盲审打回：${card.id}（${judged.score}/5）`);
    }
  }

  // GET /api/my/card：内存任务优先（只认当天，跨天的内存任务视同年鉴过期，#38），其次今日落盘结果，都没有则 idle + 全局名额余量
  async function statusFor(uid) {
    const job = jobs.get(uid);
    if (job && job.date === cstDateStr()) return publicJob(job);
    // 自动管线运行中也显示进度（auto job 不进 jobs Map）——否则轮询显示 idle、点开始却返回 already，前端状态前后矛盾
    const runningJob = running.get(uid);
    if (runningJob && runningJob.date === cstDateStr()) return publicJob(runningJob);
    try {
      const rec = JSON.parse(await readFile(resultFile(uid), 'utf8'));
      // via='auto' 的落盘结果不对用户展示为「今日已炼」——自动炼卡不占手动入口
      if (rec.date === cstDateStr() && rec.via !== 'auto') {
        if (rec.status === 'done') return { ok: true, status: 'done', card: publicCard(rec.card), source: rec.source };
        if (rec.status === 'failed') return { ok: true, status: 'failed', error: publicError(rec.error), source: rec.source };
      }
    } catch { /* 无记录 */ }
    const q = await readQuota();
    return { ok: true, status: 'idle', quota: { used: q.mycards, cap: GLOBAL_DAILY_CAP } };
  }

  // POST /api/my/card：已生成→直接返回 → 全局名额（发起即计）→ 无收藏空态 → 发起异步任务
  // getFavorites: () => Promise<{ items }>（server 侧注入 oauth.fetchMyFavorites，会话内缓存）
  async function startInner(uid, getFavorites) {
    if (!accessSecret || !geminiReady) {
      return { code: 503, body: { ok: false, notReady: true, error: '现场炼卡功能未就绪（服务端缺少 ZHIHU_ACCESS_SECRET / GEMINI 配置）' } };
    }
    // 惰性清扫：防 jobs Map 只涨不消（单实例演示体量极小，兜底即可）
    if (jobs.size >= 500) {
      const cutoff = Date.now() - DAY * 1000;
      for (const [k, j] of jobs) if (['done', 'failed'].includes(j.status) && j.createdAt < cutoff) jobs.delete(k);
    }
    // 内存任务只认当天：跨天的内存 done/running 不得阻挡新的一天（#38，落盘分支 :302 的日期闸门是同口径）
    const today = cstDateStr();
    const existing = jobs.get(uid);
    if (existing && existing.date === today && !['done', 'failed'].includes(existing.status)) {
      return { code: 200, body: { ...publicJob(existing), already: true } };
    }
    if (existing?.status === 'done' && existing.result && existing.date === today) {
      return { code: 200, body: { ...publicJob(existing), already: true } };
    }
    // 自动管线运行中（auto job 不进 jobs Map）：手动入口按 already 语义返回该任务进度，不重复发起、不双烧名额（issue #49）
    const runningJob = running.get(uid);
    if (runningJob && runningJob.date === today) {
      return { code: 200, body: { ...publicJob(runningJob), already: true } };
    }
    // 今日已成功生成 → 直接返回已有结果（不重复烧额度）；via='auto' 不落此闸门（自动炼卡不占手动入口）
    try {
      const rec = JSON.parse(await readFile(resultFile(uid), 'utf8'));
      if (rec.date === cstDateStr() && rec.status === 'done' && rec.via !== 'auto') {
        return { code: 200, body: { ok: true, status: 'done', already: true, card: publicCard(rec.card), source: rec.source } };
      }
    } catch { /* 无记录 */ }

    let items;
    try {
      ({ items } = await getFavorites());
    } catch (e) {
      if (e.code === 'LOGIN_REQUIRED' || e.code === 'ACCESS_SECRET_MISSING') throw e; // 交分发层统一映射
      return { code: 502, body: { ok: false, error: '收藏夹拉取失败，请稍后重试' } };
    }
    // 卡册历史里已炼过的收藏不再重复炼（含自动炼卡产物——自动天天跑，手动入口同口径去重）
    const pick = pickFavorite(items, new Set((await listCards(uid)).map((c) => c.source?.url).filter(Boolean)));
    if (!pick) {
      return { code: 422, body: { ok: false, noFavorites: true, error: '你的收藏夹里还没有可拆解的收藏（回答/文章），先去知乎收藏一条感兴趣的内容，明天再来' } };
    }

    // 占位先于名额检查：并发同人双发时第二个请求看到占位直接返回，不会双烧全局名额
    const job = {
      jobId: randomBytes(8).toString('hex'), uid, status: 'breaking_down', error: null,
      item: pick.item, pickedFrom72h: pick.fresh, createdAt: Date.now(), result: null,
      date: cstDateStr(), // 日期戳：内存任务跨天自动失效（#38）
    };
    jobs.set(uid, job);

    // 名额闸门：任务真正发起时写台账，失败不退还（防刷）；但失败不算用户的 1 张，可重试（上限见 mytries）
    let gate;
    try {
      gate = await withQuotaLock(async () => {
        const q = await readQuota();
        if ((q.mytries[uid] || 0) >= PER_USER_ATTEMPTS_DAILY) {
          return {
            reject: {
              code: 429,
              body: { ok: false, attemptsExceeded: true, error: '今天尝试次数用完了，明天再来' },
            },
          };
        }
        if (q.mycards >= GLOBAL_DAILY_CAP) {
          return {
            reject: {
              code: 429,
              body: { ok: false, quotaExceeded: true, error: '今日体验名额已用完，明天再来', quota: { used: q.mycards, cap: GLOBAL_DAILY_CAP } },
            },
          };
        }
        q.mycards++;
        q.mytries[uid] = (q.mytries[uid] || 0) + 1;
        q.updatedAt = Date.now();
        await writeQuota(q);
        return {};
      });
    } catch (e) {
      // 闸门自身故障（磁盘满/台账写失败）：先清占位再抛，否则用户当日被 already 分支永久挡住（issue #49）
      jobs.delete(uid);
      throw e;
    }
    if (gate.reject) {
      jobs.delete(uid);
      return gate.reject;
    }

    const pipeline = runJob(job).catch((e) => {
      job.status = 'failed';
      job.error = String(e?.message || e).slice(0, 200);
      persist(job, job.result?.card || null).catch(() => {});
      console.error(`[mycard] ${uid} 任务失败：`, job.error);
    });
    running.set(uid, job);
    pipeline.finally(() => { if (running.get(uid) === job) running.delete(uid); });
    return { code: 200, body: { ok: true, jobId: job.jobId, status: job.status, source: publicJob(job).source } };
  }

  // GET /api/cards?scope=mine：用户自己的历史卡册（approved，含复习进度字段）
  async function listCards(uid) {
    try {
      const rec = JSON.parse(await readFile(resultFile(uid), 'utf8'));
      if (Array.isArray(rec.cards) && rec.cards.length) return rec.cards.map(publicCard);
      // 旧格式兜底：只有当日单卡
      if (rec.status === 'done' && rec.card) return [publicCard(rec.card)];
    } catch { /* 无记录 */ }
    return [];
  }

  // POST /api/review {scope:'mine'}：用户自己的卡走独立复习进度（间隔 +1/+3/+7 天，3 次 digested，与站卡同口径）
  const INTERVALS = [1 * DAY, 3 * DAY, 7 * DAY];
  async function markReviewed(uid, id) {
    return withResultLock(uid, async () => {
      let rec;
      try { rec = JSON.parse(await readFile(resultFile(uid), 'utf8')); } catch { return null; }
      const list = Array.isArray(rec.cards) ? rec.cards : (rec.status === 'done' && rec.card ? [rec.card] : []);
      const card = list.find((c) => c.id === id);
      if (!card) return null;
      card.reviewCount = (card.reviewCount ?? 0) + 1;
      const now = Math.floor(Date.now() / 1000);
      if (card.reviewCount >= 3) {
        card.status = 'digested';
        card.nextReviewAt = null;
      } else {
        card.nextReviewAt = now + INTERVALS[card.reviewCount - 1];
      }
      rec.cards = list;
      if (rec.card?.id === id) rec.card = card;
      const tmp = resultFile(uid) + '.tmp';
      await writeFile(tmp, JSON.stringify(rec, null, 2));
      await rename(tmp, resultFile(uid));
      return publicCard(card);
    });
  }

  // per-uid 互斥：start 与 autoMake 共用（#49 残余窗口——autoMake 的 busy 检查到 running 登记之间有多轮 await，
  // 手动 start 落进窗口会双管线并行；「检查 running + 登记」放进同一把锁才对彼此原子）
  // start 侧语义不变（#39）：排队的第二个请求进入 startInner 时必看到第一个的占位/结果，按既有 already 语义返回
  const inflight = new Map(); // uid -> 链尾 Promise
  function withUidLock(uid, fn) {
    const prev = inflight.get(uid) || Promise.resolve();
    const run = prev.then(fn);
    const tracked = run.catch(() => {});
    inflight.set(uid, tracked);
    tracked.finally(() => { if (inflight.get(uid) === tracked) inflight.delete(uid); });
    return run;
  }
  function start(uid, getFavorites) {
    return withUidLock(uid, () => startInner(uid, getFavorites));
  }

  // ---- 收藏快照 + 每日自动炼卡 ----
  // 快照：用户登录态下拉到的收藏元数据落盘（OAuth token 会过期、快照不过期）；tried 记录自动尝试过的 contentKey → CST 日期
  const favsDir = path.join(runtimeDir(root), 'favs');
  const favsFile = (uid) => path.join(favsDir, `${encodeURIComponent(uid)}.json`);
  let favsLock = Promise.resolve();
  const withFavsLock = (fn) => { const run = favsLock.then(fn); favsLock = run.catch(() => {}); return run; };

  async function saveFavSnapshot(uid, items) {
    if (!uid || !Array.isArray(items) || !items.length) return;
    await withFavsLock(async () => {
      let tried = {};
      try { tried = JSON.parse(await readFile(favsFile(uid), 'utf8')).tried || {}; } catch { /* 首次 */ }
      await mkdir(favsDir, { recursive: true });
      const tmp = favsFile(uid) + '.tmp';
      await writeFile(tmp, JSON.stringify({ uid, savedAt: Date.now(), items: items.slice(0, 500), tried }));
      await rename(tmp, favsFile(uid));
    });
  }

  async function readFavSnapshot(uid) {
    try { return JSON.parse(await readFile(favsFile(uid), 'utf8')); } catch { return null; }
  }

  // 每日自动炼卡（调度在 server.mjs：07:00 跑，赶在 08:00 推送前完工）：逐订阅用户从快照挑未炼过的收藏，串行走 runJob 完整管线
  // 独立配额（台账 auto 字段，向后兼容）：每用户 AUTO_PER_USER_DAILY 张/天 + 全站 AUTO_GLOBAL_DAILY_CAP 张/天，发起即计；
  // 拆解命中 data/cache/zhida 缓存则零直答额度；ZHIDA_THROTTLED（直答日阈值）与全站上限 = 全局停跑信号
  async function autoMake(uids) {
    if (!accessSecret || !geminiReady) {
      console.log('[mycard] 自动炼卡未就绪（缺 ZHIHU_ACCESS_SECRET / GEMINI 配置），跳过');
      return { ok: false, notReady: true };
    }
    const summary = { made: 0, failed: 0, skipped: 0, users: {} };
    const now = Math.floor(Date.now() / 1000);
    const retryCutoff = cstFmt(now - AUTO_RETRY_AFTER_DAYS * DAY); // tried 日期 ≥ 此值 = 最近已尝试，跳过
    for (const uid of uids) {
      // 与手动入口撞车时让路：手动任务有用户在线等结果，自动任务明天再跑
      // running 覆盖管线全生命周期（手动 start 返回后后台管线仍在跑，issue #49）；同 uid 自动任务自己也登记
      if (inflight.has(uid) || running.has(uid)) { summary.users[uid] = 'busy'; summary.skipped++; continue; }
      const snap = await readFavSnapshot(uid);
      if (!snap?.items?.length) { summary.users[uid] = 'no_snapshot'; summary.skipped++; continue; }
      const doneUrls = new Set((await listCards(uid)).map((c) => c.source?.url).filter(Boolean));
      const tried = snap.tried || {};
      const candidates = snap.items
        .filter((i) => i && i.Url && i.FavTime && i.ContentType !== 'pin')
        .filter((i) => !doneUrls.has(i.Url))
        .filter((i) => !tried[contentKey(i)] || tried[contentKey(i)] < retryCutoff)
        .sort((a, b) => b.FavTime - a.FavTime);
      if (!candidates.length) { summary.users[uid] = 'exhausted'; summary.skipped++; continue; }
      let made = 0;
      for (const item of candidates) {
        // 配额闸门 + running 登记放进与 start() 同一把 per-uid 互斥：手动 start 无法插进「检查→登记」窗口（#49 评审跟进）
        // 注意只在登记前持锁——整段管线持锁会让手动请求从「already 快速返回」退化成「排队等自动管线跑完再白烧一张手动名额」
        const prepared = await withUidLock(uid, async () => {
          if (running.has(uid)) return { busy: true }; // 排队期间手动管线已启动，让路
          const gate = await withQuotaLock(async () => {
            const q = await readQuota();
            const auto = q.auto || { total: 0, per: {} };
            if ((auto.per[uid] || 0) >= AUTO_PER_USER_DAILY) return { stop: 'user_cap' };
            if (auto.total >= AUTO_GLOBAL_DAILY_CAP) return { stop: 'global_cap' };
            auto.total++;
            auto.per[uid] = (auto.per[uid] || 0) + 1;
            q.auto = auto;
            q.updatedAt = Date.now();
            await writeQuota(q);
            return {};
          });
          if (gate.stop) return { stop: gate.stop };
          const job = {
            jobId: `auto-${randomBytes(6).toString('hex')}`, uid, status: 'breaking_down', error: null,
            item, pickedFrom72h: now - item.FavTime <= 3 * DAY, createdAt: Date.now(), result: null,
            date: cstDateStr(), via: 'auto',
          };
          running.set(uid, job);
          return { job };
        });
        if (prepared.busy) { summary.users[uid] = 'busy'; summary.skipped++; break; }
        if (prepared.stop) {
          summary.users[uid] = prepared.stop;
          if (prepared.stop === 'global_cap') summary.globalCap = true;
          break;
        }
        const job = prepared.job;
        try {
          await runJob(job);
        } catch (e) {
          job.status = 'failed';
          job.error = String(e?.message || e).slice(0, 200);
          await persist(job, job.result?.card || null).catch(() => {});
          console.error(`[mycard] ${uid} 自动炼卡失败：`, job.error);
          if (e.code === 'ZHIDA_THROTTLED') summary.throttled = true;
        } finally {
          if (running.get(uid) === job) running.delete(uid);
        }
        // 成败都标记：盲审打回/故障的收藏 3 天内不再自动重试（手动重试走 start，不受影响）
        await withFavsLock(async () => {
          const s = await readFavSnapshot(uid);
          if (!s) return;
          s.tried = { ...(s.tried || {}), [contentKey(item)]: cstDateStr() };
          const tmp = favsFile(uid) + '.tmp';
          await writeFile(tmp, JSON.stringify(s));
          await rename(tmp, favsFile(uid));
        });
        if (job.status === 'done') { made++; summary.made++; doneUrls.add(item.Url); } else { summary.failed++; }
        if (summary.throttled) break;
      }
      if (!summary.users[uid]) summary.users[uid] = made > 0 ? `made_${made}` : 'failed';
      if (summary.throttled || summary.globalCap) { console.warn('[mycard] 自动炼卡全局停跑：', summary.throttled ? '直答日阈值触发' : '全站自动名额用尽'); break; }
    }
    console.log(`[mycard] 自动炼卡完成：成 ${summary.made}、败 ${summary.failed}、跳过 ${summary.skipped}`);
    return { ok: true, ...summary };
  }

  return { start, statusFor, listCards, markReviewed, saveFavSnapshot, readFavSnapshot, autoMake, GLOBAL_DAILY_CAP };
}
