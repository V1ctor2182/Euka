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

## 当前进度 — 🚧 IN PROGRESS (1/4)

- ✅ **m1-global-control-bar-and-dashboard** — 顶栏全局 `AutopilotToggle`(poll `/autopilot/status`,乐观 ON/OFF)+ 新 `Dashboard` 落地页(状态卡 + 4 漏斗卡 候选/填表中/待批准/已提交,读 `/autopilot/feed` + 活动流)。Dashboard 设为落地 tab。消费 `10-autopilot-engine`(已 COMPLETE,真数据)。Review:2M+1L 全修,redirect 无环;5/5 smoke + vite build + lint。
- ⬜ m2-review-gate-queue
- ⬜ m3-jobs-page-downgrade
- ⬜ m4-nav-reframe-profile-reclass-room-complete

milestones 见 `progress.yaml`。`10-autopilot-engine` 端点已就绪(真数据,非 stub)。
