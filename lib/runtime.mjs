// 可变运行产物的唯一目录（Sealos 持久卷挂载点）：订阅/个人卡册/收藏快照/配额全部落在这里，
// 发版换镜像不再丢用户数据。容器内挂卷路径 = /app/data/runtime（ZHSX_RUNTIME_DIR 可覆盖）
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
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
    let dstExists = true;
    try { await access(dst); }
    catch (e) {
      // 只按 ENOENT（目标不存在）继续迁移；其余错误（EACCES 等）告警并跳过，不静默（issue #45）
      if (e.code !== 'ENOENT') {
        console.warn(`[runtime] 目标检查失败（${to}）：${e.message}，跳过迁移`);
        continue;
      }
      dstExists = false;
    }
    if (dstExists) continue;
    try {
      await rename(src, dst);
      console.log(`[runtime] 迁移 ${from} → data/runtime/${to}`);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // 源不存在，跳过
      if (e.code === 'EXDEV') {
        // 跨设备（src 在容器层、dst 在挂载卷）：rename 必然失败，改 复制+删源——原先静默吞掉等于数据丢失（issue #45）
        try {
          await cp(src, dst, { recursive: true });
          await rm(src, { recursive: true, force: true });
          console.log(`[runtime] 迁移 ${from} → data/runtime/${to}（跨设备，复制后删源）`);
        } catch (e2) {
          console.error(`[runtime] 跨设备迁移失败（${from} → ${to}）：${e2.message}，源文件保留未动`);
        }
        continue;
      }
      console.error(`[runtime] 迁移失败（${from} → ${to}）：${e.code || ''} ${e.message}，源文件保留未动`);
    }
  }
}
