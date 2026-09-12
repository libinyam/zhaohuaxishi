// 朝花夕拾 Web 服务：静态页面 + 卡片/报告/复习队列 API
// vanilla Node，无构建步骤
import http from 'node:http';
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4173;
const DAY = 86400;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

async function loadCards() {
  const dir = path.join(root, 'data', 'cache', 'cards');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  const cards = [];
  for (const f of files) {
    try { cards.push(JSON.parse(await readFile(path.join(dir, f), 'utf8'))); } catch { /* skip */ }
  }
  return cards;
}

// 复习队列：72h 新收藏 > 到期复习 > 老收藏补位，每日 min(3, 到期数)
function buildQueue(cards) {
  const now = Math.floor(Date.now() / 1000);
  const approved = cards.filter((c) => c.status === 'approved');
  const fresh = approved.filter((c) => now - (c.source?.favTime ?? 0) <= 3 * DAY)
    .sort((a, b) => b.source.favTime - a.source.favTime);
  const due = approved.filter((c) => now - (c.source?.favTime ?? 0) > 3 * DAY && (c.nextReviewAt ?? 0) <= now)
    .sort((a, b) => (a.nextReviewAt ?? 0) - (b.nextReviewAt ?? 0));
  const backlog = approved.filter((c) => !fresh.includes(c) && !due.includes(c))
    .sort((a, b) => (b.source?.favTime ?? 0) - (a.source?.favTime ?? 0));
  const queue = [...fresh, ...due, ...backlog];
  return { today: queue.slice(0, 3), upNext: queue.slice(3, 9), stats: { approved: approved.length, fresh: fresh.length, due: due.length } };
}

const INTERVALS = [1 * DAY, 3 * DAY, 7 * DAY]; // 复习间隔：+1/+3/+7 天后 digested

async function markReviewed(id) {
  const file = path.join(root, 'data', 'cache', 'cards', `${id}.json`);
  const card = JSON.parse(await readFile(file, 'utf8'));
  card.reviewCount = (card.reviewCount ?? 0) + 1;
  const now = Math.floor(Date.now() / 1000);
  if (card.reviewCount >= 3) {
    card.status = 'digested';
    card.nextReviewAt = null;
  } else {
    card.nextReviewAt = now + INTERVALS[card.reviewCount - 1];
  }
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(card, null, 2));
  await rename(tmp, file);
  return card;
}

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/health') return json(res, { ok: true, project: 'zhaohuaxishi' });
    if (url.pathname === '/api/report') {
      const report = JSON.parse(await readFile(path.join(root, 'data', 'report.json'), 'utf8'));
      return json(res, report);
    }
    if (url.pathname === '/api/cards') {
      const cards = await loadCards();
      const status = url.searchParams.get('status');
      const filtered = status ? cards.filter((c) => c.status === status) : cards;
      filtered.sort((a, b) => (b.reviewScore ?? 0) - (a.reviewScore ?? 0));
      return json(res, { total: filtered.length, cards: filtered });
    }
    if (url.pathname === '/api/queue') {
      return json(res, buildQueue(await loadCards()));
    }
    if (url.pathname === '/api/review' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || '{}');
      if (!id) return json(res, { ok: false, error: 'missing id' }, 400);
      return json(res, { ok: true, card: await markReviewed(id) });
    }
    // 静态文件
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(root, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!file.startsWith(path.join(root, 'public'))) return json(res, { error: 'forbidden' }, 403);
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') return json(res, { error: 'not found' }, 404);
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => console.log(`朝花夕拾 → http://127.0.0.1:${PORT}/`));
