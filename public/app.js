// 朝花夕拾前端逻辑
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DIFF = { easy: ['简单', 'badge-easy'], medium: ['中等', 'badge-medium'], hard: ['困难', 'badge-hard'] };

// ---------- 网络与状态兜底（issue #21） ----------
async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const SKELETON = `
  <div class="card-paper p-5 mb-4 animate-pulse">
    <div class="h-4 bg-stone-200 rounded w-1/2 mb-3"></div>
    <div class="h-3 bg-stone-200 rounded w-full mb-2"></div>
    <div class="h-3 bg-stone-200 rounded w-5/6 mb-2"></div>
    <div class="h-3 bg-stone-200 rounded w-2/3"></div>
  </div>`.repeat(2);

function showError(el, retryFn) {
  el.innerHTML = `
    <div class="card-paper p-6 text-center fade-in">
      <div class="text-3xl mb-2">🥀</div>
      <p class="text-stone-500 text-sm mb-1">网络开小差了，加载失败。</p>
      <p class="text-stone-400 text-xs mb-3">演示断网环节属预期——恢复网络后点重试。</p>
      <button class="retry-btn px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700">重试</button>
    </div>`;
  el.querySelector('.retry-btn').addEventListener('click', retryFn);
}

// 今日已拾进度（本机存储，按日重置；issue #19）
const doneStore = {
  key: 'zhsx-done',
  today() { return new Date().toLocaleDateString('sv-SE'); },
  read() {
    try {
      const d = JSON.parse(localStorage.getItem(this.key));
      return d?.date === this.today() && Array.isArray(d.ids) ? d.ids : [];
    } catch { return []; }
  },
  add(id) {
    try {
      const ids = this.read();
      if (!ids.includes(id)) ids.push(id);
      localStorage.setItem(this.key, JSON.stringify({ date: this.today(), ids }));
    } catch { /* 微信 WebView 等环境下 localStorage 不可用时静默降级 */ }
  },
};

// ---------- 卡片渲染 ----------
function cardHtml(c, { reviewable = false } = {}) {
  const [diffText, diffCls] = DIFF[c.difficulty] || DIFF.medium;
  const thread = (c.thread || []).map((s, i) => `
    <div class="thread-step mb-2" data-n="${i + 1}">
      <span class="font-semibold text-stone-700">${esc(s.step)}</span>
      <span class="text-stone-600"> — ${esc(s.detail)}</span>
    </div>`).join('');
  const points = (c.points || []).map((p) => `<li class="ml-4 list-disc text-stone-600">${esc(p)}</li>`).join('');
  const tags = (c.topicTags || []).map((t) => `<span class="badge bg-stone-100 text-stone-500">${esc(t)}</span>`).join(' ');
  const favDate = c.source?.favTime ? new Date(c.source.favTime * 1000).toLocaleDateString('sv-SE') : '';

  return `
  <article class="card-paper p-5 mb-4 fade-in" data-card-id="${esc(c.id)}">
    <div class="flex items-start justify-between gap-2 mb-2">
      <h3 class="font-bold leading-snug">
        <a class="hover:text-amber-700" href="${esc(c.source?.url)}" target="_blank" rel="noopener">${esc(c.source?.title)}</a>
      </h3>
      <span class="badge ${diffCls} shrink-0">${diffText}</span>
    </div>
    <div class="mb-3">
      <span class="badge badge-source" title="AI 拆解综合了该问题下多篇高赞回答，不局限于你收藏的这条；点击标题链接阅读你收藏的原回答">拆解自该问题下的优质讨论</span>
      ${c.reviewScore != null ? `<span class="badge bg-emerald-50 text-emerald-700">盲审 ${c.reviewScore}/5</span>` : ''}
    </div>
    <p class="text-stone-800 font-medium mb-3">${esc(c.coreView)}</p>
    ${c.keyInsight ? `<div class="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 text-sm text-stone-700"><span class="font-semibold text-amber-800">关键洞察：</span>${esc(c.keyInsight)}</div>` : ''}
    <div class="mb-3">${thread}</div>
    <ul class="mb-3 text-sm space-y-1">${points}</ul>
    <blockquote class="border-l-4 border-amber-400 pl-3 text-stone-500 italic text-sm mb-3">「${esc(c.quote)}」</blockquote>
    <div class="flex items-center justify-between text-xs text-stone-400">
      <div class="space-x-1">${tags}</div>
      <div>收藏于 ${favDate}${c.source?.authorName ? ' · 作者 ' + esc(c.source.authorName) : ''}</div>
    </div>
    ${reviewable ? `<button class="review-btn mt-3 w-full py-3 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 transition" data-id="${esc(c.id)}">已消化 ✓（复习 ${(c.reviewCount ?? 0) + 1}/3）</button>` : ''}
  </article>`;
}

