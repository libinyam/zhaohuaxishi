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
function cardHtml(c, { reviewable = false, isDone = false } = {}) {
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
        <span class="badge badge-source" title="AI 拆解综合了该问题下多篇高赞回答，不局限于你收藏的这条；点击标题链接阅读你收藏的原回答">知乎拆解</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge ${diffCls}">${diffText}</span>
        ${c.reviewScore != null ? `<span class="badge badge-score">${c.reviewScore >= 5 ? '盲审通过' : `盲审 ${c.reviewScore}/5`}</span>` : ''}
      </div>
    </div>

    <!-- 标题与出处 -->
    <h3 class="font-serif-display text-lg md:text-xl font-bold leading-snug mb-2 text-stone-900">
      <a class="hover:text-amber-700 transition-colors inline-flex items-start gap-1" href="${esc(c.source?.url)}" target="_blank" rel="noopener">
        <span>${esc(c.source?.title)}</span>
        <span class="text-xs text-amber-700 font-sans mt-1 opacity-75">↗</span>
      </a>
    </h3>

    <div class="flex items-center gap-2 text-xs text-stone-400 mb-4 pb-2 border-b border-stone-100">
      ${author ? `<span>${author}</span><span>·</span>` : ''}
      <span>收藏于 ${favDate}</span>
    </div>

    <!-- 核心立论 -->
    <div class="thesis-box">
      <div class="font-medium text-stone-900 leading-relaxed"><span class="marker-hl font-semibold">核心提炼 ·</span> ${esc(c.coreView)}</div>
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
  if (window.renderMathInElement) {
    renderMathInElement(el, { delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
    ], throwOnError: false });
  }
}

