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

## 当前进度 — 🚧 PLANNING (0/4)

milestones 见 `progress.yaml`。依赖 `10-autopilot-engine`(后端引擎先行);10 的端点 ready 后本 room 才能接真数据。UI 壳可先对 stub 端点开发。
