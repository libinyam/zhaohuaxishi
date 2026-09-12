# 交接文档（新对话接手请读我）

> 最后更新：2026-09-12（预开发完成，冲刺前夕）
> 本文件是给「新会话的 AI 协作者」的启动上下文。读完它 + SPEC.md + README.md 即可接手。

## 一句话状态

核心数据管线已全部完成并验证（93 收藏 → 92 拆解 → 92 卡片 → 盲审 83 过 / 8 幻觉打回），本地 Web 界面可跑。剩余工作全是 9/13-15 冲刺任务：部署、OAuth、推送、追问、海报、演示打磨。

## 已完成 ✅

1. **数据管线**（`scripts/`）：fetch_favorites（93 条落盘）→ breakdown（92 条直答拆解，全部缓存于 `data/cache/zhida/`）→ make_card（92 张卡片于 `data/cache/cards/`）→ blind_review v2（忠实性+核心覆盖；83 approved / 8 rejected 全是数学类幻觉卡 / 1 pending 可补跑）→ report（考古报告数据）
2. **Web 界面 v1**（`server.mjs` + `public/`）：今日复习（队列+打卡）、考古报告、全部卡片（难度筛选、KaTeX 渲染）。`node server.mjs` → http://127.0.0.1:4173/
3. **SPEC.md 已封版**（经三轮外部评审 + 一轮盲审方法论修正）

## 关键环境事实（新会话必须知道）

- **zhihu-cli**：`C:\Users\李斌\AppData\Local\ZhihuCLI\current\zhihu-cli.exe`（Git Bash: `/c/Users/李斌/AppData/Local/ZhihuCLI/current/zhihu-cli.exe`），Access Secret 已配好（系统凭证管理器）
- **Windows 坑①**：官方 skill 脚本硬编码 macOS 路径。`run.ps1` 要用 **pwsh**（不是 powershell）跑；doctor/install 脚本已打补丁（`/usr/bin/unzip`→`unzip`，`/bin/bash`→`bash`）
- **Windows 坑②**：Git Bash 里跑 run.sh 需 `export ZHIHU_CLI_HOME="$(cygpath "$LOCALAPPDATA")/ZhihuCLI"`
- **直答额度**：每日 100 次，全账号共享，当日用量用 `zhihu-cli quota` 查。**铁律：有缓存绝不重新请求**
- **Gemini 中转站**：凭证在 `zhaohuaxishi/.env.local`（已 gitignore，勿提交勿外发）。用法 `set -a && source .env.local && set +a`。可用模型：`gemini-3.8-flash-high`（炼卡+盲审都用它）；`/v1/models` 可列全量
- **LaTeX 转义坑**：Gemini 输出 JSON 时 `\u` 后非十六进制会炸 JSON.parse——make_card.mjs 已有 sanitizer + 重试降级，改 prompt 时保留这层防护
- **盲审方法论**：卡片是「忠实浓缩」，禁止用全文细节考摘要（v1 教训，57 张冤案）；v2 = 幻觉检查 + 核心覆盖

## 剩余任务（冲刺 9/13-15，按优先级）

1. **部署 Sealos**：server.mjs 零改造可跑；拿到公网 HTTPS 域名
2. **OAuth**：9/13 黑客松平台自动发 app_id/app_key（用户账号在 ring/moltbook 空间）。官方脚手架在 `../zhihu-hello/`（基础版，OAuth 版需重新生成，注意 Windows 补丁）。app_key 走安全输入，不进对话不进代码
3. **Server酱推送**：免费 5 条/天（新用户 7 天全功能试用）；每日 3 卡合并 1 条；SendKey 走环境变量 `SCT_SENDKEY`；node-cron 每日 08:00；指数退避重试 3 次 + 死信
4. **追问功能**：卡片详情接直答（`answer` 命令），每用户每日限 2 次（cookie UUID 计数），先查 `data/cache/answers/` 缓存
5. **考古报告海报**：Canvas 生成分享图（收藏人格是主钩子）
6. **演示准备**：用户已答应赛前收藏 3-5 条新内容（72h 黄金期叙事素材）；断网兜底演练；演示脚本按 SPEC「演示叙事」节

## 用户协作偏好

- 中文交流；有外部 AI 评审习惯（会把别家模型的批评贴进来，**先核实再改**，曾驳回过两条不成立的）
- 凭证类一律环境变量/安全输入，不发对话
- 项目同时维护在两个目录：`zhaohuaxishi/`（产品，GitHub 私有库 libinyam/zhaohuaxishi）和 `zhihu-hello/`（官方脚手架）
