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
- **P3 加固批次（9/13 晚，#30/#32-#35）**：① 路由表驱动（`ROUTES`，server.mjs），方法白名单自动推导；handler 抛带 `code` 的错误由分发层统一映射（ENOENT→404 / LOGIN_REQUIRED→401 / ACCESS_SECRET_MISSING→503）；**分发必须 `return await handler()`，省掉 await 异步异常会逃出 try/catch 崩进程**。② 单实例假设：OAuth 会话在进程内存、配额/推送状态落盘 JSON——多实例部署或重启保活前需会话外置（Redis/持久卷）。③ 前端依赖全部 vendor 化进 `public/vendor/`（Tailwind 运行时 + KaTeX 0.16.11 含 20 个 woff2 字体，共 ~1MB，Dockerfile 整体 COPY public 自动进镜像）；**中文 webfont（fontsource/Google Fonts）已放弃**，SC 字体按 unicode-range 拆成上百个子集，vendor 复杂度太高，CSS 里本就有系统字体栈兜底（Songti/PingFang/雅黑），视觉差异可接受。④ 重复代码收敛：`lib/gemini.mjs`（chat+parseLlmJson，make_card/blind_review/mycard 共用；9/13 晚从 scripts/lib/ 上移到 lib/——Dockerfile 与 e2e 副本不含 scripts/，server 侧 import 会崩）、`lib/time.mjs`（CST 切日三函数，server/ask/report-core/breakdown 共用）、`public/shared.js`（esc+categorizeCard，app.html 先于 app.js 加载）。⑤ `/api/cards` 不再下发 `reviewDetail`（管线内部字段，响应瘦身 ~30%）。⑥ `/api/review` body 上限 1e6（413），`/api/ask` 4096，统一走 `readBody()` 超限断累积但继续排空
- **回归入口**：`node scripts/test-e2e.mjs`（隔离副本跑全量断言，28 用例；`--stress` 加 600 次会话淘洗压测）
- **匿名脱敏（9/14，镜像 0.7.1，#38；9/14 加强，#43）**：未登录访客的 `/api/report` 只回聚合数字（`sanitized:true`，无 persona/oldestItem/cards）。#38 温和版只剥离 `authorFollowed`/`authorAvatar`；**#43 加强版（应站主要求）**：`/api/cards` 匿名限量 6 张示例（`sanitized:true`，`total` 仍为全量数），`/api/cards`、`/api/queue` 匿名再剥离 `source.url`/`source.favTime`（原文链接+收藏时间），前端 `cardHtml` 无 url 时标题渲染纯文本、不显示「收藏于」，白板头加「公开示例已脱敏」徽标。卡片标题与拆解内容本身是 demo 主体，仍保留公开。前端按字段条件隐藏人格画像/领域分布/最老收藏/海报按钮，侧栏知识空间分组仅登录可见；landing 卡片墙的「关注作者」标注对匿名回退为「作者」属正常
- **版本号对齐（9/14 凌晨）**：TCR 上的 `0.8.0` 是另一 agent 从 commit `1d32a6b` 构建的（已逐文件比对，内容与该 commit 完全一致），**不含**匿名脱敏、#38-#42 加固、scope=mine——版本号虚高。勿用 0.8.0。最新：`0.9.3`（9/14 上午推送，= 本地未提交工作区：订阅推送个人化 + 每日自动炼卡 + 顶栏蓝色登录按钮 + 运行产物归拢 data/runtime/ + 今日复习内联炼卡入口 + 未登录工作台「站主示例」横幅，e2e 30 PASS，冒烟通过）

## 剩余任务（冲刺 9/13-15，按优先级）

