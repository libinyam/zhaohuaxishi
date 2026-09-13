// Use textContent for API content; only application-owned card routes become links.

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function relDay(ts) {
  if (!ts) return '';
  const d = Math.floor((Date.now() / 1000 - ts) / 86400);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 30) return `${d} 天前`;
  if (d < 365) return `${Math.floor(d / 30)} 个月前`;
  return `${Math.floor(d / 365)} 年前`;
}

function validCards(cards) {
  return (Array.isArray(cards) ? cards : []).filter(
    (c) => c.status === 'approved' && /^card_[a-zA-Z0-9_]+$/.test(c.id || '')
  );
}

async function fetchApprovedCards() {
  const response = await fetch('/api/cards?status=approved', { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Cards: ${response.status}`);
  const data = await response.json();
  return validCards(data.cards);
}

// ---------- 卡片墙：最近收藏优先，关注作者标注，话题去重 ----------
function selectHomepageCards(cards) {
  const sorted = [...cards].sort((a, b) =>
    ((b.source?.authorFollowed ? 1 : 0) - (a.source?.authorFollowed ? 1 : 0)) ||
    ((b.source?.favTime || 0) - (a.source?.favTime || 0)));
  const recent = [...cards].sort((a, b) => (b.source?.favTime || 0) - (a.source?.favTime || 0));
  const picked = [];
  const seenTopics = new Set();
  for (const c of recent) {
    if (picked.length >= 6) break;
    const topic = c.topicTags?.[0] || '发现';
    if (seenTopics.has(topic)) continue;
    seenTopics.add(topic);
    picked.push(c);
  }
  for (const c of sorted) {
    if (picked.length >= 6) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked;
}

function createCardPreview(card) {
  const link = el('a', 'wall-card');
  link.href = `/app.html#${encodeURIComponent(card.id)}`;
  const meta = el('div', 'wall-card-meta');
  const author = card.source?.authorName;
  meta.append(
    el('span', null, card.source?.authorFollowed && author ? `关注作者 · ${author}` : (author ? `作者 · ${author}` : '来自真实收藏')),
    el('span', null, '盲审通过 ✓')
  );
  const title = el('h3', null, card.source?.title || '一张值得重读的卡片');
  const core = el('p', null, card.coreView || '打开卡片，看看完整的讲解脉络。');
  const footer = el('div', 'wall-card-footer');
  const tags = (card.topicTags || []).slice(0, 2).map((t) => `#${t}`).join('  ');
  footer.textContent = [tags, card.source?.favTime ? `${relDay(card.source.favTime)}收藏` : ''].filter(Boolean).join('  ·  ') || '展开阅读全文 ↗';
  link.append(meta, title, core, footer);
  return link;
}

async function loadHomepageCards(cards) {
  const status = document.getElementById('wall-status');
  const selected = selectHomepageCards(cards);
  document.getElementById('card-wall').replaceChildren(...selected.map(createCardPreview));
  status.hidden = selected.length > 0;
  if (!selected.length) status.textContent = '暂时没有可展示的卡片，可以先进入工作台看看。';
}

// ---------- 阅读小清单：最近 3 条真实收藏 ----------
function renderReadingList(cards) {
  const box = document.getElementById('reading-list');
  if (!box) return;
  const recent = [...cards]
    .filter((c) => c.source?.favTime)
    .sort((a, b) => b.source.favTime - a.source.favTime)
    .slice(0, 3);
  if (!recent.length) return;
  box.replaceChildren(...recent.map((c) => {
    const days = Math.floor((Date.now() / 1000 - c.source.favTime) / 86400);
    const item = el(days > 7 ? 'div' : 'a', 'collection-item' + (days > 7 ? ' muted' : ''));
    if (days <= 7) item.href = `/app.html#${encodeURIComponent(c.id)}`;
    const body = el('div');
    body.append(
      el('strong', null, c.source?.title || '一条收藏'),
      el('small', null, [relDay(c.source.favTime) + '收藏', c.source?.authorName].filter(Boolean).join(' · '))
    );
    item.append(el('span', 'collection-icon', '知'), body);
    if (days <= 3) item.append(el('span', 'tag', '趁热读'));
    else if (days <= 7) item.append(el('span', 'tag', '待拾起'));
    return item;
  }));
}

// ---------- 卡片收获脉络：真实卡片的讲解脉络 ----------
function renderOutline(cards) {
  const box = document.getElementById('outline-list');
  if (!box) return;
  const featured = [...cards]
    .filter((c) => (c.thread || []).length >= 3)
    .sort((a, b) => (b.source?.favTime || 0) - (a.source?.favTime || 0))[0];
  if (!featured) return;
  box.replaceChildren(...featured.thread.slice(0, 3).map((s, i) => {
    const line = el('div', 'outline-line');
    const body = el('div');
    body.append(el('strong', null, s.step || ''), el('p', null, s.detail || ''));
    line.append(el('span', null, String(i + 1).padStart(2, '0')), body);
    return line;
  }));
  const caption = document.querySelector('.outline-visual .visual-caption span');
  if (caption && featured.source?.title) caption.textContent = `真实卡片 · ${featured.source.title.slice(0, 18)}${featured.source.title.length > 18 ? '…' : ''}`;
}

// ---------- 微信推送：今日真实队列 ----------
async function renderPushList() {
  const box = document.getElementById('push-list');
  if (!box) return;
  try {
    const response = await fetch('/api/queue', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Queue: ${response.status}`);
    const data = await response.json();
    const today = Array.isArray(data.today) ? data.today : [];
    if (!today.length) throw new Error('Empty queue');
    box.replaceChildren(...today.slice(0, 3).map((c, i) =>
      el('span', 'push-line', `${i + 1}. 《${c.source?.title || '一张卡片'}》`)
    ));
  } catch { /* 队列不可用时保留静态文案兜底 */ }
}

async function boot() {
  const status = document.getElementById('wall-status');
  try {
    const cards = await fetchApprovedCards();
    loadHomepageCards(cards);
    renderReadingList(cards);
    renderOutline(cards);
  } catch {
    if (status) {
      status.hidden = false;
      status.textContent = '卡片暂时没能加载，请刷新重试，或直接进入工作台。';
    }
  }
  renderPushList();
}

boot();
