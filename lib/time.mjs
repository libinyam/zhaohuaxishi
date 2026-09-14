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
  // hour 必须 0..23 整数：NaN/越界会让 setUTCHours 产生 Invalid Date 或静默滚到次日，fail fast（issue #53）
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`msUntilNextCst: hour 必须是 0..23 的整数（收到 ${hour}）`);
  }
  const now = Date.now();
  const cstNow = new Date(now + CST_OFFSET);
  const cstNext = new Date(cstNow);
  cstNext.setUTCHours(hour, 0, 0, 0);
  // 边界取 <：恰好整点启动返回 0（立即触发当次调度），原先 <= 会滚一整天跳过当日调度（issue #53）
  if (cstNext < cstNow) cstNext.setUTCDate(cstNext.getUTCDate() + 1);
  return cstNext.getTime() - CST_OFFSET - now;
}