1. ~~部署 Sealos~~ ✅ 已完成（见上）
2. **OAuth**：✅ 已完成并线上联调通过（镜像 0.3.0，9/13 上午）。9/13 10:00 作品提交窗口开放后队长在活动页（`https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2`）队伍详情「创建项目」拿到 app_id/app_key。实现：`lib/oauth.mjs`（会话 Map + state 严格校验原子消费 + token 交换 + 评委收藏元数据拉取，硬上限 15 请求/500 条）+ `lib/report-core.mjs`（报告核心抽纯函数，固定 UTC+8，空收藏有空态）+ server.mjs 路由 `/auth/login`、`/auth/callback`、`/api/oauth/status`、`/api/oauth/logout`、`/api/my/report` + 前端登录按钮/我的报告切换。环境变量 4 个（本地 `.env.local` + Sealos 均已配）：`ZHIHU_OAUTH_APP_ID`（407，公开）/`ZHIHU_OAUTH_APP_KEY`/`ZHIHU_ACCESS_SECRET`/`ZHIHU_OAUTH_REDIRECT_URI`（与赛事页登记逐字符一致）。**联调结论**：用户本人完整授权通过，profile 正确（uid 19 位无损）；「我的报告」现场生成成功，2 收藏夹 / 5 次 user_data 调用；当日 user_data 总耗 8 次（余 9992），直答零消耗；伪造/缺失 state 线上均被拒（302 → `?oauth=error`）。**关键协议事实**：回调参数是 `authorization_code`（换 token 表单字段仍叫 `code`）；黑客松服务已支持 state 透传（旧文档「不回 state」作废）；`/user` 只用 Bearer token 不要 Access Secret；`uid` 和 `UrlToken` 都是 Int64——响应统一走按字段名定点替换的 lossless 解析（`"(UrlToken|uid)"`），裸长数字正则会误伤标题；`code:20000` 是成功；favlists 接口无分页（Limit 50 封顶）。新 skill 包在 `../zhihu-cli-skill-0.7.2-beta.20260911131715.zip`，解压于 `../.tmp/zhihu-cli-skill-0.7.2/`。注意：会话存容器内存，Sealos 重启后用户需重新登录（演示期可接受）
3. ~~Server酱推送~~ ✅ 已完成（见「已完成」第 5 条）
4. **追问功能**：✅ 已完成并线上验证通过（镜像 0.4.0，9/13 中午）。实现：`lib/ask.mjs`（限流+缓存+直答 HTTP 调用）+ server.mjs 路由 `POST /api/ask`、`GET /api/ask/quota` + 前端卡片详情底部「追问这张卡」输入框。要点：容器内没有 zhihu-cli，直答走 HTTP API `POST developer.zhihu.com/v1/chat/completions`（Bearer Access Secret + X-Request-Timestamp），模型 `zhida-fast-1p5`（演示延迟 ~5s，别用 thinking）；身份只认 OAuth 知乎 uid（issue #36 安全修复：自报 `X-ZHSX-UID` 头 / 匿名 cookie 可被轮换刷配额，已关闭，未登录追问/查额度一律 401 `loginRequired`，前端追问框收起输入框改为登录引导）；每用户每日 2 次 + 每出口 IP 每日 20 次硬顶（`X-Forwarded-For` 取最后一跳——首值可被伪造轮换，issue #47 修复；回退 socket；台账加 `ips` 字段，读-改-写用 Promise 链串行化；上游失败回滚计数不烧用户额度，issue #44），计数与 breakdown 台账共用 `data/quota/<yyyy-mm-dd>.json`（加 `asks` 字段，向后兼容）；缓存 key = sha256(cardId + 规范化问题)，规范化=去空白去标点转小写——**按卡片隔离防「为什么」跨卡串答案**；缓存命中不占用户 2 次也不烧直答额度；方法白名单已从手工 `POST_ROUTES` 改为路由表自动推导（#33），新增写端点往 `ROUTES` 表加 `{ method: 'POST', ... }` 即可。实测：真实直答 ~5s 出答案、缓存命中、标点变体归一化命中、第 3 次 429、用户间隔离、线上用户实测通过。注意：Git Bash 里 curl 带中文会被 GBK 转码，测中文接口要用 node 发请求，别当 bug 查
5. **考古报告海报**：✅ 已实现并上线（镜像 0.5.0，9/13 下午）。纯前端 Canvas（`public/app.js` 的 `drawPoster`，750×1180@2x，收藏人格大标题+三宫格+年代分布条+最老收藏+footer），报告页底部「📮 生成分享海报」按钮，弹层展示+PNG 下载，零服务端零额度消耗。线上接口回归全过（health/report/quota/oauth status），app.js 1111 行完整版已确认在线。**教训**：写 app.js 时曾误用 Write 覆盖模式冲掉整个文件，靠 `git checkout HEAD -- public/app.js` 恢复后再 Edit 回补追问+海报代码——改这个文件只用 Edit，永远不用 Write
6. **演示准备**：✅ 素材与缓存已就绪（9/13 下午，镜像 0.5.1）。用户当天新收藏 17 条，管线全量重跑：110 收藏 → 16 新拆解 → 16 新卡盲审 16/16 PASS → 报告重生（burstMonth=2026-09 共 17 条，72h 黄金期叙事完美成型）。追问缓存已预热 12 条（线上+本地双份）：主演示卡=《芬尼根的守灵夜》`card_answer_2076765585652896764`（现场问法固定为「这本书讲了什么」，另有「为什么这本书难翻译」「值得读吗」两个变体），其余 9 张新卡各预热「这篇讲了什么」；预热脚本 `.tmp/preheat-ask.mjs`（改 BASE 即切线上/本地）。**关键**：ask 缓存存容器/本地文件系统不打进镜像——Sealos 重启或换镜像后线上缓存丢失，须用脚本重跑预热；本地兜底机重启不丢。今日额度：拆解 31/100。剩余：断网兜底演练（本地离线完整走 1 遍）、提交材料（截止 9/15 10:00）
7. **现场炼卡 + 报告页去站主示例**（9/13 晚）：登录用户可把自己的收藏现场炼成卡片。实现：`lib/mycard.mjs`（scripts 三道工序适配为 server 内异步任务：直答拆解 → Gemini 炼卡 → 盲审，prompt/模型照抄 scripts，拆解用 `zhida-thinking-1p5`、HTTP 超时 120s，炼卡 `GEMINI_MODEL_FLASH`、盲审 `GEMINI_MODEL_PRO`）+ server.mjs 路由 `POST/GET /api/my/card` + 前端报告页炼卡卡片位（2s 轮询、3 分钟超时、分阶段进度）。限流：每用户每天 1 张（仅成功计入，失败/盲审打回可重试），全站每天 20 张先到先得——任务发起即写台账 `data/quota/<date>.json` 的 `mycards` 字段，失败不退（防刷）；结果落盘 `data/cache/mycards/<uid>.json`，同天重复请求直接返回缓存。盲审打回即任务失败（诚实提示，不出卡）。**Sealos 部署必须补环境变量 `GEMINI_BASE_URL` / `GEMINI_API_KEY`**（另两个模型变量可选，有默认值），缺失时接口返回 503「功能未就绪」不 crash。注意：mycard 与 ask 各自持台账锁，并发极端场景理论上有丢计可能（演示体量可接受）；zhida 拆解命中 `data/cache/zhida/` 缓存时不烧直答额度。报告页产品改动：已授权用户不再出现「站主示例/我的报告」切换，直接只显示我的报告（含炼卡入口）；未登录路径不变（站主示例 + 登录 CTA）

