// 朝花夕拾前端逻辑（esc / categorizeCard 在 shared.js，需先加载）
const $ = (sel) => document.querySelector(sel);

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
      <button class="retry-btn btn-ink px-4 py-2 text-sm">重试</button>
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
function cardHtml(c, { reviewable = false, isDone = false, sourceBadge = '知乎拆解' } = {}) {
  const [diffText, diffCls] = DIFF[c.difficulty] || DIFF.medium;
  const cleanId = String(c.id || '').replace(/^card_/, '');
  const displayId = cleanId ? `NO. ${cleanId.slice(-6)}` : 'SPECIMEN';

  const thread = (c.thread || []).map((s, i) => `
    <div class="thread-step" data-n="${i + 1}">
      <div class="step-name">${esc(s.step)}</div>
      <div class="step-detail">${esc(s.detail)}</div>
    </div>`).join('');

  const points = (c.points || []).map((p) => `
    <div class="point-item">
      <span class="point-dot"></span>
      <span>${esc(p)}</span>
    </div>`).join('');

  const tags = (c.topicTags || []).map((t) => `<span class="badge badge-tag">${esc(t)}</span>`).join(' ');
  const favDate = c.source?.favTime ? new Date(c.source.favTime * 1000).toLocaleDateString('sv-SE') : '';
  const author = c.source?.authorName
    ? `${c.source.authorFollowed && c.source.authorAvatar ? `<img class="author-avatar" src="${esc(c.source.authorAvatar)}" alt="" referrerpolicy="no-referrer">` : ''}<span>作者 · ${esc(c.source.authorName)}</span>${c.source.authorFollowed ? '<span class="badge badge-follow">已关注</span>' : ''}`
    : '';

  return `
  <article class="card-paper p-6 mb-5 fade-in relative" data-card-id="${esc(c.id)}">
    <div class="stamp-slot">
      ${isDone ? `<div class="stamp-seal"><span class="stamp-seal-text">已 拾</span><span class="stamp-seal-sub">朝花夕拾</span></div>` : ''}
    </div>

    <!-- 顶部标本编目条 -->
    <div class="specimen-header">
      <div class="flex items-center gap-2">
        <span class="font-mono text-[11px] font-semibold text-stone-500 tracking-wider">${displayId}</span>
        <span class="badge badge-source" title="AI 拆解综合了该问题下多篇高赞回答，不局限于你收藏的这条；点击标题链接阅读你收藏的原回答">${esc(sourceBadge)}</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge ${diffCls}">${diffText}</span>
        ${c.reviewScore != null ? `<span class="badge badge-score">${c.reviewScore >= 5 ? '盲审通过' : `盲审 ${c.reviewScore}/5`}</span>` : ''}
      </div>
    </div>

    <!-- 标题与出处 -->
    <h3 class="font-serif-display text-2xl md:text-3xl font-bold leading-snug mb-2 text-stone-900">
      <a class="hover-cin transition-colors inline-flex items-start gap-1" href="${esc(c.source?.url)}" target="_blank" rel="noopener">
        <span>${esc(c.source?.title)}</span>
        <span class="text-xs text-cin font-sans mt-1 opacity-75">↗</span>
      </a>
    </h3>

    <div class="flex items-center gap-2 text-xs text-stone-400 mb-4 pb-2 border-b border-stone-100">
      ${author ? `<span>${author}</span><span>·</span>` : ''}
      <span>收藏于 ${favDate}</span>
    </div>

    <!-- 核心立论 -->
    <div class="thesis-box">
      <div class="font-medium leading-relaxed"><span class="thesis-label">核心提炼</span>${esc(c.coreView)}</div>
    </div>

    <!-- 关键洞察 / 公式推导 -->
    ${c.keyInsight ? `
    <div class="insight-box">
      <div class="insight-title">
        <span>✦</span>
        <span>关键洞察</span>
      </div>
      <div class="text-stone-700">${esc(c.keyInsight)}</div>
    </div>` : ''}

    <!-- 讲解脉络 -->
    ${thread ? `<div class="thread-flow">${thread}</div>` : ''}

    <!-- 要点提炼 -->
    ${points ? `<div class="points-list">${points}</div>` : ''}

    <!-- 金句书签 -->
    ${c.quote ? `<div class="quote-ornament">${esc(c.quote)}</div>` : ''}

    <!-- 底部信息与动作 -->
    <div class="flex items-center justify-between text-xs text-stone-400 pt-3 mt-4 border-t border-dashed border-[#eee7d7]">
      <div class="flex flex-wrap gap-1.5">${tags}</div>
      <span class="text-[11px] text-stone-400 shrink-0 ml-2">2 分钟读完</span>
    </div>

    ${reviewable ? `
    <button class="review-btn btn-ink mt-5 w-full py-3 text-sm flex items-center justify-center gap-2" data-id="${esc(c.id)}">
      <span>已消化</span>
      <span class="text-xs opacity-75">（复习 ${(c.reviewCount ?? 0) + 1}/3）</span>
    </button>` : ''}
  </article>`;
}

function renderMath(el) {
  if (!window.renderMathInElement) return;
  // 快速预检：没有 $ 就跳过逐文本节点的正则扫描（108 张卡时开销明显）
  if (!el.textContent.includes('$')) return;
  renderMathInElement(el, { delimiters: [
    { left: '$$', right: '$$', display: true },
    { left: '$', right: '$', display: false },
  ], throwOnError: false });
}

// ---------- 双栏工作台状态管理 (对齐图二) ----------
const appState = {
  tab: 'today',             // 'today' | 'cards' | 'report'
  activeCardId: null,       // id of the card focused in stage
  activeDomain: 'all',      // 'all' | 'math' | 'humanities' | 'growth' | 'tech'
  cardViewMode: 'whiteboard', // 'list' | 'whiteboard'
  queue: null,
  allCards: null,
  report: null,
  oauth: null,              // /api/oauth/status：{ configured, authorized, profile }
  pushSub: null,            // /api/push/subscription：{ subscribed }；null = 未登录或未拉取
  oauthLanding: null,       // 'ok' | 'error'（授权回调着陆提示，展示一次后清除）
  reportSource: 'site',     // 'site' 站主示例 | 'mine' 我的报告（已授权用户固定 'mine'，无站主示例入口）
  myReport: null,
  myReportMeta: null,
  myReportLoading: false,
  myReportError: null,
  myCard: undefined,        // /api/my/card 状态：undefined=未拉取；{status:'idle'|'breaking_down'|'making_card'|'reviewing'|'done'|'failed'|...}
  myCardFetching: false,
  myCardPolling: false,
  scope: 'site',            // 'site' 站主示例 | 'mine' 我的卡册（登录后队列/白板只展示自己的卡片）
};

// ---------- 知乎登录入口 ----------
function renderOAuthSlot() {
  const slot = $('#oauth-slot');
  if (!slot) return;
  const o = appState.oauth;
  if (o?.authorized && o.profile) {
    slot.innerHTML = `
      <div class="flex items-center gap-2">
        ${o.profile.avatarUrl ? `<img src="${esc(o.profile.avatarUrl)}" alt="" referrerpolicy="no-referrer" class="w-6 h-6 rounded-full border border-stone-200">` : ''}
        <span class="text-xs text-stone-700 font-medium max-w-[80px] truncate">${esc(o.profile.name || '知乎用户')}</span>
        <button onclick="window.oauthLogout()" class="text-[11px] text-stone-400 hover:text-stone-700 transition-colors">退出</button>
      </div>`;
  } else if (o?.configured !== false) {
    slot.innerHTML = `
      <a href="/auth/login" class="inline-flex items-center gap-1.5 text-xs bg-[#1f1d1a] text-white rounded-full px-3.5 py-1.5 hover:bg-black transition-colors shadow-sm">
        <span>知乎登录</span>
      </a>`;
  }
}

window.oauthLogout = async function () {
  try { await fetchJson('/api/oauth/logout', { method: 'POST' }); } catch { /* 网络失败也按本地登出处理 */ }
  appState.oauth = null;
  appState.pushSub = null;
  appState.reportSource = 'site';
  appState.scope = 'site';
  appState.myReport = null;
  appState.myReportMeta = null;
  appState.myReportError = null;
  appState.myCard = undefined;
  appState.myCardPolling = false;
  renderOAuthSlot();
  initApp(); // 队列/卡册需切回站主示例数据
};

