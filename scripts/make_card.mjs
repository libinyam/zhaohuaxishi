// Gemini 炼卡：直答拆解原文 -> 卡片 JSON（按 SPEC Schema）
// 用法：node --env-file=.env.local scripts/make_card.mjs [--limit N] [--remake]
// --remake：打回重炼模式，带盲审反馈重炼 rejected 卡片（最多 2 次，仍不过降级 summary_only）
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeminiChat, parseLlmJson } from '../lib/gemini.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GEMINI_BASE_URL;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';
if (!BASE || !KEY) { console.error('缺少 GEMINI_BASE_URL / GEMINI_API_KEY 环境变量'); process.exit(1); }

const chat = createGeminiChat({ base: BASE, key: KEY, model: MODEL, temperature: 0.3 });

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const PROMPT = (title, breakdown) => `你是知识卡片制作专家。下面是一条知乎收藏和 AI 对该问题下优质讨论的拆解。
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

const fav = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
// key 前缀 ContentType 防跨类型碰撞（与 breakdown.mjs 对齐）；新旧两套命名都索引，旧命名缓存文件仍能找到收藏条目
const legacyKey = (url) => (url || '').split('?')[0].split('/').pop();
const byKey = new Map();
for (const i of fav.items) {
  byKey.set(legacyKey(i.Url), i);
  byKey.set(`${i.ContentType}_${legacyKey(i.Url)}`, i);
}
const zhidaDir = path.join(root, 'data', 'cache', 'zhida');
const cardsDir = path.join(root, 'data', 'cache', 'cards');
await mkdir(cardsDir, { recursive: true });

// 打回重炼模式（issue #8）：rejected 卡片带盲审反馈重炼，最多 2 次，仍不过降级 summary_only
// 拆解走 zhida 缓存，只消耗 Gemini，不动直答额度
if (args.includes('--remake')) {
  const MAX_REMAKE = 2;
  const cardFiles = (await readdir(cardsDir)).filter((f) => f.endsWith('.json'));
  let remade = 0, downgraded = 0, failedRemake = 0;
  for (const f of cardFiles) {
    if (remade >= limit) break;
    const cardFile = path.join(cardsDir, f);
    const card = JSON.parse(await readFile(cardFile, 'utf8'));
    if (card.status !== 'rejected') continue;
    const remakeCount = card.remakeCount || 0;
    if (remakeCount >= MAX_REMAKE) {
      card.status = 'summary_only';
      const tmp = cardFile + '.tmp';
      await writeFile(tmp, JSON.stringify(card, null, 2));
      await rename(tmp, cardFile);
      downgraded++;
      console.log(`降级 summary_only（已重炼 ${remakeCount} 次仍不过）: ${card.id}`);
      continue;
    }
    try {
      const zhidaKey = card.id.replace('card_', '');
      const breakdown = JSON.parse(await readFile(path.join(zhidaDir, `${zhidaKey}.json`), 'utf8'));
      const fb = card.reviewDetail || {};
      const feedback = [
        ...(fb.unsupportedClaims?.length ? [`幻觉（拆解不支持，必须删除或改正）：${fb.unsupportedClaims.join('；')}`] : []),
        ...(fb.missingCore?.length ? [`漏掉的核心（必须补上）：${fb.missingCore.join('；')}`] : []),
      ].join('\n');
      const prompt = PROMPT(breakdown.title, breakdown.content)
        + `\n\n上次制作的卡片未通过盲审，请针对性修正：\n${feedback || '整体质量不达标，请更忠实地浓缩核心内容。'}`;
      console.log(`[${remade + 1}] 重炼 ${card.id}（第 ${remakeCount + 1}/${MAX_REMAKE} 次）「${(card.source?.title || '').slice(0, 25)}」`);
      const text = await chat(prompt);
      let remadeCard;
      try {
        remadeCard = parseCard(text);
      } catch {
        const retryText = await chat(prompt + '\n\n重要：JSON 字符串中所有反斜杠必须双写（\\\\），LaTeX 公式改用中文文字描述。');
        remadeCard = parseCard(retryText);
      }
      const full = {
        ...card,
        ...pickCardFields(remadeCard),
        status: 'pending_review',
        reviewScore: null,
        reviewDetail: null,
        remakeCount: remakeCount + 1,
      };
      const tmp = cardFile + '.tmp';
      await writeFile(tmp, JSON.stringify(full, null, 2));
      await rename(tmp, cardFile);
      remade++;
      console.log(`    ok: ${full.coreView.slice(0, 40)}`);
    } catch (e) {
      failedRemake++;
      console.error(`    FAIL: ${e.message.slice(0, 120)}`);
    }
  }
  console.log(`remade=${remade} downgraded=${downgraded} failed=${failedRemake}`);
  process.exit(0);
}

const files = (await readdir(zhidaDir)).filter((f) => f.endsWith('.json'));
let done = 0, skipped = 0, failed = 0;

for (const f of files) {
  if (done >= limit) break;
  const key = f.replace('.json', '');
  const cardFile = path.join(cardsDir, `card_${key}.json`);
  try { await readFile(cardFile, 'utf8'); skipped++; continue; } catch { /* 无缓存 */ }

  const breakdown = JSON.parse(await readFile(path.join(zhidaDir, f), 'utf8'));
  const item = byKey.get(key);
  console.log(`[${done + 1}] 炼卡 ${key} 「${(breakdown.title || '').slice(0, 25)}」`);
  try {
    const text = await chat(PROMPT(breakdown.title, breakdown.content));
    let card;
    try {
      card = parseCard(text);
    } catch {
      // 转义问题顽固时重试一次，明确要求转义安全
      const retryText = await chat(PROMPT(breakdown.title, breakdown.content) + '\n\n重要：JSON 字符串中所有反斜杠必须双写（\\\\），LaTeX 公式改用中文文字描述。');
      card = parseCard(retryText);
    }
    const full = {
      id: `card_${key}`,
      source: item ? {
        contentType: item.ContentType, title: item.Title, url: item.Url,
        authorName: item.Author?.Name ?? '', favTime: item.FavTime, likeCount: item.LikeCount,
      } : { title: breakdown.title, url: breakdown.url },
      ...pickCardFields(card),
      status: 'pending_review', reviewScore: null,
      nextReviewAt: Math.floor(Date.now() / 1000), reviewCount: 0,
      createdAt: Math.floor(Date.now() / 1000),
    };
    const tmp = cardFile + '.tmp';
    await writeFile(tmp, JSON.stringify(full, null, 2));
    await rename(tmp, cardFile);
    done++;
    console.log(`    ok: ${full.coreView.slice(0, 40)}`);
  } catch (e) {
    failed++;
    console.error(`    FAIL: ${e.message.slice(0, 120)}`);
  }
}
console.log(`done=${done} cached-skip=${skipped} failed=${failed}`);
