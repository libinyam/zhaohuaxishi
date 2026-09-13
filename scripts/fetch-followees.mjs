// 拉取当前账号关注列表 → data/followees.json（urlToken → 名字/头像）
// 用法: node scripts/fetch-followees.mjs
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const env = Object.fromEntries(
  readFileSync(path.join(root, '.env.local'), 'utf8')
    .split('\n')
    .filter((l) => l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const CLI = env.ZHIHU_CLI;
if (!CLI) { console.error('.env.local 缺少 ZHIHU_CLI'); process.exit(1); }

const run = (args) => new Promise((resolve, reject) =>
  execFile(CLI, args, { encoding: 'utf8', maxBuffer: 1 << 24 }, (e, stdout) => {
    if (e) return reject(e);
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('CLI 输出非 JSON: ' + stdout.slice(0, 200))); }
  }));

const followees = {};
let offset = 0;
for (;;) {
  const r = await run(['me', 'followees', '--offset', String(offset), '--limit', '50']);
  if (r.Code !== 0) { console.error('CLI 错误:', JSON.stringify(r).slice(0, 300)); process.exit(1); }
  for (const it of r.Data.Items) followees[it.UrlToken] = { name: it.Fullname, avatar: it.AvatarUrl };
  if (r.Data.Paging.IsEnd) break;
  offset = Number(r.Data.Paging.NextOffset);
}

const out = path.join(root, 'data', 'followees.json');
writeFileSync(out, JSON.stringify({ fetchedAt: Date.now(), count: Object.keys(followees).length, followees }, null, 2));
console.log(`已关注用户 ${Object.keys(followees).length} 位 → ${out}`);
