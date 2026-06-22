# Autopilot Engine

**Room ID**: `00-project-room/04-career-system/10-autopilot-engine`
**Type**: feature
**Lifecycle**: active
**Owner**: backend
**Parent**: `00-project-room/04-career-system`

## Intent

把"全自动找+投"从 Claude Code `/loop`(开发期手动驱动)升级为 **app 自己的后端 daemon**。

现状(已存在,本 room 复用):
- **自动扫描**已是 daemon — `src/career/finder/scheduler.mjs` 每 60s tick,按 cadence 自动触发扫描(`DISABLE_SCAN_SCHEDULER=1` 门控)。
- **填一份表 + 停在 submit gate**已存在 — `src/career/applier/multistep/machine.mjs` 有 ESCALATED/paused 状态,填完交接给人,**永不自动 submit**。
- `scripts/autopilot-run.mjs` 能把一个候选从 start 驱动到 submit gate,但需手动跑。

本 room 补的缺口 = **投递编排器(apply orchestrator)**:照 scheduler.mjs 的 master-tick 模式,新增一个 tick,自动挑候选 → 调已有 fill 流程 → 停在 submit gate → 塞进 Review 队列。配套 ON/OFF 控制端点、节流、活动流聚合。

## 锁定的设计决策(2026-06-21,owner)

daemon 会**拿真简历投真公司**,以下为不可翻转的安全边界:

1. **永不自动 submit**(继承全局铁律)— 编排器只把表填到 submit gate 就停,**全部进 Review 等人工点 Submit**。
2. **每日上限 N 个** — daemon 每天最多处理 N 个候选(N 可在 Profile 调,默认保守值)。防止它一口气投几十家。
3. **只自动已攻克的 3 家 ATS** — Greenhouse / Ashby / Lever(无登录墙、已 100% 适配)。Workday/iCIMS 等登录墙 ATS **自动跳过**,路由到 Review 标"需你手动登录"。
4. **选候标准** — 仅"过了硬筛选 + Stage 打分 ≥ 阈值"的候选才自动投(阈值可调)。
5. **永不重复投** — 已在 applications store 有记录的 job 不再入队。

相关文档:[`../AUTOPILOT-DESIGN.md`](../AUTOPILOT-DESIGN.md)(/loop 开发循环的由来)、[`../UI-LAYOUT.md`](../UI-LAYOUT.md)(消费本 room 端点的 UI)。

## 当前进度 — 🎉 ROOM COMPLETE (3/3, 100%)

- ✅ **m1-orchestrator-tick-and-lifecycle** — `autopilotState.mjs`(持久化 on/off + 每日节流,原子写)+ `orchestrator.mjs`(master-tick 镜像 scheduler.mjs,`selectCandidates` 落实 5 条铁律 + single-flight 守卫 + never-throws)+ server.mjs bootstrap(`DISABLE_AUTOPILOT_ENGINE` 门控)+ SIGTERM teardown + 4 端点。Review:1C+1H+3M+3L 全修;23/23 smoke。
- ✅ **m2-per-candidate-fill-driver** — `fillDriver.driveOne` 驱动现有 multistep machine(start + autoApproveWhenSafe)到 submit gate 即停,**永不 submit**(`ready_for_submit` escalation 就是成功态 → PARKED)。orchestrator.fill 换成 driveOne;dedup = applications + active apply-sessions + 6h 内存 cooldown(session-less 失败不再烧 cap);计数排除登录墙 + BUSY。Review:2C(ready_for_submit 误判、session-less 重填)+1H+2M+1L 全修;16+29 smoke + 实测启动通过。
- ✅ **m3-activity-feed-and-funnel-aggregation** — `feed.mjs`(append-only `autopilot-feed.jsonl` + `computeFunnel` 4 数字:候选/填表中/待批准/已提交)+ `GET /api/career/autopilot/feed` + `tickNow`(修复 m1 的 /enable kick 静默 no-op)。Review:1H(feed 无限增长→定期 compaction)+2M+2L 全修;无 import 环;9 feed + 30 orchestrator + 16 fill-driver smoke + 实测 /feed 通过。

🎉 **ROOM COMPLETE** — autopilot 后端引擎就位:60s tick 选候选 → 驱动现有 multistep machine 填到 submit gate → 永不 submit → 活动流 + 漏斗给 Dashboard。已为 `11-autopilot-ui-reframe` 备好端点:`/api/career/autopilot/{status,enable,disable,config,feed}`。

milestones 详见 `progress.yaml`。下一 epic:`11-autopilot-ui-reframe`(消费本 room 端点)。
