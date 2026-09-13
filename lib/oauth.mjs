// 知乎 OAuth（黑客松流程）：会话、state 防 CSRF、token 交换、评委收藏元数据拉取
// 协议依据：zhihu-cli skill 0.7.2 references/hackathon-oauth.md、oauth.md、hackathon-user-profile-api.md、user-api.md
import { randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'zhsx_session';
const SESSION_MAX_AGE = 28800; // 8 小时，对齐官方示例
const STATE_TTL = 10 * 60 * 1000;
// 额度护栏：评委报告只拉元数据，硬上限防止烧穿每日配额
const MAX_REQUESTS = 15;
const MAX_ITEMS = 500;

// Int64 精度坑：uid（/user）和 UrlToken（favlists 记录、收藏内容的 Favlists 简版对象）超 2^53。
// 按字段名定点替换成字符串再 parse——不用裸长数字正则，避免误伤标题/URL 里的长数字
function parseLossless(text) {
  return JSON.parse(text.replace(/"(UrlToken|uid)"\s*:\s*(\d+)/g, '"$1":"$2"'));
}

async function fetchJsonLossless(url, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const text = await resp.text();
  try { return parseLossless(text); }
  catch { throw new Error(`知乎接口返回无法解析的响应（HTTP ${resp.status}）`); }
}

function equal(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieSessionId(req) {
  const item = (req.headers.cookie || '').split(';').map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE_NAME}=`));
  return item ? decodeURIComponent(item.slice(item.indexOf('=') + 1)) : null;
}

export function createOAuth() {
  const sessions = new Map();
  const config = {
    appId: process.env.ZHIHU_OAUTH_APP_ID || '',
    appKey: process.env.ZHIHU_OAUTH_APP_KEY || '',
    accessSecret: process.env.ZHIHU_ACCESS_SECRET || '',
    // 与赛事页面登记值逐字符一致（协议/域名/路径/尾部斜杠），原样使用不做归一化
    redirectUri: process.env.ZHIHU_OAUTH_REDIRECT_URI || 'https://lnuhxmgreuxd.sealoshzh.site/auth/callback',
  };
  const secureCookie = config.redirectUri.startsWith('https:');

  function session(req, res) {
    let id = cookieSessionId(req);
    let current = id ? sessions.get(id) : null;
    if (!current) {
      id = randomBytes(24).toString('base64url');
      current = { id, state: null, stateExpiry: null, token: null, expiresAt: null, profile: null, favCache: null };
      sessions.set(id, current);
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}${secureCookie ? '; Secure' : ''}`);
    }
    return current;
  }

  function authorized(current) {
    if (current.token && current.expiresAt && current.expiresAt <= Date.now()) {
      current.token = null;
      current.profile = null;
      current.favCache = null;
    }
    return Boolean(current.token);
  }

  function status(req, res) {
    const current = session(req, res);
    return {
      configured: Boolean(config.appId && config.appKey),
      authorized: authorized(current),
      profile: authorized(current) ? current.profile : null,
    };
  }

  function loginUrl(req, res) {
    if (!config.appId || !config.appKey) {
      const err = new Error('OAuth 凭证未配置（ZHIHU_OAUTH_APP_ID / ZHIHU_OAUTH_APP_KEY）');
      err.code = 'OAUTH_NOT_CONFIGURED';
      throw err;
    }
    const current = session(req, res);
    current.state = randomBytes(24).toString('base64url');
    current.stateExpiry = Date.now() + STATE_TTL;
    const url = new URL('https://openapi.zhihu.com/authorize');
    url.searchParams.set('redirect_uri', config.redirectUri);
    url.searchParams.set('app_id', config.appId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', current.state);
    return url.toString();
  }

  async function handleCallback(req, res, url) {
    const current = session(req, res);
    const code = url.searchParams.get('authorization_code') || url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const fail = (message, code_) => { throw Object.assign(new Error(message), { code: code_ }); };

    if (!code) fail('回调缺少 authorization_code', 'CODE_MISSING');
    // state 严格校验：缺失 / 不匹配 / 过期一律拒绝；读到过期 state 顺手置 null，不占位
    if (current.stateExpiry && current.stateExpiry <= Date.now()) {
      current.state = null;
      current.stateExpiry = null;
      fail('登录请求已过期，请重新发起', 'STATE_EXPIRED');
    }
    if (!returnedState || !current.state || !equal(returnedState, current.state)) {
      fail('state 校验失败，已拒绝本次登录', 'STATE_MISMATCH');
    }
    // 校验通过：原子消费 state（防重放），再换 token
    current.state = null;
    current.stateExpiry = null;

    const form = new URLSearchParams({
      app_id: config.appId,
      app_key: config.appKey,
      grant_type: 'authorization_code',
      redirect_uri: config.redirectUri,
      code,
    });
    const payload = await fetchJsonLossless('https://openapi.zhihu.com/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    // 成功判据是 access_token 存在（平铺或 data 包裹都兼容）；code:20000 也是成功，不当错误
    const token = payload?.access_token || payload?.data?.access_token || payload?.Data?.access_token;
    if (!token) {
      const data = payload?.data ?? payload?.Data;
      const message = typeof data === 'string' ? data : data?.message || payload?.message || payload?.Message || '未获得 OAuth access token';
      fail(String(message).slice(0, 200), 'TOKEN_EXCHANGE_FAILED');
    }
    const expiresIn = Number(payload?.expires_in ?? payload?.data?.expires_in ?? payload?.Data?.expires_in);
    current.token = token;
    current.expiresAt = Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null;

    // 基础信息接口只用 Bearer token，不需要 Access Secret（hackathon-user-profile-api.md）
    try {
      const profile = await fetchJsonLossless('https://openapi.zhihu.com/user', {
        headers: { Authorization: `Bearer ${token}` },
      });
      // 兼容 code:20000 成功形态；用户不存在等错误表现为 data 字符串
      if (profile && typeof profile === 'object' && (profile.uid || profile.fullname)) {
        current.profile = {
          uid: profile.uid != null ? String(profile.uid) : null,
          name: profile.fullname || null,
          avatarUrl: profile.avatar_path || null,
          headline: profile.headline || null,
        };
      } else {
        console.warn('[oauth] /user 响应缺少用户标识:', JSON.stringify(profile).slice(0, 200));
        current.profile = null;
      }
    } catch (e) {
      console.warn('[oauth] /user 拉取失败（不阻断登录）:', e.message);
      current.profile = null;
    }
  }

  function logout(req, res) {
    const current = session(req, res);
    current.token = null;
    current.expiresAt = null;
    current.profile = null;
    current.favCache = null;
    current.state = null;
    current.stateExpiry = null;
  }

  // 用户数据接口三件套：Access Secret + X-OAuth-Token + 时间戳
  async function userApi(endpoint, query, token) {
    const url = `https://developer.zhihu.com${endpoint}?${new URLSearchParams(query)}`;
    const payload = await fetchJsonLossless(url, {
      headers: {
        Authorization: `Bearer ${config.accessSecret}`,
        'X-OAuth-Token': token,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    });
    if (payload?.Code !== 0) {
      const err = new Error(String(payload?.Message || `用户数据接口失败 Code=${payload?.Code}`).slice(0, 200));
      err.code = payload?.Code === 30002 ? 'QUOTA_EXCEEDED' : 'USER_API_FAILED';
      throw err;
    }
    return payload?.Data || {};
  }

  // 拉评委收藏元数据：favlists（无分页，Limit 50）→ 逐收藏夹 favlist_contents 翻页
  // 硬上限 MAX_REQUESTS 次请求 / MAX_ITEMS 条，按会话缓存，不重复烧量
  async function fetchMyFavorites(req, res) {
    const current = session(req, res);
    if (!authorized(current)) throw Object.assign(new Error('请先完成知乎授权'), { code: 'LOGIN_REQUIRED' });
    if (!config.accessSecret) throw Object.assign(new Error('评委报告功能未就绪（服务端缺少 ZHIHU_ACCESS_SECRET 配置）'), { code: 'ACCESS_SECRET_MISSING' });
    if (current.favCache) return current.favCache;

    let requests = 0;
    const items = [];
    const seen = new Set();
    const favlistsData = (requests++, await userApi('/api/v1/user/favlists', { Limit: '50' }, current.token));
    const favlists = Array.isArray(favlistsData?.Items) ? favlistsData.Items : [];

    for (const list of favlists) {
      if (requests >= MAX_REQUESTS || items.length >= MAX_ITEMS) break;
      if (list.UrlToken == null) continue;
      let offset = '0';
      for (;;) {
        if (requests >= MAX_REQUESTS || items.length >= MAX_ITEMS) break;
        const data = (requests++, await userApi('/api/v1/user/favlist_contents', {
          FavlistUrlToken: String(list.UrlToken), Offset: offset, Limit: '50',
        }, current.token));
        for (const it of data?.Items || []) {
          if (it.Url && !seen.has(it.Url)) { seen.add(it.Url); items.push(it); }
        }
        const paging = data?.Paging;
        if (!paging || paging.IsEnd !== false || !paging.NextOffset) break;
        offset = String(paging.NextOffset);
      }
    }

    current.favCache = { items, meta: { requests, favlists: favlists.length, truncated: requests >= MAX_REQUESTS || items.length >= MAX_ITEMS } };
    console.log(`[oauth] 评委收藏拉取完成：${items.length} 条，${requests} 次请求${current.favCache.meta.truncated ? '（达上限截断）' : ''}`);
    return current.favCache;
  }

  return { status, loginUrl, handleCallback, logout, fetchMyFavorites };
}
