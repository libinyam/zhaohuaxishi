# 朝花夕拾

> 知乎黑客松 2026 校园新锐季 · 学习工具与知识生产赛道
> 早上的花，傍晚拾——趁你的收藏还没凉透。

**朝花夕拾**是一个「收藏夹消化引擎」：在你收藏兴趣的 72 小时黄金期内，把知乎收藏自动拆解成 2 分钟可读完的学习卡片，并通过微信提醒主动推给你。

## 为什么做

知乎收藏夹的三个真实死因：

1. **太长了，不想读** → 卡片化：一次 2 分钟，脉络 + 要点 + 金句
2. **太难了，读不懂** → 讲解层：AI 把内容重述成人话，理科保留公式和推导路径
3. **忘了要看** → 主动触达：每日 3 张卡片，微信提醒

核心产品假设：**收藏的兴趣有 72 小时保质期**，趁热消化转化率最高。

## 工作原理

```
知乎收藏夹 (zhihu-cli 官方接口)
  → ① 知乎直答拆解    官方 RAG 阅读全文，输出论证结构拆解（事实层）
  → ② Gemini 炼卡     整理成分型卡片：理科带公式脉络 / 观点带交锋结构（表达层）
  → ③ 盲审门禁        忠实性检查（防幻觉）+ 核心覆盖检查（防漏重点）
  → ④ 人工终审        品味把关
  → 每日 3 张复习卡片 + Server酱微信提醒
```

分工铁律：**直答提供事实（唯一能合法读知乎全文的途径），Gemini 提供手艺（格式化与质检，不接触知乎原文）。**

## 卡片长什么样

每张卡片包含：核心观点、**讲解脉络**（作者怎么一步步把你讲懂的）、关键洞察（理科含 LaTeX 公式）、3 个要点、金句、难度标签、原文链接（导流回知乎）。

## 项目进度

- [x] 数据管线：93 条收藏全量落盘（官方 CLI，纯元数据 + 摘要）
- [x] 直答拆解：92 条全部完成，全部落盘缓存（每日 100 次额度当稀缺资源设计）
- [x] 炼卡管线：分型卡片模板（理科 / 观点），92 张卡片全量炼成
- [x] 盲审门禁 v2：忠实性 + 核心覆盖双重检查
- [x] 收藏考古报告引擎：收藏人格、衰减曲线、领域分布（纯元数据，零接口消耗）
- [ ] Web 界面（报告页 / 卡片流 / 复习队列）
- [ ] Server酱微信推送（每日 08:00，node-cron 调度）
- [ ] Sealos 部署 + OAuth 评委体验（9/13 凭证到位后）

## 目录结构

```
├── SPEC.md                 # 产品与技术规格（经三轮评审修订）
├── scripts/
│   ├── fetch_favorites.mjs # 全量拉取收藏（favlists → favlist_contents 分页）
│   ├── breakdown.mjs       # 直答拆解（缓存铁律：同一收藏永不重复请求）
│   ├── make_card.mjs       # Gemini 炼卡（分型模板，Schema 校验）
│   ├── blind_review.mjs    # 盲审门禁 v2（忠实性 + 核心覆盖）
│   └── report.mjs          # 收藏考古报告（纯元数据）
└── data/
    ├── favorites.json      # 全量收藏快照
    ├── report.json         # 考古报告数据
    └── cache/
        ├── zhida/          # 直答拆解缓存（核心资产）
        ├── cards/          # 炼好的卡片（含盲审结果）
        └── answers/        # 追问缓存
```

## 设计原则

- **只用官方开放能力**：不爬数据，原文回流知乎，对平台是正向循环
- **额度当稀缺资源**：所有响应落盘缓存，同一内容永不重复请求
- **诚实是卖点**：卡片角标声明「拆解自该问题下的优质讨论」；盲审防幻觉
- **可断点续跑**：一切中间产物落盘，任何步骤中断后重跑自动续接

## 本地运行

```bash
# 配置 Gemini 中转站（.env.local，已 gitignore）
GEMINI_BASE_URL=https://your-relay/v1
GEMINI_API_KEY=your-key

# 指定 zhihu-cli 可执行文件路径（拉收藏/直答拆解需要，且需已配置 Access Secret）
# 方式一：写进 .env.local（推荐，随 --env-file 一并加载）
#   ZHIHU_CLI=C:\Users\...\AppData\Local\ZhihuCLI\current\zhihu-cli.exe
# 方式二：会话内 export
#   export ZHIHU_CLI=/path/to/zhihu-cli

# 数据管线（--env-file 要求 Node ≥ 20.6；export 方式则无需 --env-file）
node --env-file=.env.local scripts/fetch_favorites.mjs   # 拉取收藏
node --env-file=.env.local scripts/breakdown.mjs         # 直答拆解（烧每日额度，有缓存自动跳过；--quota 查当日余量）
node --env-file=.env.local scripts/make_card.mjs         # 炼卡（--remake 打回重炼）
node --env-file=.env.local scripts/blind_review.mjs      # 盲审
node scripts/report.mjs            # 考古报告（纯本地数据，无需环境变量）
```