8. **我的卡册 scope=mine**（9/14 凌晨，镜像 0.7.2）：登录后队列/白板只展示用户自己的卡片，站长示例完全不可见。实现：mycard 落盘改历史卡册（`<uid>.json` 加 `cards` 数组，approved 按 id 去重累积封顶 50，导出 `listCards`/`markReviewed`）；`/api/cards`、`/api/queue` 加 `?scope=mine`（未登录 401 loginRequired），`POST /api/review` body 加 `scope:'mine'` 走用户独立复习进度（**绝不动站长卡片**——同一收藏两边可能各有一张同 id 卡）；默认分支（站长卡片）issue #43 起关闭匿名写入、一律 401 loginRequired（匿名访客打卡由前端降级为纯本地生效，站长卡复习逻辑抽在 `lib/review.mjs` 便于单测），`/api/ask` 站卡未命中时兜底查用户卡册；前端 initApp 先拉 oauth status 再决定数据源（`appState.scope`），空态 CTA 引导去考古报告炼卡，炼卡 done 后 `refreshMineQueue()` 自动刷新，退出登录调 initApp 重拉站主数据。landing 页不调 scope=mine（公开展示面保持站长内容）。e2e 27 PASS

9. **订阅推送改个人队列**（9/14 上午）：订阅者推送从「跟站长同一份全站卡」改为「每人推自己卡册（mycard 台账）的今日队列」——`pushDailyCards` 内逐 uid `buildQueue(mycard.listCards(uid))`，有到期卡推自己的卡（最多 3 张），没有则发一条炼卡提醒（链到 `app.html#report`）；个人卡册读取/发送单点失败记死信不中断他人。站长 env SENDKEY 通道不变（全站卡库本来就是站长个人收藏的离线炼卡产物）。站长队列为空不再整体早退，只跳过站长通道；cron 落盘条件从 `pushed>0` 改为 `ownerOk`（含「空队列跳过」），防「站长空队列+有订阅者」时容器重启重推订阅者。消息组装抽 `cardsMsg()` 共用。前端订阅卡片文案与订阅成功测试消息同步更新。e2e 27 PASS（推送链路需真实 Server酱，线上手动 trigger 验证）