// categorizeCard 已抽到 shared.js（issue #32，分类正则单一来源）

const SECTIONS = [
  { key: 'math', title: '数理逻辑空间', sub: 'Mathematical Systems', cls: 'wb-section-math', dot: '#5e8248' },
  { key: 'humanities', title: '人文哲思空间', sub: 'Humanities & Mind', cls: 'wb-section-humanities', dot: '#7b4e88' },
  { key: 'growth', title: '认知与成长空间', sub: 'Mental Models & Growth', cls: 'wb-section-growth', dot: '#8c5d2e' },
  { key: 'tech', title: '技术与工程空间', sub: 'Engineering & Code', cls: 'wb-section-tech', dot: '#3a687d' },
  { key: 'other', title: '通识与精选空间', sub: 'General Insights', cls: 'wb-section-other', dot: '#73736f' },
];

function whiteboardHtml(cards) {
  const groups = { math: [], humanities: [], growth: [], tech: [], other: [] };
  cards.forEach((c) => groups[categorizeCard(c)].push(c));

  return `
    <div class="wb-canvas-container fade-in">
      ${SECTIONS.map((sec) => {
        const items = groups[sec.key] || [];
        if (!items.length) return '';
        return `
        <div class="wb-section ${sec.cls}">
          <div class="wb-section-header">
            <div class="wb-section-title">
              <span class="wb-section-dot"></span>
              <span>${sec.title}</span>
              <span class="text-xs font-normal text-stone-400 font-mono">/ ${sec.sub}</span>
            </div>
            <span class="wb-section-count">${items.length} 张便签</span>
          </div>
          <div class="wb-grid">
            ${items.map((c) => `
              <div class="wb-mini-card" data-card-id="${esc(c.id)}" onclick="window.selectSingleCard('${esc(c.id)}')">
                <div>
                  <div class="flex items-center justify-between text-[11px] text-stone-400 mb-2">
                    <span class="font-mono text-stone-600">${(DIFF[c.difficulty] || [])[0] || '中等'}</span>
                    ${c.reviewScore != null ? `<span class="text-emerald-700 font-semibold font-mono">${c.reviewScore >= 5 ? '盲审通过' : `盲审 ${c.reviewScore}/5`}</span>` : ''}
                  </div>
                  <h4 class="wb-mini-title">${esc(c.source?.title)}</h4>
                  <p class="wb-mini-excerpt"><span class="marker-hl font-medium">脉络：</span>${esc(c.coreView)}</p>
                </div>
                <div class="wb-mini-meta">
                  <span class="truncate max-w-[170px] text-stone-400">${(c.topicTags || []).slice(0, 2).map((t) => '#' + esc(t)).join(' ')}</span>
                  <span class="text-stone-900 font-medium hover:underline">精读 ↗</span>
                </div>
              </div>
            `).join('')}
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ---------- 左侧列表边栏渲染 (对齐图二) ----------
function renderSidebar() {
  const sb = $('#app-sidebar');
  if (!sb) return;

  const doneIds = doneStore.read();
  const q = appState.queue;
  const todayCards = q?.today || [];
  const upNextCards = q?.upNext || [];
  const doneCount = todayCards.filter(c => doneIds.includes(c.id)).length;
  const totalCards = appState.allCards?.total ?? 0;

  const domainCounts = { math: 0, humanities: 0, growth: 0, tech: 0, other: 0 };
  (appState.allCards?.cards || []).forEach(c => {
    domainCounts[categorizeCard(c)]++;
  });

  sb.innerHTML = `
    <!-- 用户/状态卡片 -->
    <div class="sidebar-profile">
      <img src="/assets/logo-64.png" alt="朝花夕拾" class="w-8 h-8">
      <div class="min-w-0 flex-1">
        <div class="text-xs font-bold text-stone-900 truncate">拾花人工作台</div>
        <div class="text-[10px] text-stone-400 mt-0.5">趁你的收藏还没凉透</div>
      </div>
      <span class="text-[10px] bg-amber-50 text-amber-800 border border-amber-200/80 px-2 py-0.5 rounded-full font-mono font-medium">72h</span>
    </div>

    <!-- 分组 1：今日复习队列 -->
    <div class="sidebar-group">
      <div class="sidebar-group-title">
        <span>今日复习队列</span>
        <span class="sidebar-badge">${doneCount}/${todayCards.length}</span>
      </div>
      <div class="space-y-0.5">
        ${todayCards.map((c, i) => {
          const isDone = doneIds.includes(c.id);
          const isActive = appState.tab === 'today' && appState.activeCardId === c.id;
          const [diffText] = DIFF[c.difficulty] || DIFF.medium;
          return `
          <button class="sidebar-nav-item ${isActive ? 'active' : ''} ${isDone ? 'is-done' : ''}" onclick="window.selectQueueCard('${esc(c.id)}')">
            <div class="flex items-center gap-2 min-w-0 flex-1 pr-1">
              <span class="text-xs shrink-0 ${isDone ? 'text-emerald-600 font-bold' : isActive ? 'text-cin font-bold' : 'text-stone-400'}">
                ${isDone ? '✓' : (i + 1)}
              </span>
              <span class="truncate text-xs">${esc(c.source?.title)}</span>
            </div>
            <span class="sidebar-badge shrink-0 text-[10px]">${isDone ? '已拾' : diffText}</span>
          </button>`;
        }).join('')}
      </div>
    </div>

    <!-- 分组 2：待复习储备 (Up Next) -->
    ${upNextCards.length ? `
    <div class="sidebar-group">
      <div class="sidebar-group-title">
        <span>到期储备 (Up Next)</span>
        <span class="sidebar-badge">${upNextCards.length}</span>
      </div>
      <div class="space-y-0.5">
        ${upNextCards.slice(0, 4).map((c) => {
          const isActive = appState.tab === 'cards' && appState.activeCardId === c.id;
          const [diffText] = DIFF[c.difficulty] || DIFF.medium;
          return `
          <button class="sidebar-nav-item ${isActive ? 'active' : ''}" onclick="window.selectSingleCard('${esc(c.id)}')">
            <div class="flex items-center gap-2 min-w-0 flex-1 pr-1">
              <span class="w-1.5 h-1.5 rounded-full bg-stone-300 shrink-0"></span>
              <span class="truncate text-xs">${esc(c.source?.title)}</span>
            </div>
            <span class="sidebar-badge shrink-0 text-[10px]">${diffText}</span>
          </button>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- 分组 3/4：知识空间分类与数据洞察（领域分布与收藏画像属站主隐私，仅登录可见；issue #38） -->
    ${appState.oauth?.authorized ? `
    <div class="sidebar-group">
      <div class="sidebar-group-title">
        <span>知识空间分类</span>
        <span class="sidebar-badge">${totalCards}</span>
      </div>
      <div class="space-y-0.5">
        <button class="sidebar-nav-item ${appState.tab === 'cards' && appState.activeDomain === 'all' && !appState.activeCardId ? 'active' : ''}" onclick="window.selectDomain('all')">
          <div class="flex items-center gap-2">
            <span>⊞</span>
            <span class="text-xs">全景白板视界</span>
          </div>
          <span class="sidebar-badge text-[10px]">${totalCards}</span>
        </button>
        ${SECTIONS.map(s => `
        <button class="sidebar-nav-item ${appState.tab === 'cards' && appState.activeDomain === s.key && !appState.activeCardId ? 'active' : ''}" onclick="window.selectDomain('${s.key}')">
          <div class="flex items-center gap-2">
            <span class="sidebar-domain-dot" style="background:${s.dot}"></span>
            <span class="text-xs">${s.title}</span>
          </div>
          <span class="sidebar-badge text-[10px]">${domainCounts[s.key] || 0}</span>
        </button>`).join('')}
      </div>
    </div>

    <div class="sidebar-group">
      <div class="sidebar-group-title">
        <span>数据洞察</span>
      </div>
      <div class="space-y-0.5">
        <button class="sidebar-nav-item ${appState.tab === 'report' ? 'active' : ''}" onclick="window.selectTab('report')">
          <div class="flex items-center gap-2">
            <span class="text-stone-400">✦</span>
            <span class="text-xs">收藏考古报告</span>
          </div>
          <span class="text-[10px] font-mono text-stone-400">${appState.scope === 'mine' ? '我的' : `${appState.report?.total ?? '…'}条`}</span>
        </button>
      </div>
    </div>` : `
    <div class="sidebar-group">
      <div class="sidebar-group-title">
        <span>数据洞察</span>
      </div>
      <div class="space-y-0.5">
        <button class="sidebar-nav-item ${appState.tab === 'report' ? 'active' : ''}" onclick="window.selectTab('report')">
          <div class="flex items-center gap-2">
            <span class="text-stone-400">✦</span>
            <span class="text-xs">收藏考古报告</span>
          </div>
          <span class="text-[10px] font-mono text-stone-400">已脱敏</span>
        </button>
      </div>
    </div>`}
  `;
}

// ---------- 考古报告渲染 ----------
function bar(label, value, max) {
  return `<div class="bar-row"><span class="w-16 text-stone-500 shrink-0 text-xs">${label}</span><div class="bar-track"><div class="bar-fill" style="width:${max ? Math.round((value / max) * 100) : 0}%"></div></div><span class="w-8 text-right text-stone-600 shrink-0 text-xs">${value}</span></div>`;
}

function renderReportInStage(el, r) {
  if (!r) return;
  const bucketMax = Math.max(...Object.values(r.decayBuckets));
  const typeName = { answer: '回答', article: '文章', pin: '想法', question: '问题', zvideo: '视频' };
  const monthlyMax = Math.max(...Object.values(r.monthly || {}));

  el.innerHTML = `
    <div class="stage-header-bar fade-in">
      <div class="flex items-center gap-2 text-xs text-stone-500">
        <span class="font-medium text-stone-900">数据分析</span>
        <span>/</span>
        <span>收藏考古报告</span>
      </div>
      <span class="text-xs text-stone-400 font-mono">基于 ${r.total} 条真实收藏分析${appState.reportSource === 'mine' ? '（我的收藏）' : ''}</span>
    </div>

    ${r.persona ? `
    <div class="card-paper persona-hero p-7 mb-5 text-center fade-in">
      <div class="text-xs text-stone-400 mb-1.5 tracking-widest uppercase font-mono">Your Collection Persona</div>
      <div class="font-serif-display text-3xl font-bold text-cin mb-2">${esc(r.persona.type)}</div>
      <p class="text-xs text-stone-600 max-w-md mx-auto leading-relaxed">${esc(r.persona.description)}</p>
    </div>` : ''}

    <div class="grid grid-cols-3 gap-3 mb-5">
      <div class="card-paper p-4 text-center">
        <div class="font-serif-display text-2xl font-bold text-stone-900">${r.total}</div>
        <div class="text-xs text-stone-500 mt-1">收藏总数</div>
      </div>
      <div class="card-paper p-4 text-center">
        <div class="font-serif-display text-2xl font-bold text-stone-900">${Math.round(r.spanDays / 365)}<span class="text-xs">年</span></div>
        <div class="text-xs text-stone-500 mt-1">收藏跨度</div>
      </div>
      <div class="card-paper p-4 text-center">
        <div class="font-serif-display text-2xl font-bold text-stone-900">${r.newestItem ? r.newestItem.daysAgo : '—'}<span class="text-xs">天</span></div>
        <div class="text-xs text-stone-500 mt-1">距上次收藏</div>
      </div>
    </div>

    <div class="card-paper p-5 mb-5">
      <h3 class="section-head text-sm mb-3">收藏年代分布 (72h 保质期反面验证)</h3>
      <div class="space-y-2">${Object.entries(r.decayBuckets).map(([k, v]) => bar(k, v, bucketMax)).join('')}</div>
      <p class="text-xs text-stone-400 mt-3">「1 年以上」那 ${r.decayBuckets['1年以上']} 条，大概率已经凉透了——这就是为什么需要朝花夕拾在 72 小时内主动唤醒。</p>
    </div>

    ${r.cards?.domainDist?.length ? `
    <div class="card-paper p-5 mb-5">
      <h3 class="section-head text-sm mb-3">知识领域分布</h3>
      <div class="space-y-2">${r.cards.domainDist.map((d) => bar(d.domain, d.count, r.cards.domainDist[0].count)).join('')}</div>
      <div class="flex gap-1.5 flex-wrap mt-3">${(r.cards.topTags || []).map((t) => `<span class="badge badge-tag">${esc(t.tag)} ${t.count}</span>`).join('')}</div>
    </div>` : ''}

    ${r.oldestItem ? `
    <div class="card-paper p-5 mb-5">
      <h3 class="section-head text-sm mb-2">最老的一条收藏</h3>
      <a class="text-cin hover:underline text-sm font-medium" href="${esc(r.oldestItem.url)}" target="_blank" rel="noopener">${esc(r.oldestItem.title)}</a>
      <div class="text-xs text-stone-400 mt-1">收藏于 ${r.oldestItem.favDate}，已经静静躺了 ${Math.round(r.oldestItem.ageDays / 365)} 年</div>
    </div>` : ''}
  `;
}

// ---------- 右侧主展台渲染 ----------
function renderStage() {
  const stage = $('#app-stage');
  if (!stage) return;

  const doneIds = doneStore.read();

  // 1. 如果处于「今日复习」或单个卡片精读模式
  if (appState.tab === 'today' || (appState.tab === 'cards' && appState.activeCardId)) {
    const queue = appState.queue?.today || [];
    let currentCard = queue.find(c => c.id === appState.activeCardId);
    if (!currentCard && appState.allCards?.cards) {
      currentCard = appState.allCards.cards.find(c => c.id === appState.activeCardId);
    }
    if (!currentCard && queue.length) {
      currentCard = queue[0];
      appState.activeCardId = currentCard.id;
    }

    if (!currentCard) {
      stage.innerHTML = appState.scope === 'mine'
        ? `<div class="card-paper p-8 text-center fade-in">
            <div class="text-3xl mb-2">🌱</div>
            <p class="text-stone-700 text-sm font-medium mb-1">你还没有自己的卡片</p>
            <p class="text-stone-400 text-xs mb-4">去「考古报告」现场炼卡，把你最新的收藏炼成第一张 2 分钟卡片。</p>
            <button class="btn-ink px-4 py-2 text-sm" onclick="window.selectTab('report')">去现场炼卡</button>
          </div>`
        : `<div class="card-paper p-8 text-center text-stone-400">队列为空，去「知识空间」选择卡片复习吧。</div>`;
      return;
    }

    const cardIndex = queue.findIndex(c => c.id === currentCard.id);
    const isQueueItem = cardIndex >= 0;
    const isDone = doneIds.includes(currentCard.id);
    const cleanId = String(currentCard.id || '').replace(/^card_/, '');

    stage.innerHTML = `
      <!-- 展台顶部面包屑与切换条 (对齐图二) -->
      <div class="stage-header-bar fade-in">
        <div class="flex items-center gap-2 text-xs text-stone-500 min-w-0">
          <span class="font-medium text-stone-800">${isQueueItem ? '今日复习队列' : '知识库精读'}</span>
          <span>/</span>
          <span class="font-mono text-stone-400">NO. ${cleanId.slice(-6)}</span>
          ${isDone ? `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-[10px] font-medium border border-emerald-200">已消化 ✓</span>` : ''}
        </div>

        ${isQueueItem ? `
        <div class="flex items-center gap-2">
          <button class="stage-nav-btn" id="stage-prev-btn" ${cardIndex <= 0 ? 'disabled' : ''} onclick="window.stepQueue(-1)">
            ← 上一张
          </button>
          <span class="text-xs font-mono text-stone-400 px-1.5">${cardIndex + 1} / ${queue.length}</span>
          <button class="stage-nav-btn" id="stage-next-btn" ${cardIndex >= queue.length - 1 ? 'disabled' : ''} onclick="window.stepQueue(1)">
            下一张 →
          </button>
        </div>` : `
        <button class="stage-nav-btn" onclick="window.selectDomain('all')">
          ⊞ 返回全景白板
        </button>`}
      </div>

      <!-- 今日拾完庆祝横幅 -->
      ${queue.length && queue.every(c => doneIds.includes(c.id)) ? `
      <div class="card-paper p-5 mb-5 text-center fade-in bg-gradient-to-r from-amber-50/50 to-orange-50/50 border-amber-200/80">
        <div class="text-3xl mb-1.5 celebrate-flower">🌸</div>
        <div class="font-bold text-stone-900 text-sm">今日的花已全部拾完</div>
        <p class="text-xs text-stone-500 mt-1">${appState.scope === 'mine' ? '明天还能再炼一张新卡，趁热消化。' : '明早 8:00 微信准时推送新卡片，趁热消化。'}</p>
      </div>` : ''}

      <!-- 卡片主体展台 -->
      <div id="stage-card-wrapper" class="fade-in">
        ${cardHtml(currentCard, { reviewable: true, isDone })}
        ${askBoxHtml(currentCard.id)}
      </div>
    `;

    renderMath(stage);
    bindAskBox(stage);

    // 绑定打卡事件
    stage.querySelectorAll('.review-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerHTML = '<span>记录中…</span>';
        try {
          const r = await fetchJson('/api/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.dataset.id, scope: appState.scope }),
          });
          if (!r.ok) throw new Error(r.error || 'review failed');
          doneStore.add(btn.dataset.id);

          // 触发印章动效
          const art = btn.closest('article');
          const stampSlot = art.querySelector('.stamp-slot');
          if (stampSlot) {
            stampSlot.innerHTML = `<div class="stamp-seal"><span class="stamp-seal-text">已 拾</span><span class="stamp-seal-sub">朝花夕拾</span></div>`;
          }

          setTimeout(() => {
            art.style.transition = 'opacity .5s ease';
            art.style.opacity = '.55';
          }, 350);

          btn.innerHTML = r.card.status === 'digested' ? '<span>🎉 已完全消化</span>' : `<span>已记录，${Math.round((r.card.nextReviewAt - Date.now() / 1000) / 86400)} 天后再见</span>`;

          // 同步左侧边栏勾选状态
          renderSidebar();

          // 检查是否全部拾完，若是则重新渲染舞台展示花朵
          const allDoneNow = queue.every(c => doneStore.read().includes(c.id));
          if (allDoneNow) {
            setTimeout(() => renderStage(), 600);
          }
        } catch {
          btn.disabled = false;
          btn.innerHTML = '<span>记录失败，点击重试</span>';
        }
      });
    });

    return;
  }

  // 2. 如果处于「白板空间」Tab
  if (appState.tab === 'cards') {
    let cards = appState.allCards?.cards || [];
    // 我的卡册为空：不给看站长示例，引导去现场炼卡
    if (appState.scope === 'mine' && !cards.length) {
      stage.innerHTML = `
        <div class="card-paper p-10 text-center fade-in">
          <div class="text-3xl mb-2">🌱</div>
          <p class="text-stone-700 text-sm font-medium mb-1">你的知识白板还是空的</p>
          <p class="text-stone-400 text-xs mb-4">登录后这里只展示你自己的卡片——去「考古报告」现场炼卡，每天 1 张。</p>
          <button class="btn-ink px-4 py-2 text-sm" onclick="window.selectTab('report')">去现场炼卡</button>
        </div>`;
      return;
    }
    if (appState.activeDomain && appState.activeDomain !== 'all') {
      cards = cards.filter(c => categorizeCard(c) === appState.activeDomain);
    }

    const currentDomainTitle = appState.activeDomain === 'all' ? '全景知识白板' : (SECTIONS.find(s => s.key === appState.activeDomain)?.title || '知识白板');

    stage.innerHTML = `
      <div class="stage-header-bar fade-in">
        <div>
          <h2 class="text-base font-bold text-stone-900 tracking-tight flex items-center gap-2">
            <span>${currentDomainTitle}</span>
            <span class="text-[11px] font-normal text-stone-400 bg-white border border-stone-200 px-2 py-0.5 rounded-full font-mono">${cards.length} 张便签</span>
          </h2>
        </div>
        <div class="flex items-center gap-2">
          <div class="flex items-center bg-[#edeae4] p-1 rounded-lg border border-[#e1ded8]">
            <button id="btn-view-wb" class="view-toggle-btn ${appState.cardViewMode === 'whiteboard' ? 'active' : ''}">⊞ 白板空间</button>
            <button id="btn-view-list" class="view-toggle-btn ${appState.cardViewMode === 'list' ? 'active' : ''}">☰ 卡片列表</button>
          </div>
        </div>
      </div>
      <div id="cards-content-area">
        ${appState.cardViewMode === 'whiteboard' ? whiteboardHtml(cards) : `<div class="stagger">${cards.map(c => cardHtml(c)).join('')}</div>`}
      </div>
    `;

    // 白板模式是摘要视图，跳过 KaTeX 全量扫描；列表模式才渲染公式
    if (appState.cardViewMode === 'list') renderMath(stage);

    $('#btn-view-wb')?.addEventListener('click', () => {
      appState.cardViewMode = 'whiteboard';
      renderStage();
    });
    $('#btn-view-list')?.addEventListener('click', () => {
      appState.cardViewMode = 'list';
      renderStage();
    });

    return;
  }

  // 3. 如果处于「考古报告」Tab
  if (appState.tab === 'report') {
    renderReportTab(stage);
  }
}

// ---------- 微信提醒订阅（Server酱 SendKey，需知乎登录） ----------
function pushSubCardHtml() {
  const sub = appState.pushSub;
  return `
    <div class="card-paper p-5 mb-5 fade-in">
      <h3 class="section-head text-sm mb-2">🔔 微信提醒</h3>
      ${sub?.subscribed ? `
      <div class="flex items-center justify-between flex-wrap gap-2">
        <p class="text-xs text-emerald-700">✓ 已订阅每日微信提醒（每日 08:00，3 张复习卡片）</p>
        <button id="push-unsub-btn" class="px-3 py-1.5 text-xs rounded-lg border border-stone-300 text-stone-500 hover:bg-stone-50 transition-colors shrink-0">退订</button>
      </div>` : `
      <p class="text-xs text-stone-500 mb-3 leading-relaxed">订阅后每日 08:00 微信收到 3 张复习卡片。需要先去 <a class="text-cin hover:underline" href="https://sct.ftqq.com" target="_blank" rel="noopener">sct.ftqq.com</a> 微信扫码登录，获取自己的 SendKey。</p>
      <div class="flex gap-2 flex-wrap">
        <input id="push-key-input" type="text" maxlength="128" autocomplete="off" placeholder="粘贴你的 SendKey（SCT 开头）" class="flex-1 min-w-0 text-sm px-3 py-2 rounded-lg border border-stone-200 bg-white/80 focus:outline-none focus:border-amber-400 transition-colors">
        <button id="push-sub-btn" class="btn-ink px-4 py-2 text-sm shrink-0">订阅并测试</button>
      </div>`}
      <p id="push-sub-msg" class="text-xs mt-2 hidden"></p>
    </div>`;
}

function bindPushSubCard(stage) {
  const msg = stage.querySelector('#push-sub-msg');
  if (!msg) return;
  const showMsg = (text, ok) => {
    msg.className = `text-xs mt-2 ${ok ? 'text-emerald-700' : 'text-red-500'}`;
    msg.textContent = text;
  };
  const subBtn = stage.querySelector('#push-sub-btn');
  if (subBtn) {
    const input = stage.querySelector('#push-key-input');
    const submit = async () => {
      const sendKey = input.value.trim();
      if (!sendKey) { showMsg('请先粘贴 SendKey', false); return; }
      subBtn.disabled = true;
      subBtn.textContent = '测试推送中…';
      try {
        const r = await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sendKey }),
        }).then((resp) => resp.json());
        if (!r.ok) throw new Error(r.error || '订阅失败');
        appState.pushSub = { subscribed: true };
        renderWorkbench();
        const m = $('#push-sub-msg');
        if (m) {
          m.className = 'text-xs mt-2 text-emerald-700';
          m.textContent = '测试消息已发送，请查看微信';
        }
      } catch (e) {
        showMsg(e.message, false);
        subBtn.disabled = false;
        subBtn.textContent = '订阅并测试';
      }
    };
    subBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  const unsubBtn = stage.querySelector('#push-unsub-btn');
  if (unsubBtn) {
    unsubBtn.addEventListener('click', async () => {
      unsubBtn.disabled = true;
      unsubBtn.textContent = '退订中…';
      try {
        const r = await fetch('/api/push/unsubscribe', { method: 'POST' }).then((resp) => resp.json());
        if (!r.ok) throw new Error(r.error || '退订失败');
        appState.pushSub = { subscribed: false };
        renderWorkbench();
      } catch (e) {
        showMsg(e.message, false);
        unsubBtn.disabled = false;
        unsubBtn.textContent = '退订';
      }
    });
  }
}

// ---------- 考古报告 Tab ----------
// 已授权用户不再有「站主示例/我的报告」切换，直接只显示「我的报告」（9/13 晚产品修订）；
// 未登录用户看到的完全不变：站主示例 + 登录 CTA
function loadMyReport(force = false) {
  if (!appState.oauth?.authorized) return;
  if (!force && (appState.myReport || appState.myReportLoading)) return;
  appState.myReportLoading = true;
  appState.myReportError = null;
  fetch('/api/my/report').then((resp) => resp.json()).then((r) => {
    if (!r.ok) throw new Error(r.error || '我的报告生成失败');
    appState.myReport = r.report;
    appState.myReportMeta = r.meta;
  }).catch((e) => {
    appState.myReportError = e.message;
  }).finally(() => {
    appState.myReportLoading = false;
    renderWorkbench();
  });
}

// ---------- 现场炼卡（每登录用户每天 1 张，全站每天 20 张先到先得） ----------
const MYCARD_STAGES = [
  ['breaking_down', '直答拆解中', '直答正在读该问题下的优质讨论'],
  ['making_card', 'AI 炼卡中', '把拆解浓缩成 2 分钟卡片'],
  ['reviewing', '盲审把关中', '忠实性 + 核心覆盖双检查'],
];
const MYCARD_RUNNING = MYCARD_STAGES.map(([k]) => k);

function myCardSlotHtml() {
  const mc = appState.myCard;
  if (mc === undefined) {
    return `<div class="card-paper p-5 mb-5 animate-pulse"><div class="h-4 bg-stone-200 rounded w-1/3 mb-2"></div><div class="h-3 bg-stone-200 rounded w-2/3"></div></div>`;
  }
  // 完成：用现有卡片渲染函数完整渲染（角标点出来源错位声明，KaTeX 由调用方触发）
  if (mc.status === 'done' && mc.card) {
    const src = mc.source || mc.card.source || {};
    return `
      <h3 class="section-head text-sm mb-3 fade-in">✨ 我的第一张卡片</h3>
      ${cardHtml(mc.card, { sourceBadge: '拆解自该问题下的优质讨论' })}
      <p class="text-[11px] text-stone-400 mb-5 -mt-3 fade-in">拆解自你${src.pickedFrom72h ? ' 72 小时内最新' : '最新'}收藏的《<a class="text-cin hover:underline" href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)}</a>》${mc.card.reviewScore >= 5 ? '，已通过盲审' : ''}。每天限 1 张，明天还能再来。</p>`;
  }
  // 进行中：分阶段进度
  if (MYCARD_RUNNING.includes(mc.status)) {
    const idx = MYCARD_STAGES.findIndex(([k]) => k === mc.status);
    // 阶段行三态查表（替代嵌套三元，#42）
    const STAGE_ROW_CLS = { done: 'text-emerald-700', current: 'text-stone-900 font-medium', todo: 'text-stone-300' };
    const STAGE_ICON = { done: '✓', current: '⏳', todo: '·' };
    const stageState = (i) => (i < idx ? 'done' : i === idx ? 'current' : 'todo');
    return `
      <div class="card-paper p-6 mb-5 fade-in border-amber-200/80">
        <h3 class="section-head text-sm mb-1">✨ 正在现场炼卡</h3>
        <p class="text-[11px] text-stone-400 mb-4">对象：你${mc.source?.pickedFrom72h ? ' 72 小时内最新' : '最新'}的收藏《${esc(mc.source?.title || '')}》</p>
        <div class="space-y-2.5">
          ${MYCARD_STAGES.map(([k, label, sub], i) => { const st = stageState(i); return `
            <div class="flex items-center gap-2.5 text-xs ${STAGE_ROW_CLS[st]}">
              <span class="w-4 text-center shrink-0 ${st === 'current' ? 'animate-pulse' : ''}">${STAGE_ICON[st]}</span>
              <span class="shrink-0">${label}</span>
              <span class="${st === 'current' ? 'text-stone-400' : 'text-stone-300'} truncate">${sub}</span>
            </div>`; }).join('')}
        </div>
        <p class="text-[11px] text-stone-400 mt-4">直答拆解需要几十秒，全程约 1-2 分钟，页面会自动更新。</p>
      </div>`;
  }
  // 前端轮询超时：服务端任务可能仍在跑，给刷新入口
  if (mc.status === 'timeout') {
    return `
      <div class="card-paper p-6 mb-5 text-center fade-in">
        <p class="text-stone-500 text-sm mb-3">生成时间超出预期，服务端可能仍在继续。</p>
        <button id="mycard-refresh-btn" class="btn-ink px-4 py-2 text-sm">刷新查看</button>
      </div>`;
  }
  // 失败（盲审打回/直答紧张等）：未消耗用户的 1 张，可重试
  if (mc.status === 'failed') {
    return `
      <div class="card-paper p-6 mb-5 text-center fade-in">
        <div class="text-3xl mb-2">🥀</div>
        <p class="text-stone-500 text-sm mb-3">${esc(mc.error || '生成失败，请稍后重试')}</p>
        <button id="mycard-start-btn" class="btn-ink px-4 py-2 text-sm">重试</button>
      </div>`;
  }
  // 发起即被拒：名额满（429）/ 无收藏（422）/ 其他错误
  if (mc.status === 'rejected-msg') {
    return `
      <div class="card-paper p-6 mb-5 text-center fade-in border-amber-200/80 bg-amber-50/40">
        <p class="text-sm text-stone-600 mb-1">${esc(mc.error)}</p>
        ${mc.quotaExceeded ? '<p class="text-[11px] text-stone-400">全站每天限 20 张，先到先得，明天 0 点重置</p>' : ''}
        ${!mc.quotaExceeded && !mc.noFavorites ? '<button id="mycard-refresh-btn" class="btn-ink px-4 py-2 text-sm mt-3">重试</button>' : ''}
      </div>`;
  }
  // idle：炼卡入口
  const used = mc.quota?.used ?? 0;
  const cap = mc.quota?.cap ?? 20;
  const full = used >= cap;
  return `
    <div class="card-paper p-6 mb-5 fade-in border-amber-200/80 bg-gradient-to-br from-amber-50/60 to-orange-50/40">
      <h3 class="section-head text-sm mb-2">✨ 生成我的第一张卡片</h3>
      <p class="text-xs text-stone-600 leading-relaxed mb-1">选你 <b>72 小时内最新的一条收藏</b>，现场走完直答拆解 → AI 炼卡 → 盲审把关，拆成一张 2 分钟卡片。</p>
      <p class="text-[11px] text-stone-400 mb-4">每天限 1 张 · 全站每天限 ${cap} 张，先到先得（今日已用 ${used}/${cap}）</p>
      ${full
        ? '<p class="text-xs text-amber-700 font-medium">今日体验名额已用完，明天再来</p>'
        : '<button id="mycard-start-btn" class="btn-ink px-5 py-2.5 text-sm">现场炼卡</button>'}
    </div>`;
}

// 现场炼卡错误透出：机器码 → 用户可读文案（GET / POST / 轮询三处共用，#41）
function myCardError(r, fallback = '操作失败，请稍后重试') {
  if (r?.loginRequired || r?.error === 'loginRequired') return '登录已过期，请重新登录后再试';
  return r?.error || fallback;
}

// 炼卡完成后同步「我的卡册」数据源，让今日复习/白板立刻能看到新卡
async function refreshMineQueue() {
  if (appState.scope !== 'mine') return;
  try {
    const [queue, allCards] = await Promise.all([
      fetchJson('/api/queue?scope=mine'),
      fetchJson('/api/cards?status=approved&scope=mine'),
    ]);
    appState.queue = queue;
    appState.allCards = allCards;
  } catch { /* 下次进 tab 会重新拉取 */ }
}

function fetchMyCardStatus(force = false) {
  if (!appState.oauth?.authorized || appState.myCardFetching) return;
  if (!force && appState.myCard !== undefined) return;
  appState.myCardFetching = true;
  fetch('/api/my/card').then((resp) => resp.json()).then((r) => {
    if (r.ok) {
      appState.myCard = r;
      if (r.status === 'done') refreshMineQueue();
      if (MYCARD_RUNNING.includes(r.status)) pollMyCard();
    } else {
      appState.myCard = { status: 'rejected-msg', error: myCardError(r, '状态拉取失败') };
    }
  }).catch(() => {
    appState.myCard = { status: 'rejected-msg', error: '网络开小差了，点击重试' };
  }).finally(() => {
    appState.myCardFetching = false;
    renderWorkbench();
  });
}

// 2s 轮询任务状态，最多 3 分钟；阶段变化即刷新界面
function pollMyCard() {
  if (appState.myCardPolling) return;
  appState.myCardPolling = true;
  const startedAt = Date.now();
  const tick = async () => {
    if (Date.now() - startedAt > 180000) {
      appState.myCardPolling = false;
      appState.myCard = { status: 'timeout' };
      renderWorkbench();
      return;
    }
    try {
      const resp = await fetch('/api/my/card');
      // 4xx（尤其 401 会话过期）无恢复可能：直接终止轮询并透出映射后的文案（#41）
      if (resp.status >= 400 && resp.status < 500) {
        const r = await resp.json().catch(() => ({}));
        appState.myCardPolling = false;
        appState.myCard = { status: 'rejected-msg', error: myCardError(r, '状态拉取失败') };
        renderWorkbench();
        return;
      }
      const r = await resp.json();
      if (r.ok) {
        const prev = appState.myCard?.status;
        appState.myCard = r;
        if (!MYCARD_RUNNING.includes(r.status)) {
          appState.myCardPolling = false;
          if (r.status === 'done') await refreshMineQueue();
          renderWorkbench();
          return;
        }
        if (r.status !== prev) renderWorkbench();
      }
    } catch { /* 网络抖动，继续轮询 */ }
    setTimeout(tick, 2000);
  };
  tick();
}

function bindMyCardSlot(stage) {
  const startBtn = stage.querySelector('#mycard-start-btn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      startBtn.textContent = '发起中…';
      try {
        const resp = await fetch('/api/my/card', { method: 'POST' });
        const r = await resp.json();
        if (!r.ok) {
          appState.myCard = { status: 'rejected-msg', error: myCardError(r, '发起失败，请稍后重试'), quotaExceeded: r.quotaExceeded, noFavorites: r.noFavorites };
        } else {
          appState.myCard = r;
          if (r.status === 'done') await refreshMineQueue();
          if (MYCARD_RUNNING.includes(r.status)) pollMyCard();
        }
      } catch {
        appState.myCard = { status: 'rejected-msg', error: '网络开小差了，点击重试' };
      }
      renderWorkbench();
    });
  }
  const refreshBtn = stage.querySelector('#mycard-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchMyCardStatus(true));
  }
}

function renderReportTab(stage) {
  const parts = [];

  // 授权回调着陆提示（展示一次后清除）
  if (appState.oauthLanding) {
    const ok = appState.oauthLanding === 'ok';
    parts.push(`
      <div class="card-paper p-4 mb-4 fade-in ${ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60'}">
        <p class="text-xs ${ok ? 'text-emerald-700' : 'text-red-600'}">${ok ? '✓ 知乎授权成功，这是你自己的收藏考古报告。' : '登录没有完成（可能被取消或会话过期），点右上角「知乎登录」重试。'}</p>
      </div>`);
    appState.oauthLanding = null;
  }

  const authorized = appState.oauth?.authorized;
  appState.reportSource = authorized ? 'mine' : 'site';

  // 未登录 CTA
  if (!authorized) {
    parts.push(`
      <div class="card-paper p-5 mb-5 fade-in text-center border-amber-200/80 bg-amber-50/40">
        <p class="text-sm text-stone-700 font-medium mb-1">这是站主的示例报告（已脱敏）</p>
        <p class="text-xs text-stone-500 mb-3">公开示例只保留聚合数字，人格画像、领域分布等隐私内容已隐藏——登录知乎，看看你自己的收藏人格和 72h 保质期，只读取收藏元数据，不会消耗你的任何额度。</p>
        <a href="/auth/login" class="btn-ink inline-flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg">知乎登录，生成我的考古报告</a>
      </div>`);
  }

  // 已登录：只显示「我的报告」（含微信订阅 + 现场炼卡入口），无站主示例切换
  if (authorized) {
    loadMyReport();
    parts.push(`
      <div class="flex items-center gap-2 mb-4 fade-in">
        <span class="text-sm font-bold text-stone-900">我的考古报告</span>
        ${appState.myReportMeta ? `<span class="text-[10px] text-stone-400 font-mono">${appState.myReportMeta.favlists} 个收藏夹 · ${appState.myReportMeta.requests} 次接口调用${appState.myReportMeta.truncated ? ' · 已达上限截断' : ''}</span>` : ''}
      </div>`);
    parts.push(pushSubCardHtml());
  }

  const holder = document.createElement('div');

  if (authorized) {
    if (appState.myReportLoading) {
      holder.innerHTML = SKELETON;
    } else if (appState.myReportError) {
      holder.innerHTML = `
        <div class="card-paper p-6 text-center fade-in">
          <div class="text-3xl mb-2">🥀</div>
          <p class="text-stone-500 text-sm mb-3">${esc(appState.myReportError)}</p>
          <button class="retry-btn btn-ink px-4 py-2 text-sm" onclick="window.selectReportSource(true)">重试</button>
        </div>`;
    } else if (appState.myReport) {
      renderReportInStage(holder, appState.myReport);
      fetchMyCardStatus();
      holder.insertAdjacentHTML('beforeend', myCardSlotHtml());
    }
  } else {
    renderReportInStage(holder, appState.report);
  }

  // 海报入口（有报告数据才显示）
  const shown = authorized ? appState.myReport : appState.report;
  if (shown && !shown.sanitized) {
    holder.insertAdjacentHTML('beforeend', `
      <div class="text-center mb-8 fade-in">
        <button class="btn-ink px-5 py-2.5 text-sm rounded-lg" onclick="window.makePoster()">📮 生成分享海报</button>
        <p class="text-[11px] text-stone-400 mt-2">收藏人格是主钩子，适合晒到想法/朋友圈</p>
      </div>`);
  }

  stage.innerHTML = parts.join('');
  stage.appendChild(holder);
  bindPushSubCard(stage);
  bindMyCardSlot(stage);
  if (appState.myCard?.status === 'done') renderMath(stage);
}

window.selectReportSource = function (force = false) {
  // 已授权用户没有「站主示例」入口，强制落在「我的报告」（#42：src 参数已废弃，来源在此自行推导）
  appState.reportSource = appState.oauth?.authorized ? 'mine' : 'site';
  if (appState.reportSource === 'mine') loadMyReport(force);
  renderWorkbench();
};

// ---------- 统一工作台渲染入口 ----------
function renderWorkbench() {
  // 保持顶栏胶囊与当前状态一致
  document.querySelectorAll('.pill-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === appState.tab);
  });
  renderOAuthSlot();
  renderSidebar();
  renderStage();
}

// 导航操作挂在 window 上
window.selectQueueCard = function (id) {
  appState.tab = 'today';
  appState.activeCardId = id;
  location.hash = 'today';
  renderWorkbench();
};

window.selectSingleCard = function (id) {
  appState.tab = 'cards';
  appState.activeCardId = id;
  // 不重置 cardViewMode：精读完点「返回全景白板」应回到白板，而不是被切回列表
  location.hash = id;
  renderWorkbench();
};

window.selectDomain = function (domainKey) {
  appState.tab = 'cards';
  appState.activeDomain = domainKey;
  appState.activeCardId = null;
  location.hash = 'cards';
  renderWorkbench();
};

window.selectTab = function (tabName) {
  appState.tab = tabName;
  if (tabName === 'today') {
    const queue = appState.queue?.today || [];
    const doneIds = doneStore.read();
    const firstUndone = queue.find(c => !doneIds.includes(c.id));
    appState.activeCardId = firstUndone ? firstUndone.id : (queue[0]?.id || null);
  } else {
    appState.activeCardId = null;
  }
  location.hash = tabName;
  renderWorkbench();
};

window.stepQueue = function (delta) {
  const queue = appState.queue?.today || [];
  const idx = queue.findIndex(c => c.id === appState.activeCardId);
  const nextIdx = idx + delta;
  if (nextIdx >= 0 && nextIdx < queue.length) {
    appState.activeCardId = queue[nextIdx].id;
    renderWorkbench();
  }
};

// ---------- 追问（卡片详情接直答，每登录用户每日 2 次 + 每出口 IP 每日 20 次硬顶） ----------
// 身份只认知乎 OAuth 会话（issue #36：自报 UUID / 匿名 cookie 已关闭），未登录引导走登录入口

function askBoxHtml(cardId) {
  return `
  <div class="card-paper p-5 mb-5 fade-in ask-box" data-card-id="${esc(cardId)}">
    <div class="flex items-center justify-between mb-3">
      <h3 class="section-head text-sm">💬 追问这张卡</h3>
      <span class="text-[11px] text-stone-400 ask-remaining">…</span>
    </div>
    <div class="flex gap-2">
      <input type="text" class="ask-input flex-1 min-w-0 text-sm px-3 py-2 rounded-lg border border-stone-200 bg-white/80 focus:outline-none focus:border-amber-400 transition-colors" placeholder="就这张卡片继续提问，比如：这个证明的直觉是什么？" maxlength="200">
      <button class="ask-btn btn-ink px-4 py-2 text-sm shrink-0">提问</button>
    </div>
    <div class="ask-result hidden mt-4 pt-3 border-t border-dashed border-[#eee7d7]"></div>
  </div>`;
}

function bindAskBox(stage) {
  const box = stage.querySelector('.ask-box');
  if (!box) return;
  const cardId = box.dataset.cardId;
  const input = box.querySelector('.ask-input');
  const btn = box.querySelector('.ask-btn');
  const remainingEl = box.querySelector('.ask-remaining');
  const resultEl = box.querySelector('.ask-result');

  const renderRemaining = (n) => {
    remainingEl.textContent = n > 0 ? `今日还可追问 ${n} 次` : '今日额度已用完';
    if (n <= 0) { input.disabled = true; btn.disabled = true; }
  };

  // 未登录（或会话中途过期）：收起输入框，引导登录（与报告页未登录 CTA 同风格）
  const showLoginPrompt = () => {
    remainingEl.textContent = '';
    input.classList.add('hidden');
    btn.classList.add('hidden');
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <p class="text-xs text-stone-500 mb-2.5">登录知乎后即可追问这张卡——只读取授权身份，不消耗你的任何额度。</p>
      <a href="/auth/login" class="btn-ink inline-flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg">知乎登录后追问</a>`;
  };

  if (!appState.oauth?.authorized) { showLoginPrompt(); return; }

  fetchJson('/api/ask/quota')
    .then((r) => renderRemaining(r.remaining))
    .catch(() => { remainingEl.textContent = ''; });

  const submit = async () => {
    const question = input.value.trim();
    if (!question) return;
    btn.disabled = true;
    btn.textContent = '直答思考中…';
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `<p class="text-xs text-stone-400 animate-pulse">正在就「${esc(question.slice(0, 30))}」检索知乎讨论并生成回答，直答可能需要十几秒…</p>`;
    try {
      const r = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId, question }),
      }).then((resp) => resp.json());
      if (r.loginRequired) { showLoginPrompt(); return; }
      if (!r.ok) throw new Error(r.error || '追问失败');
      resultEl.innerHTML = `
        <div class="text-xs text-amber-700 mb-1.5 font-medium">直答 · ${r.cached ? '缓存命中（未消耗额度）' : '基于该问题下的知乎讨论'}</div>
        <div class="text-sm text-stone-700 leading-relaxed" style="white-space:pre-wrap">${esc(r.answer)}</div>`;
      input.value = '';
      renderRemaining(r.remaining);
      btn.textContent = '提问';
      btn.disabled = r.remaining <= 0;
    } catch (e) {
      resultEl.innerHTML = `<p class="text-xs text-red-500">${esc(e.message)}</p>`;
      btn.textContent = '提问';
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
}

