// Gemini 中转站调用与模型输出解析的单一来源（issue #32：make_card / blind_review 共用）
// 各脚本差异只在 model / temperature，通过参数传入；行为与原内联实现一致
export function createGeminiChat({ base, key, model, temperature }) {
  return async function chat(prompt) {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature }),
    });
    if (!resp.ok) throw new Error(`gemini http ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    return data.choices[0].message.content;
  };
}

// 模型输出常见杂质：markdown 代码围栏、LaTeX 非法转义（如 \l、\utilde）
// 去围栏后先直解，失败则把非法反斜杠补成双写兜底
export function parseLlmJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* 转义非法时走兜底修复 */ }
  return JSON.parse(cleaned.replace(/\\(?!["\\/bfnrt]|u[0-9a-fA-F]{4})/g, '\\\\'));
}