function renderMath(el) {
  if (window.renderMathInElement) {
    renderMathInElement(el, { delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ], throwOnError: false });
  }
}

// ---------- Tab: 今日复习 ----------
async function renderToday() {
  const el = $('#tab-today');
  el.innerHTML = SKELETON;
  let q;
  try {
    q = await fetchJson('/api/queue');
  } catch {
    return showError(el, renderToday);
  }
  const stat = q.stats;
  const doneIds = doneStore.read();
  const target = q.today.length;
  el.innerHTML = `
    <div class="card-paper p-4 mb-4">
      <div class="flex items-center justify-between">
        <div>
          <div class="font-bold">今天消化 <span class="text-amber-700">${target}</span> 张</div>
          <div class="text-xs text-stone-500">72h 新收藏 ${stat.fresh} · 到期复习 ${stat.due} · 库存 ${stat.approved} 张过审卡</div>
        </div>
        <div class="text-2xl">🌅</div>
      </div>
      ${target ? `
      <div class="mt-3">
        <div class="bar-track"><div class="bar-fill" id="today-progress" style="width:0%"></div></div>
        <div class="text-xs text-stone-500 mt-1" id="today-progress-text"></div>
      </div>` : ''}
    </div>
    <div id="celebrate-slot"></div>
    ${q.today.length ? q.today.map((c) => cardHtml(c, { reviewable: true })).join('') : '<p class="text-stone-400 text-sm">今日队列为空</p>'}
    ${q.upNext.length ? `<h3 class="text-sm font-semibold text-stone-500 mt-6 mb-2">接下来</h3>` + q.upNext.map((c) => `<div class="card-paper px-4 py-2 mb-2 text-sm flex justify-between"><span class="truncate">${esc(c.source?.title)}</span><span class="text-stone-400 shrink-0 ml-2">${(DIFF[c.difficulty] || [])[0] || ''}</span></div>`).join('') : ''}`;

  // 进度与庆祝（issue #19）
  const updateProgress = () => {
    const done = q.today.filter((c) => doneStore.read().includes(c.id)).length;
    const barEl = $('#today-progress');
    const textEl = $('#today-progress-text');
    if (barEl) barEl.style.width = `${target ? Math.round((done / target) * 100) : 0}%`;
    if (textEl) textEl.textContent = `今日已拾 ${done}/${target}`;
    if (target > 0 && done >= target && !$('#celebrate-banner')) {
      $('#celebrate-slot').innerHTML = `
        <div class="card-paper p-6 mb-4 text-center fade-in" id="celebrate-banner">
          <div class="text-4xl mb-2 celebrate-flower">🌸</div>
          <div class="font-bold text-amber-700">今日的花已拾完</div>
          <p class="text-sm text-stone-500 mt-1">明早 8 点，新花到——微信见。</p>
        </div>`;
    }
  };
  updateProgress();

  // 已拾卡片刷新后保持置灰
  el.querySelectorAll('article[data-card-id]').forEach((art) => {
    if (!doneIds.includes(art.dataset.cardId)) return;
    art.style.opacity = '.35';
    const btn = art.querySelector('.review-btn');
    if (btn) { btn.disabled = true; btn.textContent = '今日已拾 ✓'; }
  });

  el.querySelectorAll('.review-btn').forEach((btn) => btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '记录中…';
    try {
      const r = await fetchJson('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: btn.dataset.id }) });
      if (!r.ok) throw new Error(r.error || 'review failed');
      doneStore.add(btn.dataset.id);
      const art = btn.closest('article');
      art.style.transition = 'opacity .4s';
      art.style.opacity = '.35';
      btn.textContent = r.card.status === 'digested' ? '🎉 已完全消化' : `已记录，${Math.round((r.card.nextReviewAt - Date.now() / 1000) / 86400)} 天后再见`;
      updateProgress();
    } catch {
      btn.disabled = false;
      btn.textContent = '记录失败，点击重试';
    }
  }));
  renderMath(el);
}