// 键盘快捷键监听
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (appState.tab === 'today') {
    if (e.key === 'ArrowRight' || e.key === 'j' || e.key === 'J') window.stepQueue(1);
    if (e.key === 'ArrowLeft' || e.key === 'k' || e.key === 'K') window.stepQueue(-1);
  }
});

// ---------- 初始化加载与路由 ----------
async function initApp() {
  const stage = $('#app-stage');
  const sb = $('#app-sidebar');
  if (stage) stage.innerHTML = SKELETON;
  if (sb) sb.innerHTML = `<div class="sidebar-panel animate-pulse h-96 bg-white/60"></div>`;

  try {
    // 登录态先行：决定队列/卡册用站长示例还是「我的卡册」（登录后站长内容完全不可见）
    const oauthStatus = await fetchJson('/api/oauth/status').catch(() => null);
    appState.oauth = oauthStatus;
    appState.scope = oauthStatus?.authorized ? 'mine' : 'site';
    const mine = appState.scope === 'mine';
    // queue/cards 是页面核心数据，失败必须让 Promise.all reject 走 showError；
    // report 属可选增强，允许降级为 null
    const [queue, allCards, report] = await Promise.all([
      fetchJson(mine ? '/api/queue?scope=mine' : '/api/queue'),
      fetchJson(mine ? '/api/cards?status=approved&scope=mine' : '/api/cards?status=approved'),
      fetchJson('/api/report').catch(() => null),
    ]);
    appState.queue = queue;
    appState.allCards = allCards;
    appState.report = report;
    // 已登录才拉订阅状态（未登录接口会 401）
    if (appState.oauth?.authorized) {
      appState.pushSub = await fetchJson('/api/push/subscription').catch(() => null);
    }

    // 根据 URL hash 决定初始状态；hash 里可能带 ?oauth=ok/error（授权回调着陆），先 strip query 再匹配 tab
    const h = location.hash.slice(1);
    const [tab, query] = h.split('?');
    const oauthResult = new URLSearchParams(query || '').get('oauth');
    if (oauthResult === 'ok' || oauthResult === 'error') {
      appState.oauthLanding = oauthResult;
      // 已登录默认落到「我的报告」
      if (oauthResult === 'ok' && appState.oauth?.authorized) {
        appState.reportSource = 'mine';
        window.selectReportSource();
      }
    }
    if (tab.startsWith('card_')) {
      appState.tab = 'cards';
      appState.activeCardId = tab;
    } else if (tab === 'cards' || tab === 'report') {
      appState.tab = tab;
    } else {
      appState.tab = 'today';
      const doneIds = doneStore.read();
      const firstUndone = queue.today.find(c => !doneIds.includes(c.id));
      appState.activeCardId = firstUndone ? firstUndone.id : (queue.today[0]?.id || null);
    }

    renderWorkbench();
  } catch (err) {
    if (stage) showError(stage, initApp);
  }
}

