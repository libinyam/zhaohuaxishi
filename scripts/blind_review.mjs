// 盲审门禁 v2：忠实性 + 核心覆盖（卡片是「忠实浓缩」，不是全文复刻）
// 两条红线：① 卡片里有拆解不支持的内容（幻觉）② 漏掉拆解的核心观点
// 用法：node --env-file=.env.local scripts/blind_review.mjs [--limit N]
import { readFile, writeFile, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGeminiChat, parseLlmJson } from '../lib/gemini.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GEMINI_BASE_URL;
const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL_PRO || 'gemini-3.8-flash-high';
if (!BASE || !KEY) { console.error('缺少 GEMINI_BASE_URL / GEMINI_API_KEY 环境变量'); process.exit(1); }

const chat = createGeminiChat({ base: BASE, key: KEY, model: MODEL, temperature: 0.1 });

const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

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
  console.log(`[${done + 1}] 盲审 ${card.id} 「${(card.source.title || '').slice(0, 25)}」`);
  try {
    const breakdown = JSON.parse(await readFile(path.join(zhidaDir, `${zhidaKey}.json`), 'utf8'));
    const judged = parseLlmJson(await chat(REVIEW_PROMPT(card, breakdown.content)));
    card.reviewScore = judged.score;
    card.reviewDetail = judged;
    if (judged.faithful && judged.coreCovered) {
      card.status = 'approved';
      passed++;
      console.log(`    PASS ${judged.score}/5 - ${judged.comment?.slice(0, 50)}`);
    } else {
      card.status = 'rejected';
      failedGate++;
      const why = [!judged.faithful && `幻觉:${judged.unsupportedClaims?.length}`, !judged.coreCovered && `漏核心:${judged.missingCore?.length}`].filter(Boolean).join(' ');
      console.log(`    REJECT ${judged.score}/5 ${why}`);
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
