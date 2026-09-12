// 拉取全量收藏：favlists -> 逐收藏夹 favlist_contents 分页 -> data/favorites.json
// 走 user_data 接口（每日 10000 次），不消耗直答额度
import { execFile } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = process.env.ZHIHU_CLI;
if (!CLI) {
  console.error('缺少 ZHIHU_CLI 环境变量，请指向 zhihu-cli 可执行文件\n  例如：export ZHIHU_CLI=/path/to/zhihu-cli（Windows 示例见 README）');
  process.exit(1);
}

function cli(args) {
  return new Promise((resolve, reject) => {
    execFile(CLI, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`cli ${args.join(' ')}: ${stderr || err.message}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`bad json from ${args.join(' ')}: ${stdout.slice(0, 200)}`)); }
    });
  });
}

const listsResp = await cli(['me', 'favorites', 'lists']);
const lists = listsResp?.Data?.Items ?? [];
console.log(`favlists: ${lists.length}`);
await mkdir(path.join(root, 'data'), { recursive: true });

const all = [];
for (const list of lists) {
  let offset = '0';
  const seenOffsets = new Set(['0']);
  for (;;) {
    const resp = await cli(['me', 'favorites', 'items', '--url-token', String(list.UrlToken), '--offset', offset, '--limit', '50']);
    const items = resp?.Data?.Items ?? [];
    console.log(`  ${list.Title}(${list.UrlToken}): +${items.length} (offset=${offset})`);
    all.push(...items);
    const paging = resp?.Data?.Paging;
    if (!paging || paging.IsEnd || items.length === 0) break;
    const next = paging.NextOffset;
    if (typeof next !== 'string' || !next) throw new Error(`${list.Title}: 分页未结束但 NextOffset 缺失，终止防死循环`);
    if (seenOffsets.has(next)) throw new Error(`${list.Title}: 分页 offset 重复 (${next})，疑似接口异常，终止`);
    seenOffsets.add(next);
    offset = next;
  }
}

// 去重键：规范化 URL 剥 query
const seen = new Map();
for (const item of all) {
  const key = (item.Url || '').split('?')[0];
  if (!seen.has(key)) seen.set(key, item);
}
const deduped = [...seen.values()];

await writeFile(path.join(root, 'data', 'favorites.json'), JSON.stringify({ fetchedAt: Date.now(), total: deduped.length, items: deduped }, null, 2));
console.log(`total fetched: ${all.length}, deduped: ${deduped.length} -> data/favorites.json`);