// ---------- Tab: 考古报告 ----------
const PERSONA_ICON = { '冬眠型': '💤', '爆发型囤积者': '🌋', '松鼠型': '🐿️', '三分钟热度型': '🔥' };

function bar(label, value, max) {
  return `<div class="bar-row"><span class="w-16 text-stone-500 shrink-0">${label}</span><div class="bar-track"><div class="bar-fill" style="width:${max ? Math.round((value / max) * 100) : 0}%"></div></div><span class="w-8 text-right text-stone-600 shrink-0">${value}</span></div>`;
}

async function renderReport() {
  const el = $('#tab-report');
  el.innerHTML = SKELETON;
  let r;
  try {
    r = await fetchJson('/api/report');
  } catch {
    return showError(el, renderReport);
  }
  const bucketMax = Math.max(...Object.values(r.decayBuckets));
  const typeName = { answer: '回答', article: '文章', pin: '想法', question: '问题', zvideo: '视频' };
  const monthlyMax = Math.max(...Object.values(r.monthly || {}));
  el.innerHTML = `
    <div class="card-paper persona-hero p-8 mb-4 text-center fade-in">
      <div class="text-5xl mb-3">${PERSONA_ICON[r.persona.type] || '🌼'}</div>
      <div class="text-xs text-stone-400 mb-1 tracking-widest">你的收藏人格</div>
      <div class="text-4xl font-bold text-amber-700 mb-3">${esc(r.persona.type)}</div>
      <p class="text-sm text-stone-600 max-w-md mx-auto">${esc(r.persona.description)}</p>
    </div>
    <div class="grid grid-cols-3 gap-3 mb-4">
      <div class="card-paper p-4 text-center"><div class="text-2xl font-bold">${r.total}</div><div class="text-xs text-stone-500">收藏总数</div></div>
      <div class="card-paper p-4 text-center"><div class="text-2xl font-bold">${Math.round(r.spanDays / 365)}<span class="text-sm">年</span></div><div class="text-xs text-stone-500">收藏跨度</div></div>
      <div class="card-paper p-4 text-center"><div class="text-2xl font-bold">${r.newestItem.daysAgo}<span class="text-sm">天</span></div><div class="text-xs text-stone-500">距上次收藏</div></div>
    </div>
    ${r.digestion ? `
    <div class="card-paper p-5 mb-4 text-center">
      <h3 class="font-bold mb-2 text-sm">🍽 收藏 vs 消化</h3>
      <div class="text-3xl font-bold text-amber-700">${Math.round(r.digestion.ratio * 100)}%</div>
      <p class="text-sm text-stone-600 mt-1">收藏 ${r.digestion.collected} 条 · ${r.digestion.approved} 张卡片过审——每 10 条收藏约 ${Math.round(r.digestion.ratio * 10)} 条被真正消化</p>
    </div>` : ''}
    <div class="card-paper p-5 mb-4">
      <h3 class="font-bold mb-3 text-sm">🕰 收藏年代分布（按收藏时间）</h3>
      <div class="space-y-2">${Object.entries(r.decayBuckets).map(([k, v]) => bar(k, v, bucketMax)).join('')}</div>
      <p class="text-xs text-stone-400 mt-3">「1 年以上」那 ${r.decayBuckets['1年以上']} 条，大概率已经凉透了——这就是「72 小时保质期」的反面。</p>
    </div>
    ${r.cards?.domainDist?.length ? `
    <div class="card-paper p-5 mb-4">
      <h3 class="font-bold mb-3 text-sm">🧭 领域分布</h3>
      <div class="space-y-2">${r.cards.domainDist.map((d) => bar(d.domain, d.count, r.cards.domainDist[0].count)).join('')}</div>
      <div class="flex gap-1 flex-wrap mt-3">${(r.cards.topTags || []).map((t) => `<span class="badge bg-stone-100 text-stone-500">${esc(t.tag)} ${t.count}</span>`).join('')}</div>
    </div>` : ''}
    ${r.monthly && monthlyMax ? `
    <div class="card-paper p-5 mb-4">
      <h3 class="font-bold mb-3 text-sm">📈 收藏月度曲线</h3>
      <div class="space-y-1">${Object.entries(r.monthly).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => bar(m, v, monthlyMax)).join('')}</div>
    </div>` : ''}
    <div class="card-paper p-5 mb-4">
      <h3 class="font-bold mb-2 text-sm">🏺 最老的一条收藏</h3>
      <a class="text-amber-700 hover:underline text-sm" href="${esc(r.oldestItem.url)}" target="_blank" rel="noopener">${esc(r.oldestItem.title)}</a>
      <div class="text-xs text-stone-400 mt-1">收藏于 ${r.oldestItem.favDate}，已经躺了 ${Math.round(r.oldestItem.ageDays / 365)} 年</div>
      <h3 class="font-bold mt-4 mb-2 text-sm">🔥 爆发期</h3>
      <div class="text-sm text-stone-600">${r.burstMonth.month} 月，一口气收藏了 ${r.burstMonth.count} 条</div>
    </div>
    <div class="card-paper p-5 mb-4">
      <h3 class="font-bold mb-2 text-sm">👤 你最常收藏的作者</h3>
      ${r.topAuthors.map((a) => `<div class="flex justify-between text-sm py-1"><span>${esc(a.name)}</span><span class="text-stone-400">${a.count} 条</span></div>`).join('')}
    </div>
    <div class="card-paper p-5 mb-4">
      <h3 class="font-bold mb-2 text-sm">📦 内容类型</h3>
      <div class="flex gap-2 flex-wrap">${Object.entries(r.typeDist).map(([k, v]) => `<span class="badge bg-stone-100 text-stone-600">${typeName[k] || k} ${v}</span>`).join('')}</div>
    </div>`;
}

