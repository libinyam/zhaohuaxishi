# 交接文档（新对话接手请读我）

> 最后更新：2026-09-12 晚（已上线 Sealos，公网可访问）
> 本文件是给「新会话的 AI 协作者」的启动上下文。读完它 + SPEC.md + README.md 即可接手。

## 一句话状态

核心数据管线已全部完成并验证（93 收藏 → 92 拆解 → 92 卡片 → 盲审 83 过 / 8 幻觉打回），本地 Web 界面可跑。剩余工作全是 9/13-15 冲刺任务：部署、OAuth、推送、追问、海报、演示打磨。

## 已完成 ✅

1. **数据管线**（`scripts/`）：fetch_favorites（93 条落盘）→ breakdown（92 条直答拆解，全部缓存于 `data/cache/zhida/`）→ make_card（92 张卡片于 `data/cache/cards/`）→ blind_review v2（忠实性+核心覆盖；83 approved / 8 rejected 全是数学类幻觉卡 / 1 pending 可补跑）→ report（考古报告数据）
2. **Web 界面 v1**（`server.mjs` + `public/`）：今日复习（队列+打卡）、考古报告、全部卡片（难度筛选、KaTeX 渲染）。`node server.mjs` → http://127.0.0.1:4173/
3. **SPEC.md 已封版**（经三轮外部评审 + 一轮盲审方法论修正）
4. **Sealos 部署已上线**：`https://lnuhxmgreuxd.sealoshzh.site`（全 API 已验证）。镜像 `ccr.ccs.tencentyun.com/zhaohuaxishi/zhaohuaxishi:0.1.0`（腾讯云 TCR 个人版免费，仓库**公有**——镜像内无密钥可放心；密钥走环境变量）。Dockerfile 在仓库根目录，改代码后：`docker build -t zhaohuaxishi:<版本> .` → tag → push → Sealos 变更镜像版本。注意：打卡状态写容器本地文件，Sealos 重启容器会重置（演示期可接受）

5. **Server酱推送已上线**（镜像 0.2.0）：每日 08:00（UTC+8，自研零依赖调度替代 node-cron——保持镜像无 npm 依赖）三卡合并 1 条微信推送；1s/5s/25s 退避重试 3 次 + `data/push-deadletter.jsonl` 死信；推送日期落盘 `data/push-state.json` 防容器重启重推（两个运行产物已 gitignore）。手动触发：`POST /api/push/trigger` + 请求头 `x-push-token: $PUSH_TRIGGER_TOKEN`（演示日现场点给评委看微信震动）。Sealos 环境变量已配 `SCT_SENDKEY` / `PUSH_TRIGGER_TOKEN`；本地起服务用 `node --env-file=.env.local server.mjs`（**注意：本地和 Sealos 同时跑会双推，本地测完就关**）。9/12 晚实测推送成功

## 关键环境事实（新会话必须知道）

- **zhihu-cli**：`C:\Users\李斌\AppData\Local\ZhihuCLI\current\zhihu-cli.exe`（Git Bash: `/c/Users/李斌/AppData/Local/ZhihuCLI/current/zhihu-cli.exe`），Access Secret 已配好（系统凭证管理器）
- **Windows 坑①**：官方 skill 脚本硬编码 macOS 路径。`run.ps1` 要用 **pwsh**（不是 powershell）跑；doctor/install 脚本已打补丁（`/usr/bin/unzip`→`unzip`，`/bin/bash`→`bash`）
- **Windows 坑②**：Git Bash 里跑 run.sh 需 `export ZHIHU_CLI_HOME="$(cygpath "$LOCALAPPDATA")/ZhihuCLI"`
- **直答额度**：每日 100 次，全账号共享，当日用量用 `zhihu-cli quota` 查。**铁律：有缓存绝不重新请求**
- **Gemini 中转站**：凭证在 `zhaohuaxishi/.env.local`（已 gitignore，勿提交勿外发）。用法 `set -a && source .env.local && set +a`。可用模型：`gemini-3.8-flash-high`（炼卡+盲审都用它）；`/v1/models` 可列全量
- **LaTeX 转义坑**：Gemini 输出 JSON 时 `\u` 后非十六进制会炸 JSON.parse——make_card.mjs 已有 sanitizer + 重试降级，改 prompt 时保留这层防护
- **盲审方法论**：卡片是「忠实浓缩」，禁止用全文细节考摘要（v1 教训，57 张冤案）；v2 = 幻觉检查 + 核心覆盖

