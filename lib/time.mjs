// CST（UTC+8）时间处理的单一来源（issue #32）
// 容器时区不可靠，固定按 UTC+8 切日/调度（中国无夏令时）：UTC 字段按 CST 墙钟解读
const CST_OFFSET = 8 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, '0');

// 秒级时间戳 → CST 日期串 yyyy-mm-dd
export function cstFmt(tsSec) {
  const d = new Date(tsSec * 1000 + CST_OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// 当前 CST 日期串（每日台账文件名用，breakdown / 追问 / 推送共用同一切日口径）
export function cstDateStr() {
  return new Date(Date.now() + CST_OFFSET).toISOString().slice(0, 10);
}

// 距下一个 CST 墙钟 hour:00 的毫秒数（每日 08:00 推送调度用）
export function msUntilNextCst(hour) {
  const now = Date.now();
  const cstNow = new Date(now + CST_OFFSET);
  const cstNext = new Date(cstNow);
  cstNext.setUTCHours(hour, 0, 0, 0);
  if (cstNext <= cstNow) cstNext.setUTCDate(cstNext.getUTCDate() + 1);
  return cstNext.getTime() - CST_OFFSET - now;
}
