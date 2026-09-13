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
const CLI = process.env.ZHIHU_CLI || env.ZHIHU_CLI;
if (!CLI) { console.error('.env.local 缺少 ZHIHU_CLI'); process.exit(1); }

const run = (args) => new Promise((resolve, reject) =>
  execFile(CLI, args, { encoding: 'utf8', maxBuffer: 1 << 24 }, (e, stdout, stderr) => {
    if (e) return reject(new Error(`cli ${args.join(' ')}: ${stderr || e.message}`));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('CLI 输出非 JSON: ' + stdout.slice(0, 200))); }
  }));

// 分页守卫照搬 fetch_favorites.mjs（issue #4 同款）：NextOffset 缺失/重复即终止，防接口异常死循环
const followees = {};
const seenOffsets = new Set(['0']);
let offset = '0';
for (;;) {
  const r = await run(['me', 'followees', '--offset', offset, '--limit', '50']);
  if (r.Code !== 0) { console.error('CLI 错误:', JSON.stringify(r).slice(0, 300)); process.exit(1); }
  const items = r.Data?.Items ?? [];
  for (const it of items) followees[it.UrlToken] = { name: it.Fullname, avatar: it.AvatarUrl };
  const paging = r.Data?.Paging;
  if (!paging || paging.IsEnd || items.length === 0) break;
  const next = paging.NextOffset;
  if (next == null || next === '') throw new Error('分页未结束但 NextOffset 缺失，终止防死循环');
  const nextStr = String(next);
  if (seenOffsets.has(nextStr)) throw new Error(`分页 offset 重复 (${nextStr})，疑似接口异常，终止`);
  seenOffsets.add(nextStr);
  offset = nextStr;
}

const out = path.join(root, 'data', 'followees.json');
writeFileSync(out, JSON.stringify({ fetchedAt: Date.now(), count: Object.keys(followees).length, followees }, null, 2));
console.log(`已关注用户 ${Object.keys(followees).length} 位 → ${out}`);