// ---------- Tab: 全部卡片 ----------
async function renderCards() {
  const el = $('#tab-cards');
  el.innerHTML = SKELETON;
  let data;
  try {
    data = await fetchJson('/api/cards?status=approved');
  } catch {
    return showError(el, renderCards);
  }
  el.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <div class="text-sm text-stone-500">${data.total} 张过审卡片（按盲审分数排序）</div>
      <select id="diff-filter" class="text-sm border border-stone-300 rounded-lg px-2 py-1 bg-white">
        <option value="">全部难度</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option>
      </select>
    </div>
    <div id="cards-list">${data.cards.map((c) => cardHtml(c)).join('')}</div>`;
  renderMath(el);
  $('#diff-filter').addEventListener('change', (e) => {
    const d = e.target.value;
    document.querySelectorAll('#cards-list article').forEach((art) => {
      const badge = art.querySelector('.badge-hard, .badge-medium, .badge-easy');
      const cls = { easy: 'badge-easy', medium: 'badge-medium', hard: 'badge-hard' }[d];
      art.style.display = !d || (badge && badge.classList.contains(cls)) ? '' : 'none';
    });
  });
}

// ---------- 路由 ----------
const VIEWS = { today: renderToday, report: renderReport, cards: renderCards };
let currentTab = null;

function activateTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  for (const key of Object.keys(VIEWS)) $(`#tab-${key}`).classList.toggle('hidden', key !== name);
}

function switchTab(name) {
  if (currentTab === name) return;
  currentTab = name;
  activateTab(name);
  if (location.hash !== `#${name}`) location.hash = name;
  return VIEWS[name]();
}

// 推送链接落点（issue #17）：#card_<id> 直达「全部卡片」并定位高亮
async function openCard(id) {
  currentTab = 'cards';
  activateTab('cards');
  await renderCards();
  let art = document.querySelector(`article[data-card-id="${CSS.escape(id)}"]`);
  if (!art) {
    // 卡片可能不在过审列表，拉全量找到后单独置顶渲染
    try {
      const data = await fetchJson('/api/cards');
      const c = data.cards.find((x) => x.id === id);
      if (c) {
        $('#cards-list').insertAdjacentHTML('afterbegin', cardHtml(c));
        renderMath($('#cards-list').firstElementChild);
        art = document.querySelector(`article[data-card-id="${CSS.escape(id)}"]`);
      }
    } catch { /* 下面统一提示 */ }
  }
  if (art) {
    art.scrollIntoView({ behavior: 'smooth', block: 'center' });
    art.classList.add('highlight');
    setTimeout(() => art.classList.remove('highlight'), 2600);
  } else {
    $('#cards-list')?.insertAdjacentHTML('afterbegin',
      `<div class="card-paper p-4 mb-3 text-sm text-stone-500">没有找到卡片 ${esc(id)}（可能未过审或已移除），去「今日复习」看看今天的队列吧。</div>`);
  }
}

function route() {
  const h = location.hash.slice(1);
  if (h.startsWith('card_')) { openCard(h); return; }
  switchTab(h in VIEWS ? h : 'today');
}

document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.tab; }));
window.addEventListener('hashchange', route);
route();
