// 知乎直答（zhida）OpenAI 兼容接口的共享调用层：
// ask 的随时拆解与 mycard 的炼卡管线共用同一鉴权/解析/错误文案口径。
const ZHIDA_URL = 'https://developer.zhihu.com/v1/chat/completions';

// 失败时抛出用户可读的 Error（mycard 会把 e.message 直接展示给访客）：
// - HTTP 非 2xx：直答服务暂时不可用（HTTP xxx）
// - 响应非 JSON：直答服务返回了无法解析的响应（HTTP xxx）
// - 缺少 choices[0].message.content：直答返回异常（HTTP xxx）
// 网络层错误（超时/连接失败）原样抛出，由调用方决定是否回滚配额。
export async function fetchZhidaAnswer({ apiKey, model, prompt, timeoutMs }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(ZHIDA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  // 真实 Response 走 text() 读体；极简测试桩只有 json() 时兜底
  const bodyText = typeof resp.text === 'function'
    ? await resp.text().catch(() => '')
    : await resp.json().then((p) => JSON.stringify(p)).catch(() => '');
  if (!resp.ok) {
    throw new Error(`直答服务暂时不可用（HTTP ${resp.status}）`);
  }
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(`直答服务返回了无法解析的响应（HTTP ${resp.status}）`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error(`直答返回异常（HTTP ${resp.status}）`);
  }
  return { content: content.trim(), model: payload.model, serverDate: resp.headers?.get?.('date') ?? null };
}