## 剩余任务（冲刺 9/13-15，按优先级）

1. ~~部署 Sealos~~ ✅ 已完成（见上）
2. **OAuth**：代码已完成（镜像待打包 0.3.0，**线上联调待做**）。9/13 10:00 作品提交窗口开放后队长在活动页（`https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2`）队伍详情「创建项目」拿到 app_id/app_key。实现：`lib/oauth.mjs`（会话 Map + state 严格校验原子消费 + token 交换 + 评委收藏元数据拉取，硬上限 15 请求/500 条）+ `lib/report-core.mjs`（报告核心抽纯函数，固定 UTC+8，空收藏有空态）+ server.mjs 路由 `/auth/login`、`/auth/callback`、`/api/oauth/status`、`/api/oauth/logout`、`/api/my/report` + 前端登录按钮/我的报告切换。环境变量 4 个：`ZHIHU_OAUTH_APP_ID`（公开）/`ZHIHU_OAUTH_APP_KEY`/`ZHIHU_ACCESS_SECRET`/`ZHIHU_OAUTH_REDIRECT_URI`（默认 sealoshzh 回调，与赛事页登记逐字符一致含尾部斜杠）。**关键协议事实**：回调参数是 `authorization_code`（换 token 表单字段仍叫 `code`）；黑客松服务已支持 state 透传（旧文档「不回 state」作废）；`/user` 只用 Bearer token 不要 Access Secret；`uid` 和 `UrlToken` 都是 Int64——响应统一走按字段名定点替换的 lossless 解析（`"(UrlToken|uid)"`），裸长数字正则会误伤标题；`code:20000` 是成功；favlists 接口无分页（Limit 50 封顶）。新 skill 包在 `../zhihu-cli-skill-0.7.2-beta.20260911131715.zip`，解压于 `../.tmp/zhihu-cli-skill-0.7.2/`。本地已验证：全路由行为正确、state 拒绝/过期、回归无损（本地验证后**本地服务已关停**，防与 Sealos 双推）。上线步骤：`.env.local` 补 4 个变量（用户亲手贴 key）→ docker build 0.3.0 → push TCR → Sealos 换镜像 + 配同样 4 个环境变量 → 真实授权联调（checklist 见会话计划：登记值逐字符核对、本人点授权、quota 记录、坏 state 拒绝、ACCESS_SECRET 缺失文案）
3. ~~Server酱推送~~ ✅ 已完成（见「已完成」第 5 条）
4. **追问功能**：卡片详情接直答（`answer` 命令），每用户每日限 2 次（cookie UUID 计数），先查 `data/cache/answers/` 缓存
5. **考古报告海报**：Canvas 生成分享图（收藏人格是主钩子）
6. **演示准备**：用户已答应赛前收藏 3-5 条新内容（72h 黄金期叙事素材）；断网兜底演练；演示脚本按 SPEC「演示叙事」节

## 用户协作偏好

- 中文交流；有外部 AI 评审习惯（会把别家模型的批评贴进来，**先核实再改**，曾驳回过两条不成立的）
- 凭证类一律环境变量/安全输入，不发对话
- 项目同时维护在两个目录：`zhaohuaxishi/`（产品，GitHub 私有库 libinyam/zhaohuaxishi）和 `zhihu-hello/`（官方脚手架）