10. **每日自动炼卡**（9/14 上午）：订阅用户无需每天手动炼卡。背景：知乎 OAuth 无 refresh token、token 短命且会话在内存，跑批时拉不了用户收藏——但炼卡三工序里只有「拉收藏列表」要用户 token（直答拆解走站点 Access Secret，炼卡/盲审走 Gemini），故改为**收藏快照**制：用户拉收藏的三处（`/api/my/report`、`/api/my/card`、`/api/push/subscribe` 成功后）把收藏元数据落盘 `data/cache/favs/<uid>.json`（保留 `tried` 标记），每日 07:00（`scheduleAutoMake`，赶在 08:00 推送前）逐订阅用户 `mycard.autoMake(uids)`：从快照挑未炼过的（按卡册历史 source.url 去重 + `tried` 3 天免重试，含盲审打回），串行走 runJob 完整管线。配额独立：台账 `auto` 字段（每用户 3 张/天、全站 30 张/天，`MYCARD_AUTO_GLOBAL_CAP` 可覆盖），发起即计；`via:'auto'` 落盘不当「今日已炼」，不挡手动入口（statusFor/startInner 闸门只看 manual）。手动 pickFavorite 同步加历史去重（不再同日重复炼同一条）。直答日阈值（ZHIDA_THROTTLED，ensureBreakdown 抛 code）与全站自动上限 = 全局停跑信号；与手动入口撞车（inflight）自动让路。e2e 29 PASS（新增自动炼卡单元：快照/上限/独立性/exhausted/tried 窗口）。**部署提醒**：Sealos 需确认 `GEMINI_BASE_URL`/`GEMINI_API_KEY` 已配（自动炼卡无 Gemini 直接跳过）

11. **运行产物归拢 data/runtime/ + 今日复习炼卡入口**（9/14 上午，镜像 0.9.2）：发版不再丢用户数据——订阅台账/个人卡册/收藏快照/配额/推送状态统一落 `data/runtime/`（新模块 `lib/runtime.mjs`：`runtimeDir(root)`，`ZHSX_RUNTIME_DIR` 可覆盖；`migrateRuntime(root)` 启动时把老位置 `data/quota`、`data/cache/mycards|favs`、`data/push-*` 一次性搬入，目标已存在不覆盖，先于调度器执行）。改造面：server.mjs（push 三件套路径）、mycard（quota/mycards/favs）、ask（quota）、scripts/breakdown（quota，与服务端共用直答台账，脚本侧同步改防分裂）。`.gitignore`/`.dockerignore` 收敛为 `data/runtime/` 一条。**Sealos 部署必须挂持久卷到 `/app/data/runtime`**，否则回到发版即丢的老状态；注意卷写权限——容器以 node 用户跑，卷若 root 不可写需在 Sealos 侧放开。zhida/answers 缓存不动（内容寻址可再生，且有提交基线）。前端：今日复习空态（登录但无卡）直接内联炼卡卡片位（复用 `myCardSlotHtml` + `bindMyCardSlot` + `fetchMyCardStatus`，报告页入口保留）。e2e 30 PASS（新增 runtime 迁移用例）

## 用户协作偏好

- 中文交流；有外部 AI 评审习惯（会把别家模型的批评贴进来，**先核实再改**，曾驳回过两条不成立的）
- 凭证类一律环境变量/安全输入，不发对话
- 项目同时维护在两个目录：`zhaohuaxishi/`（产品，GitHub 私有库 libinyam/zhaohuaxishi）和 `zhihu-hello/`（官方脚手架）
