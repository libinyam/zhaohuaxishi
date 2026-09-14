// 直答拆解：对每条收藏调用知乎直答生成论证结构拆解，落盘缓存
// 铁律：同一收藏永不重复请求（有缓存直接跳过）
// 用法：node scripts/breakdown.mjs [--limit N] [--dry] [--quota]
import { execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cstDateStr } from '../lib/time.mjs';
import { runtimeDir } from '../lib/runtime.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const dry = args.includes('--dry');

// 每日额度台账：直答 100 次/天，达到阈值即拒绝，防重炼循环等叠加烧穿
// 切日口径与 lib/ask.mjs 一致（UTC+8，见 lib/time.mjs），两边共用同一台账文件
const DAILY_LIMIT = 100;
const QUOTA_THRESHOLD = 90;
const quotaDir = path.join(runtimeDir(root), 'quota');
const quotaFile = path.join(quotaDir, `${cstDateStr()}.json`);

async function readQuota() {
  try { return JSON.parse(await readFile(quotaFile, 'utf8')); } catch { return { date: cstDateStr(), count: 0 }; }
}
async function bumpQuota() {
  const q = await readQuota();
  q.count++;
  q.updatedAt = Date.now();
  await mkdir(quotaDir, { recursive: true });
  await writeFile(quotaFile, JSON.stringify(q, null, 2));
  return q.count;
}

if (args.includes('--quota')) {
  const q = await readQuota();
  console.log(`今日直答额度：已用 ${q.count}/${DAILY_LIMIT}，剩余 ${DAILY_LIMIT - q.count}（阈值 ${QUOTA_THRESHOLD} 触发拒绝）`);
  process.exit(0);
}

// --quota 只读本地台账不需要 CLI；真正要发请求才检查
const CLI = process.env.ZHIHU_CLI;
if (!CLI) {
  console.error('缺少 ZHIHU_CLI 环境变量，请指向 zhihu-cli 可执行文件\n  例如：export ZHIHU_CLI=/path/to/zhihu-cli（Windows 示例见 README）');
  process.exit(1);
}

function cli(cliArgs) {
  return new Promise((resolve, reject) => {
    execFile(CLI, cliArgs, { maxBuffer: 16 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${stderr || err.message}`));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`bad json: ${stdout.slice(0, 200)}`)); }
    });
  });
}

async function cliWithRetry(cliArgs, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try { return await cli(cliArgs); } catch (e) {
      lastErr = e;
      const waitMs = (attempt + 1) * 15000;
      console.log(`    retry ${attempt + 1}/${retries} in ${waitMs / 1000}s (${e.message.slice(0, 60)})`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// key 前缀 ContentType，防止 answer/question/专栏末段 ID 跨类型碰撞；旧缓存（无前缀）仍识别
const legacyKey = (url) => (url || '').split('?')[0].split('/').pop();
const contentKey = (item) => `${item.ContentType}_${legacyKey(item.Url)}`;

function buildQuery(item) {
  if (item.ContentType === 'answer') {
    return `知乎上「${item.Title}」这个问题下的高赞回答，核心观点是什么？请拆解它的内容框架和论证结构。`;
  }
  return `知乎专栏文章《${item.Title}》的核心观点是什么？请拆解它的内容框架和论证结构，并总结作者的主要论据。`;
}

const data = JSON.parse(await readFile(path.join(root, 'data', 'favorites.json'), 'utf8'));
const cacheDir = path.join(root, 'data', 'cache', 'zhida');
await mkdir(cacheDir, { recursive: true });

const targets = data.items.filter((i) => i.ContentType !== 'pin'); // pin 无实质内容
let done = 0, skipped = 0, failed = 0;

for (const item of targets) {
  if (done >= limit) break;
  const key = contentKey(item);
  const cacheFile = path.join(cacheDir, `${key}.json`);
  try {
    await readFile(cacheFile, 'utf8');
    skipped++;
    continue;
  } catch { /* 无缓存，继续 */ }
  const legacy = legacyKey(item.Url);
  try {
    await readFile(path.join(cacheDir, `${legacy}.json`), 'utf8');
    skipped++;
    continue;
  } catch { /* 旧命名缓存也没有 */ }

  const query = buildQuery(item);
  if (dry) { console.log(`[dry] ${key} ${query.slice(0, 50)}...`); done++; continue; }

  const quota = await readQuota();
  if (quota.count >= QUOTA_THRESHOLD) {
    console.error(`直答额度已达今日阈值（${quota.count}/${DAILY_LIMIT}，阈值 ${QUOTA_THRESHOLD}），拒绝继续请求。剩余额度留给人工确认，明天台账自动重置。`);
    break;
  }

  console.log(`[${done + 1}] 拆解 ${key} 「${(item.Title || '').slice(0, 25)}」（今日第 ${quota.count + 1} 次）`);
  await bumpQuota(); // 单一计数点：本条即将发请求，无论成败计 1 次，重试不单独计
  try {
    const resp = await cliWithRetry(['answer', '--query', query, '--model', 'zhida-thinking-1p5']);
    const content = resp?.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty content');
    const tmp = cacheFile + '.tmp';
    await writeFile(tmp, JSON.stringify({ key, url: item.Url, title: item.Title, query, model: resp.model, content, fetchedAt: Date.now() }, null, 2));
    await rename(tmp, cacheFile);
    done++;
    console.log(`    ok (${content.length} chars)`);
    await new Promise((r) => setTimeout(r, 3000)); // 温和节奏，避免触发频率限制
  } catch (e) {
    failed++;
    console.error(`    FAIL: ${e.message.slice(0, 120)}`);
  }
}
console.log(`done=${done} cached-skip=${skipped} failed=${failed}`);
