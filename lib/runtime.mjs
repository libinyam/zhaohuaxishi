// 可变运行产物的唯一目录（Sealos 持久卷挂载点）：订阅/个人卡册/收藏快照/配额全部落在这里，
// 发版换镜像不再丢用户数据。容器内挂卷路径 = /app/data/runtime（ZHSX_RUNTIME_DIR 可覆盖）
import { access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';

export function runtimeDir(root) {
  return process.env.ZHSX_RUNTIME_DIR || path.join(root, 'data', 'runtime');
}

// 老位置 → data/runtime/ 一次性迁移（目标已存在则不动；容器镜像内本无这些文件，主要保本地/旧部署平滑过渡）
export async function migrateRuntime(root) {
  const rt = runtimeDir(root);
  const moves = [
    ['data/push-state.json', 'push-state.json'],
    ['data/push-subscriptions.json', 'push-subscriptions.json'],
    ['data/push-deadletter.jsonl', 'push-deadletter.jsonl'],
    ['data/quota', 'quota'],
    ['data/cache/mycards', 'mycards'],
    ['data/cache/favs', 'favs'],
  ];
  await mkdir(rt, { recursive: true });
  for (const [from, to] of moves) {
    const src = path.join(root, from);
    const dst = path.join(rt, to);
    try { await access(dst); continue; } catch { /* 目标不存在才迁移 */ }
    try {
      await rename(src, dst);
      console.log(`[runtime] 迁移 ${from} → data/runtime/${to}`);
    } catch { /* 源不存在，跳过 */ }
  }
}
