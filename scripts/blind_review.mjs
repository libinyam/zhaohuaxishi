// 盲审门禁：基于缓存的直答拆解原文出题，考卡片内容，≥4/5 通过
// 零直答额度消耗（只读缓存 + Gemini）
// 用法：node scripts/blind_review.mjs [--limit N]
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GEMINI_BASE_URL;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL_PRO || 'gemini-2.5-pro';
if (!BASE || !KEY) { console.error('缺少 GEMINI_BASE_URL / GEMINI_API_KEY 环境变量'); process.exit(1); }

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

async function chat(prompt) {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
  });
  if (!resp.ok) throw new Error(`gemini http ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return (await resp.json()).choices[0].message.content;
}

const parseJson = (t) => JSON.parse(t.replace(/```json|```/g, '').trim());

const cardsDir = path.join(root, 'data', 'cache', 'cards');
const zhidaDir = path.join(root, 'data', 'cache', 'zhida');
const files = (await readdir(cardsDir)).filter((f) => f.endsWith('.json'));
let done = 0, passed = 0, failedGate = 0;

for (const f of files) {
  if (done >= limit) break;
  const cardFile = path.join(cardsDir, f);
  const card = JSON.parse(await readFile(cardFile, 'utf8'));
  if (card.status !== 'pending_review') continue;

  const zhidaKey = card.id.replace('card_', '');
  const breakdown = JSON.parse(await readFile(path.join(zhidaDir, `${zhidaKey}.json`), 'utf8'));

  console.log(`[${done + 1}] 盲审 ${card.id} 「${(card.source.title || '').slice(0, 25)}」`);
  try {
    // 第一步：基于拆解原文出题（3 事实 + 2 理解）
    const quiz = parseJson(await chat(`基于以下拆解内容出5道考题（3道事实回忆+2道理解应用），输出严格JSON数组，每项{q, a}（a为标准答案要点）：\n${breakdown.content}`));
    // 第二步：仅凭卡片内容作答
    const cardText = `核心观点：${card.coreView}\n要点：${card.points.join('；')}\n金句：${card.quote}`;
    const judged = parseJson(await chat(`你是严格考官。仅凭以下卡片内容回答考题并评分。输出严格JSON：{score: 0-5, results: [{q, cardAnswer, correct: bool}]}\n\n卡片：\n${cardText}\n\n考题：\n${JSON.stringify(quiz)}`));
    card.reviewScore = judged.score;
    card.reviewDetail = judged.results;
    if (judged.score >= 4) {
      card.status = 'approved';
      passed++;
      console.log(`    PASS ${judged.score}/5`);
    } else {
      card.status = 'rejected'; // 重炼决策由人工/重炼脚本做，避免自动烧直答额度
      failedGate++;
      console.log(`    REJECT ${judged.score}/5`);
    }
    const tmp = cardFile + '.tmp';
    await writeFile(tmp, JSON.stringify(card, null, 2));
    await rename(tmp, cardFile);
    done++;
  } catch (e) {
    console.error(`    FAIL: ${e.message.slice(0, 120)}`);
  }
}
console.log(`done=${done} passed=${passed} rejected=${failedGate}`);
