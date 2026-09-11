// Gemini 炼卡：直答拆解原文 -> 卡片 JSON（按 SPEC Schema）
// 用法：node scripts/make_card.mjs [--limit N]
import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GEMINI_BASE_URL;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL_FLASH || 'gemini-2.5-flash';
if (!BASE || !KEY) { console.error('缺少 GEMINI_BASE_URL / GEMINI_API_KEY 环境变量'); process.exit(1); }

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

const PROMPT = (title, breakdown) => `你是知识卡片制作专家。下面是一条知乎收藏和 AI 对该问题下优质讨论的拆解。
请把拆解整理成一张学习卡片，输出严格 JSON（不要 markdown 代码块），字段：
coreView: string 核心观点一句话（≤50字）
thread: {step: string, detail: string}[] 讲解脉络——作者/回答是怎么一步步把问题讲清楚的（3-5步，step 为这一步的小标题≤12字，detail 说明这一步在讲什么≤50字）。这是卡片的核心，要还原讲解的推进顺序和逻辑转折
points: string[] 恰好3个关键知识点（每条≤40字）
quote: string 金句一条（≤30字）
difficulty: "easy"|"medium"|"hard"
topicTags: string[] 2-4个领域标签
要求：忠于拆解内容，不编造拆解里没有的事实；语言说人话，专业术语要翻译。

收藏标题：${title}
拆解内容：
${breakdown}`;

async function chat(prompt) {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3 }),
  });
  if (!resp.ok) throw new Error(`gemini http ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return data.choices[0].message.content;
}

function parseCard(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const obj = JSON.parse(cleaned);
  if (typeof obj.coreView !== 'string' || !Array.isArray(obj.points) || obj.points.length !== 3
    || typeof obj.quote !== 'string' || !['easy', 'medium', 'hard'].includes(obj.difficulty)
    || !Array.isArray(obj.topicTags)) throw new Error('schema invalid');
  if (!Array.isArray(obj.thread) || obj.thread.length < 3 || obj.thread.length > 5
    || obj.thread.some((s) => typeof s?.step !== 'string' || typeof s?.detail !== 'string')) {
    throw new Error('thread invalid (need 3-5 steps with step/detail)');
  }
  return obj;
}

const fav = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
const byKey = new Map(fav.items.map((i) => [(i.Url || '').split('?')[0].split('/').pop(), i]));
const zhidaDir = path.join(root, 'data', 'cache', 'zhida');
const cardsDir = path.join(root, 'data', 'cache', 'cards');
await mkdir(cardsDir, { recursive: true });

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
    const card = parseCard(text);
    const full = {
      id: `card_${key}`,
      source: item ? {
        contentType: item.ContentType, title: item.Title, url: item.Url,
        authorName: item.Author?.Name ?? '', favTime: item.FavTime, likeCount: item.LikeCount,
      } : { title: breakdown.title, url: breakdown.url },
      ...card,
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
