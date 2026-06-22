# Autopilot UI Reframe

**Room ID**: `00-project-room/04-career-system/11-autopilot-ui-reframe`
**Type**: feature
**Lifecycle**: active
**Owner**: frontend
**Parent**: `00-project-room/04-career-system`

## Intent

把现有"手动浏览式"求职 UI 重构为 **自动化优先布局**:主舞台留给「机器运行状态」与「人工闸门」,
配置类(数据源/筛选)一律降级。完整 layout 与各功能归位见 [`../UI-LAYOUT.md`](../UI-LAYOUT.md)。

核心原则:autopilot 产品的主角不是职位列表,而是那台机器的状态。用户每天只做两件事 ——
**批准提交** + **回答机器不会的新问题**。

消费 `10-autopilot-engine` 的端点:`/api/career/autopilot/{status,enable,disable,config,feed}`。

四块改造:
1. **全局 Autopilot 控制条 + Dashboard** — 顶栏 ON/OFF(真控制 daemon)+ 落地页(状态卡 + 4 漏斗数字 + 活动流)。
2. **Review 人工闸门队列** — 收拢 🟢待提交 / 🟡待回答新问题 / 🔴失败需接管;答题回写 qa-bank;nav 角标。
3. **Jobs 页降级** — Sources→状态条、Filters→左栏、Apply→"加入投递队列"(真入队到编排器)。
4. **导航重排 + Profile 归类** — Dashboard/Review/Jobs/Tracker/Profile;删 legacy;debug 收进 Dev/Debug。

## 当前进度 — 🚧 IN PROGRESS (2/4)

- ✅ **m1-global-control-bar-and-dashboard** — 顶栏全局 `AutopilotToggle` + 新 `Dashboard` 落地页(状态卡 + 4 漏斗 + 活动流,读 `/autopilot/status`+`/feed`)。5/5 smoke。
- ✅ **m2-review-gate-queue** — Review 人工闸门收件箱(3 桶 待提交/需接管/填表中,新 `GET /autopilot/review`)+ nav Review tab + 轮询 badge + "存答案"飞轮(`POST /autopilot/bank-answer` 写 applier-shape history)。关键修复:把 `terminal_outcome`+`escalation_code` 持久化进 session(schema +2 字段,machine settle 时写)→ 分桶重启安全、不再每 session 调 getStatus。深度逐字段操作仍走现有 Apply 页。Review:1H+3L 全修;飞轮写形态已核;apply-sessions-store 58/58 回归;4/4 smoke。
- ✅ **m3-jobs-page-downgrade** — 重构 Find Jobs:Sources 折叠区 → 一行状态条(Scan now + Manage→Profile),Filters 折叠区 → 常驻左栏,候选网格为右侧主体。Apply → **「让机器投」**(`autopilotQueue.mjs` + orchestrator forced pass:入队 job 绕过分数阈值,仍守 solved-ATS/永不重投/cap)。JobCard 按机器状态显示(让机器投/已排队/填表中/待提交/需接管,轮询 review+queue)。Review:1H+4M/L 全修;forced 不变量已核;orchestrator 32/32 + jobs 4/4。
- ⬜ m4-nav-reframe-profile-reclass-room-complete

milestones 见 `progress.yaml`。`10-autopilot-engine` 端点已就绪(真数据,非 stub)。
