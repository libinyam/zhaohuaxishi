// 用 gpt-image-2 生成朝花夕拾品牌 logo → public/assets/logo-flower.png
// 用法: node --env-file=.env.local scripts/make_logo.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.GEMINI_BASE_URL;
const KEY = process.env.GEMINI_API_KEY;
if (!BASE || !KEY) { console.error('缺少 GEMINI_BASE_URL / GEMINI_API_KEY'); process.exit(1); }

// 朝花夕拾：单朵金色小花，旁边一瓣刚被拾起的落瓣；透明底，不带任何背景框
const PROMPT = `Minimalist flat vector-style illustration of a single small five-petal flower:
rounded petals in warm golden yellow (#F6C344) with subtle pale-yellow (#FFF2AC) inner glow near the center,
a warm amber (#E89B0C) circular center. One single tiny petal detached beside the flower at lower right,
slightly tilted, as if just picked off. Isolated subject on transparent background, no box, no badge,
flat design, crisp edges, no text, no shadow, no outline, no stem.`;

const resp = await fetch(`${BASE}/images/generations`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'gpt-image-2', prompt: PROMPT, size: '1024x1024', n: 1, background: 'transparent' }),
});
if (!resp.ok) { console.error(`http ${resp.status}: ${(await resp.text()).slice(0, 300)}`); process.exit(1); }
const data = (await resp.json()).data?.[0]?.b64_json;
if (!data) { console.error('响应里没有 b64_json'); process.exit(1); }

const out = path.join(root, 'public', 'assets', 'logo-flower.png');
await writeFile(out, Buffer.from(data, 'base64'));
console.log(`logo 已生成 → ${out}`);
