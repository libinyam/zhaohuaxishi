// 用 gpt-image-2 生成黑客松项目封面图 → public/assets/cover.png
// 用法: node --env-file=.env.local scripts/make_cover.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GEMINI_BASE_URL;
const KEY = process.env.GEMINI_API_KEY;
if (!BASE || !KEY) { console.error('缺少 GEMINI_BASE_URL / GEMINI_API_KEY'); process.exit(1); }

// 朝花夕拾：清晨飘落的花瓣在傍晚被拾成学习卡片，暖纸色调，呼应站点 stone/amber 配色
const PROMPT = `Warm editorial illustration, landscape banner: small golden-yellow five-petal flowers
drifting down from a soft morning sky on the left, gently transforming into neat paper study cards
being gathered on the right, one hand picking up a card at dusk. Cream paper background (#F5F1E8),
warm amber and golden yellow accents (#E89B0C, #F6C344), muted stone-gray secondary tones.
Flat vector style with subtle paper grain texture, generous negative space, calm and literary mood,
no text, no letters, no watermark, no border.`;

const resp = await fetch(`${BASE}/images/generations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'gpt-image-2', prompt: PROMPT, size: '1536x1024', n: 1 }),
});
if (!resp.ok) { console.error(`http ${resp.status}: ${(await resp.text()).slice(0, 300)}`); process.exit(1); }
const data = (await resp.json()).data?.[0]?.b64_json;
if (!data) { console.error('响应里没有 b64_json'); process.exit(1); }

const out = path.join(root, 'public', 'assets', 'cover.png');
await writeFile(out, Buffer.from(data, 'base64'));
console.log(`封面已生成 → ${out}`);
