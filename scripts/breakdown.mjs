// 直答拆解：对每条收藏调用知乎直答生成论证结构拆解，落盘缓存
// 铁律：同一收藏永不重复请求（有缓存直接跳过）
// 用法：node scripts/breakdown.mjs [--limit N] [--dry]
import { execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = process.env.ZHIHU_CLI || 'C:\\Users\\李斌\\AppData\\Local\\ZhihuCLI\\current\\zhihu-cli.exe';
const args = process.argv.slice(2);
const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;
const dry = args.includes('--dry');

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

const contentKey = (url) => (url || '').split('?')[0].split('/').pop();

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
  const key = contentKey(item.Url);
  const cacheFile = path.join(cacheDir, `${key}.json`);
  try {
    await readFile(cacheFile, 'utf8');
    skipped++;
    continue;
  } catch { /* 无缓存，继续 */ }

  const query = buildQuery(item);
  if (dry) { console.log(`[dry] ${key} ${query.slice(0, 50)}...`); done++; continue; }

  console.log(`[${done + 1}] 拆解 ${key} 「${(item.Title || '').slice(0, 25)}」`);
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
