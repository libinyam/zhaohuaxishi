// 前端共享工具（issue #32：esc / 卡片分类的单一来源，零构建，普通 script 标签先加载）
/* eslint-disable no-unused-vars */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 白板分区：按话题标签 + 标题归类，分类正则只此一处
function categorizeCard(c) {
  const text = (c.topicTags || []).join(' ') + ' ' + (c.source?.title || '');
  if (/数学|代数|微积分|几何|数论|竞赛|分析|方程|极限|级数|拓扑/.test(text)) return 'math';
  if (/人际|心理|送礼|哲学|文学|九州|历史|社会|关系|生活/.test(text)) return 'humanities';
  if (/编程|算法|代码|Python|CS|开发|架构|软件|AI|大模型/.test(text)) return 'tech';
  if (/思维|成长|学习|复利|方法|习惯|效率|认知|模型/.test(text)) return 'growth';
  return 'other';
}