// 顶栏胶囊点击
document.querySelectorAll('.pill-item').forEach((b) => {
  b.addEventListener('click', () => {
    window.selectTab(b.dataset.tab);
  });
});

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1).split('?')[0];
  if (h.startsWith('card_')) {
    window.selectSingleCard(h);
  } else if (['today', 'cards', 'report'].includes(h) && h !== appState.tab) {
    window.selectTab(h);
  }
});

// ---------- 考古报告海报（Canvas 纯前端生成，收藏人格为主钩子） ----------
function posterWrap(ctx, text, maxWidth) {
  // 中文按字断行
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    if (ctx.measureText(line + ch).width > maxWidth && line) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

async function drawPoster(r) {
  await document.fonts.ready;
  const W = 750, H = 1180, S = 2, PAD = 48;
  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  ctx.scale(S, S);

  const SERIF = '"Noto Serif SC", "Songti SC", serif';
  const INK = '#1c1917', INK2 = '#57534e', INK3 = '#a8a29e', AMBER = '#b45309', LINE = '#e7e0d2', PAPER = '#f7f3ea';

  // 纸面 + 细边框
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(16.5, 16.5, W - 33, H - 33);

  let y = 64;
  // 顶部 kicker + 日期
  ctx.fillStyle = INK3;
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('知 乎 收 藏 考 古 报 告', PAD, y);
  ctx.textAlign = 'right';
  ctx.fillText(new Date().toLocaleDateString('sv-SE'), W - PAD, y);
  ctx.textAlign = 'left';
  y += 18;
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();

  // 收藏人格（主钩子，居中）
  y += 74;
  ctx.textAlign = 'center';
  ctx.fillStyle = INK3;
  ctx.font = '15px sans-serif';
  ctx.fillText('你的收藏人格是', W / 2, y);
  y += 62;
  ctx.fillStyle = AMBER;
  ctx.font = `bold 52px ${SERIF}`;
  ctx.fillText(r.persona.type, W / 2, y);
  y += 34;
  ctx.fillStyle = INK2;
  ctx.font = '15px sans-serif';
  for (const ln of posterWrap(ctx, r.persona.description, W - PAD * 2 - 40).slice(0, 2)) {
    ctx.fillText(ln, W / 2, y);
    y += 24;
  }
  ctx.textAlign = 'left';

  // 三宫格数据
  y += 40;
  const stats = [
    [String(r.total), '收藏总数'],
    [`${Math.round(r.spanDays / 365)} 年`, '收藏跨度'],
    [`${r.newestItem.daysAgo} 天`, '距上次收藏'],
  ];
  const colW = (W - PAD * 2) / 3;
  stats.forEach(([v, label], i) => {
    const cx = PAD + colW * i + colW / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    ctx.font = `bold 30px ${SERIF}`;
    ctx.fillText(v, cx, y);
    ctx.fillStyle = INK3;
    ctx.font = '12px sans-serif';
    ctx.fillText(label, cx, y + 24);
    if (i > 0) {
      ctx.beginPath(); ctx.moveTo(PAD + colW * i, y - 24); ctx.lineTo(PAD + colW * i, y + 22); ctx.stroke();
    }
  });
  ctx.textAlign = 'left';

  // 收藏年代分布
  y += 72;
  ctx.fillStyle = INK;
  ctx.font = `bold 16px ${SERIF}`;
  ctx.fillText('收藏年代分布', PAD, y);
  y += 14;
  const buckets = Object.entries(r.decayBuckets);
  const bMax = Math.max(...buckets.map(([, v]) => v), 1);
  const barX = PAD + 76, barW = W - PAD * 2 - 76 - 44;
  for (const [label, v] of buckets) {
    y += 26;
    ctx.fillStyle = INK3;
    ctx.font = '12px sans-serif';
    ctx.fillText(label, PAD, y + 4);
    ctx.fillStyle = '#ede6d8';
    ctx.fillRect(barX, y - 5, barW, 10);
    if (v > 0) {
      ctx.fillStyle = AMBER;
      ctx.fillRect(barX, y - 5, Math.max(4, (v / bMax) * barW), 10);
    }
    ctx.fillStyle = INK2;
    ctx.textAlign = 'right';
    ctx.fillText(String(v), W - PAD, y + 4);
    ctx.textAlign = 'left';
  }
  y += 26;
  ctx.fillStyle = INK3;
  ctx.font = '12px sans-serif';
  ctx.fillText('「1 年以上」的大概率已经凉透了——72h 是收藏的黄金期。', PAD, y);

  // 爆发月 + 最常收藏作者
  y += 48;
  ctx.fillStyle = INK;
  ctx.font = `bold 16px ${SERIF}`;
  ctx.fillText('收藏瞬间', PAD, y);
  y += 28;
  ctx.font = '13px sans-serif';
  ctx.fillStyle = INK2;
  if (r.burstMonth?.month) {
    ctx.fillText(`⚡ ${r.burstMonth.month} 月一口气收藏了 ${r.burstMonth.count} 条`, PAD, y);
    y += 24;
  }
  if (r.topAuthors?.length) {
    ctx.fillText(`✍️ 最常收藏的作者：${r.topAuthors.slice(0, 3).map((a) => a.name).join('、')}`, PAD, y);
    y += 24;
  }

  // 最老的一条收藏
  if (r.total > 0 && r.oldestItem.title) {
    y += 28;
    ctx.fillStyle = INK;
    ctx.font = `bold 16px ${SERIF}`;
    ctx.fillText('最老的一条收藏', PAD, y);
    y += 28;
    ctx.fillStyle = AMBER;
    ctx.font = `14px ${SERIF}`;
    for (const ln of posterWrap(ctx, r.oldestItem.title, W - PAD * 2).slice(0, 2)) {
      ctx.fillText(ln, PAD, y);
      y += 22;
    }
    ctx.fillStyle = INK3;
    ctx.font = '12px sans-serif';
    ctx.fillText(`收藏于 ${r.oldestItem.favDate}，已经静静躺了 ${Math.round(r.oldestItem.ageDays / 365)} 年`, PAD, y);
  }

  // footer
  ctx.beginPath(); ctx.moveTo(PAD, H - 84); ctx.lineTo(W - PAD, H - 84); ctx.stroke();
  ctx.fillStyle = INK;
  ctx.font = `bold 17px ${SERIF}`;
  ctx.fillText('朝花夕拾', PAD, H - 52);
  ctx.fillStyle = INK3;
  ctx.font = '12px sans-serif';
  ctx.fillText('早上的花，傍晚拾 · 让好内容不再被遗忘', PAD, H - 30);
  ctx.textAlign = 'right';
  ctx.fillText('lnuhxmgreuxd.sealoshzh.site', W - PAD, H - 30);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

window.makePoster = async function () {
  const r = appState.reportSource === 'mine' && appState.oauth?.authorized ? appState.myReport : appState.report;
  if (!r) return;
  // loading 遮罩
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4';
  overlay.innerHTML = `<div class="text-white text-sm animate-pulse">正在绘制海报…</div>`;
  document.body.appendChild(overlay);
  try {
    const url = await drawPoster(r);
    overlay.innerHTML = `
      <div class="bg-white rounded-xl p-4 max-w-sm w-full shadow-2xl fade-in">
        <img src="${url}" alt="收藏考古报告海报" class="w-full rounded-lg border border-stone-200">
        <div class="flex items-center gap-3 mt-3">
          <a href="${url}" download="朝花夕拾-收藏考古报告.png" class="btn-ink flex-1 text-center px-4 py-2.5 text-sm rounded-lg">保存图片</a>
          <button class="poster-close flex-1 px-4 py-2.5 text-sm rounded-lg border border-stone-300 text-stone-600 hover:bg-stone-50">关闭</button>
        </div>
        <p class="text-[11px] text-stone-400 mt-2 text-center">手机上也可以长按图片保存</p>
      </div>`;
    overlay.querySelector('.poster-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  } catch (e) {
    overlay.innerHTML = `
      <div class="bg-white rounded-xl p-6 max-w-xs text-center">
        <p class="text-sm text-stone-500 mb-3">海报生成失败：${esc(e.message)}</p>
        <button class="poster-close btn-ink px-4 py-2 text-sm rounded-lg">关闭</button>
      </div>`;
    overlay.querySelector('.poster-close').addEventListener('click', () => overlay.remove());
  }
};

initApp();