// ---------- 双栏工作台状态管理 (对齐图二) ----------
const appState = {
  tab: 'today',             // 'today' | 'cards' | 'report'
  activeCardId: null,       // id of the card focused in stage
  activeDomain: 'all',      // 'all' | 'math' | 'humanities' | 'growth' | 'tech'
  cardViewMode: 'list',     // 'list' | 'whiteboard'
  queue: null,
  allCards: null,
  report: null,
  oauth: null,              // /api/oauth/status：{ configured, authorized, profile }
  oauthLanding: null,       // 'ok' | 'error'（授权回调着陆提示，展示一次后清除）
  reportSource: 'site',     // 'site' 站主示例 | 'mine' 我的报告
  myReport: null,
  myReportMeta: null,
  myReportLoading: false,
  myReportError: null,
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
      <a href="/auth/login" class="inline-flex items-center gap-1.5 text-xs bg-[#056de8] text-white rounded-full px-3.5 py-1.5 hover:bg-[#0454b8] transition-colors shadow-sm">
        <span>知乎登录</span>
      </a>`;
  }
}

window.oauthLogout = async function () {
  try { await fetchJson('/api/oauth/logout', { method: 'POST' }); } catch { /* 网络失败也按本地登出处理 */ }
  appState.oauth = null;
  appState.reportSource = 'site';
  appState.myReport = null;
  appState.myReportMeta = null;
  appState.myReportError = null;
  renderOAuthSlot();
  renderWorkbench();
};

function categorizeCard(c) {
  const text = (c.topicTags || []).join(' ') + ' ' + (c.source?.title || '');
  if (/数学|代数|微积分|几何|数论|竞赛|分析|方程|极限|级数|拓扑/.test(text)) return 'math';
  if (/人际|心理|送礼|哲学|文学|九州|历史|社会|关系|生活/.test(text)) return 'humanities';
  if (/编程|算法|代码|Python|CS|开发|架构|软件|AI|大模型/.test(text)) return 'tech';
  if (/思维|成长|学习|复利|方法|习惯|效率|认知|模型/.test(text)) return 'growth';
  return 'other';
}

const SECTIONS = [
  { key: 'math', title: '数理逻辑空间', sub: 'Mathematical Systems', cls: 'wb-section-math', icon: '📐' },
  { key: 'humanities', title: '人文哲思空间', sub: 'Humanities & Mind', cls: 'wb-section-humanities', icon: '🏛️' },
  { key: 'growth', title: '认知与成长空间', sub: 'Mental Models & Growth', cls: 'wb-section-growth', icon: '💡' },
  { key: 'tech', title: '技术与工程空间', sub: 'Engineering & Code', cls: 'wb-section-tech', icon: '💻' },
  { key: 'other', title: '通识与精选空间', sub: 'General Insights', cls: 'wb-section-other', icon: '✦' },
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
              <span class="text-xs shrink-0 ${isDone ? 'text-emerald-600 font-bold' : isActive ? 'text-white' : 'text-stone-400'}">
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

    <!-- 分组 3：知识白板空间 -->
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
            <span class="text-xs">${s.icon}</span>
            <span class="text-xs">${s.title}</span>
          </div>
          <span class="sidebar-badge text-[10px]">${domainCounts[s.key] || 0}</span>
        </button>`).join('')}
      </div>
    </div>

    <!-- 分组 4：数据中心 -->
    <div class="sidebar-group">
      <div class="sidebar-group-title">
        <span>数据洞察</span>
      </div>
      <div class="space-y-0.5">
        <button class="sidebar-nav-item ${appState.tab === 'report' ? 'active' : ''}" onclick="window.selectTab('report')">
          <div class="flex items-center gap-2">
            <span>🏺</span>
            <span class="text-xs">收藏考古报告</span>
          </div>
          <span class="text-[10px] font-mono text-stone-400">${appState.report?.total ?? '…'}条</span>
        </button>
      </div>
    </div>
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

    <div class="card-paper persona-hero p-7 mb-5 text-center fade-in">
      <div class="text-xs text-stone-400 mb-1.5 tracking-widest uppercase font-mono">Your Collection Persona</div>
      <div class="font-serif-display text-3xl font-bold text-amber-700 mb-2">${esc(r.persona.type)}</div>
      <p class="text-xs text-stone-600 max-w-md mx-auto leading-relaxed">${esc(r.persona.description)}</p>
    </div>

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
        <div class="font-serif-display text-2xl font-bold text-stone-900">${r.newestItem.daysAgo}<span class="text-xs">天</span></div>
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

    ${r.total > 0 ? `
    <div class="card-paper p-5 mb-5">
      <h3 class="section-head text-sm mb-2">最老的一条收藏</h3>
      <a class="text-amber-800 hover:underline text-sm font-medium" href="${esc(r.oldestItem.url)}" target="_blank" rel="noopener">${esc(r.oldestItem.title)}</a>
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
      stage.innerHTML = `<div class="card-paper p-8 text-center text-stone-400">队列为空，去「知识空间」选择卡片复习吧。</div>`;
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
        <p class="text-xs text-stone-500 mt-1">明早 8:00 微信准时推送新卡片，趁热消化。</p>
      </div>` : ''}

      <!-- 卡片主体展台 -->
      <div id="stage-card-wrapper" class="fade-in">
        ${cardHtml(currentCard, { reviewable: true, isDone })}
      </div>
    `;

    renderMath(stage);

    // 绑定打卡事件
    stage.querySelectorAll('.review-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.innerHTML = '<span>记录中…</span>';
        try {
          const r = await fetchJson('/api/review', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: btn.dataset.id }),
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

    renderMath(stage);

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

// ---------- 考古报告 Tab（站主示例 / 我的报告） ----------
function renderReportTab(stage) {
  const parts = [];

  // 授权回调着陆提示（展示一次后清除）
  if (appState.oauthLanding) {
    const ok = appState.oauthLanding === 'ok';
    parts.push(`
      <div class="card-paper p-4 mb-4 fade-in ${ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60'}">
        <p class="text-xs ${ok ? 'text-emerald-700' : 'text-red-600'}">${ok ? '✓ 知乎授权成功，可以生成你自己的收藏考古报告了。' : '登录没有完成（可能被取消或会话过期），点右上角「知乎登录」重试。'}</p>
      </div>`);
    appState.oauthLanding = null;
  }

  const authorized = appState.oauth?.authorized;

  // 未登录 CTA
  if (!authorized) {
    parts.push(`
      <div class="card-paper p-5 mb-5 fade-in text-center border-amber-200/80 bg-amber-50/40">
        <p class="text-sm text-stone-700 font-medium mb-1">这是站主的示例报告</p>
        <p class="text-xs text-stone-500 mb-3">登录知乎，看看你自己的收藏人格和 72h 保质期——只读取收藏元数据，不会消耗你的任何额度。</p>
        <a href="/auth/login" class="btn-ink inline-flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg">知乎登录，生成我的考古报告</a>
      </div>`);
  }

  // 已登录：来源切换
  if (authorized) {
    parts.push(`
      <div class="flex items-center gap-2 mb-4 fade-in">
        <div class="flex items-center bg-[#edeae4] p-1 rounded-lg border border-[#e1ded8]">
          <button class="view-toggle-btn ${appState.reportSource === 'mine' ? '' : 'active'}" onclick="window.selectReportSource('site')">站主示例</button>
          <button class="view-toggle-btn ${appState.reportSource === 'mine' ? 'active' : ''}" onclick="window.selectReportSource('mine')">我的报告</button>
        </div>
        ${appState.myReportMeta ? `<span class="text-[10px] text-stone-400 font-mono">${appState.myReportMeta.favlists} 个收藏夹 · ${appState.myReportMeta.requests} 次接口调用${appState.myReportMeta.truncated ? ' · 已达上限截断' : ''}</span>` : ''}
      </div>`);
  }

  const holder = document.createElement('div');

  if (appState.reportSource === 'mine' && authorized) {
    if (appState.myReportLoading) {
      holder.innerHTML = SKELETON;
    } else if (appState.myReportError) {
      holder.innerHTML = `
        <div class="card-paper p-6 text-center fade-in">
          <div class="text-3xl mb-2">🥀</div>
          <p class="text-stone-500 text-sm mb-3">${esc(appState.myReportError)}</p>
          <button class="retry-btn btn-ink px-4 py-2 text-sm" onclick="window.selectReportSource('mine', true)">重试</button>
        </div>`;
    } else if (appState.myReport) {
      renderReportInStage(holder, appState.myReport);
    }
  } else {
    renderReportInStage(holder, appState.report);
  }

  stage.innerHTML = parts.join('');
  stage.appendChild(holder);
}

window.selectReportSource = async function (src, force = false) {
  appState.reportSource = src;
  if (src === 'mine' && appState.oauth?.authorized && (force || (!appState.myReport && !appState.myReportLoading))) {
    appState.myReportLoading = true;
    appState.myReportError = null;
    renderStage();
    try {
      const r = await fetch('/api/my/report').then((resp) => resp.json());
      if (!r.ok) throw new Error(r.error || '我的报告生成失败');
      appState.myReport = r.report;
      appState.myReportMeta = r.meta;
    } catch (e) {
      appState.myReportError = e.message;
    } finally {
      appState.myReportLoading = false;
    }
  }
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
  appState.cardViewMode = 'list';
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
    // queue/cards 是页面核心数据，失败必须让 Promise.all reject 走 showError；
    // report/oauth 属可选增强，允许降级为 null
    const [queue, allCards, report, oauthStatus] = await Promise.all([
      fetchJson('/api/queue'),
      fetchJson('/api/cards?status=approved'),
      fetchJson('/api/report').catch(() => null),
      fetchJson('/api/oauth/status').catch(() => null),
    ]);
    appState.queue = queue;
    appState.allCards = allCards;
    appState.report = report;
    appState.oauth = oauthStatus;

    // 根据 URL hash 决定初始状态；hash 里可能带 ?oauth=ok/error（授权回调着陆），先 strip query 再匹配 tab
    const h = location.hash.slice(1);
    const [tab, query] = h.split('?');
    const oauthResult = new URLSearchParams(query || '').get('oauth');
    if (oauthResult === 'ok' || oauthResult === 'error') {
      appState.oauthLanding = oauthResult;
      // 已登录默认落到「我的报告」
      if (oauthResult === 'ok' && appState.oauth?.authorized) {
        appState.reportSource = 'mine';
        window.selectReportSource('mine');
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

initApp();
