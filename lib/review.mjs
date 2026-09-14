// 站长卡片复习进度：间隔 +1/+3/+7 天，3 次后 digested（与用户卡册同口径，见 lib/mycard.mjs）
// 从 server.mjs 抽出（issue #43）：默认分支要求登录后，未配置 OAuth 的环境走不到 HTTP 成功路径，下沉 lib 便于单测
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const DAY = 86400;
const INTERVALS = [1 * DAY, 3 * DAY, 7 * DAY]; // 复习间隔：+1/+3/+7 天后 digested

export function createReview(root) {
  const cardsDir = path.join(root, 'data', 'cache', 'cards');

  // 卡片不存在时 readFile 抛 ENOENT，由 server.mjs 分发层统一映射 404
  async function markReviewed(id) {
    const file = path.join(cardsDir, `${id}.json`);
    const card = JSON.parse(await readFile(file, 'utf8'));
    card.reviewCount = (card.reviewCount ?? 0) + 1;
    const now = Math.floor(Date.now() / 1000);
    if (card.reviewCount >= 3) {
      card.status = 'digested';
      card.nextReviewAt = null;
    } else {
      card.nextReviewAt = now + INTERVALS[card.reviewCount - 1];
    }
    const tmp = file + '.tmp';
    await writeFile(tmp, JSON.stringify(card, null, 2));
    await rename(tmp, file);
    return card;
  }

  return { markReviewed };
}
