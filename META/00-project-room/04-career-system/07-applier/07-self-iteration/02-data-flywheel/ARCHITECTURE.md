# Data Flywheel — 架构图

> Applier "越用越准" 的核心机制：每次 apply 的失败与修正回流系统 → AI 归纳 →
> 人审 → 热应用 → 下次更准。全本地存储，不上云，不训练第三方模型。

**Room**: `07-applier/07-self-iteration/02-data-flywheel`

---

## ① 全局闭环 — "越用越准"的回路

```
                          ┌─────────────────────────────────────────────┐
                          │              你 apply 一个 job               │
                          │      (Playwright runtime 自动填 ATS 表单)     │
                          └──────────────────────┬──────────────────────┘
                                                 │ 每次 apply 产生信号
              ┌──────────────────────────────────┼──────────────────────────────────┐
              │ 字段填错              答案被改     │ 站点填不动        verify 失败       │
              ▼                       ▼            ▼                   ▼               │
   ┌──────────────────┐  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐  │
   │ recordField      │  │ recordFieldEdit  │ │ recordSite       │ │ recordVerify │  │  ← 捕获层
   │  Misclassified   │  │                  │ │  Failure         │ │  Failure     │  │   (capture hooks)
   └────────┬─────────┘  └────────┬─────────┘ └────────┬─────────┘ └──────┬───────┘  │
            │                     │                    │                  │          │
            ▼                     ▼                    ▼                  ▼          │
   data/career/feedback/  *.jsonl  (append-only, Zod 校验, 本地, 不上云) ◄───────────┘   ← 存储层
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │ field-misclassified.jsonl   field-edits.jsonl   site-failures.jsonl           │
   │ verify-failures.jsonl       qa-bank/history.jsonl (复用,开放题 a_draft→a_final) │
   └──────────────────────────────────────┬───────────────────────────────────────┘
                                           │ groupBy(site/domain) ≥ 阈值(5) 触发
                                           ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  induce.mjs  调度器  →  Haiku 归纳 (Zod fail 时 Sonnet 重试)                     │   ← 归纳层
   │   ├─ induceClassifierRule   (5 个同 site 字段错 → 新分类规则)                    │   (AI induction)
   │   ├─ induceSiteAdapter      (5 个同 domain 失败 → 新 site-adapter YAML)          │
   │   └─ induceVerifyFix        (verify 失败 → 修复建议)                            │
   └──────────────────────────────────────┬───────────────────────────────────────┘
                                           │ 写入 suggestionStore (suggested/*.json)
                                           ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │     Learning tab UI  —  你 review 建议队列  ✅Approve / ❌Reject (永不自动应用)   │   ← 人审 Gate
   └──────────────────────────────────────┬───────────────────────────────────────┘
                                           │ Approve → applySuggestion.mjs
                                           ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  写入活配置 (热加载, 无需重启):                                                  │   ← 应用层
   │   · learned-classifier-rules.yml  → classifyField 下次 sweep 即生效             │
   │   · data/career/site-adapters/{domain}.yml → loader mtime 自动 invalidate       │
   └──────────────────────────────────────┬───────────────────────────────────────┘
                                           │
                                           └──────────►  下次 apply 更准  ──► 回到顶部 ↺
```

**分层职责**

| 层 | 组件 | 做什么 |
|----|------|--------|
| 触发 | Playwright runtime | 你 apply 一个 job，自动填 ATS 表单，每次产生信号（低频，你手动） |
| 捕获 | `recordFieldMisclassified` / `recordFieldEdit` / `recordSiteFailure` / `recordVerifyFailure` | 在 apply 生命周期各 touchpoint 捕获失败与修正 |
| 存储 | `data/career/feedback/*.jsonl` | append-only + Zod 校验，本地不上云 |
| 归纳 | `induce.mjs` + 3 个 inducer | 同 site/domain 累积 ≥5 触发 Haiku 归纳（Zod fail 时 Sonnet 重试），产出提案 |
| 人审 Gate | Learning tab UI | review 建议队列，Approve / Reject，**永不自动应用** |
| 应用 | `applySuggestion.mjs` | 写活配置，热加载无需重启，下次 apply 即生效 |

---

## ② 两个闭环的分工 — 数据层 vs 代码层

数据飞轮（02）只改 **YAML 数据**；改不动的才升级（escalate）给
**01-code-calibration** 改 `.mjs` 源码。

```
   apply fail
      │
      ▼
   02 自查 qa-bank/规则 → 能解决?
      ├─ 能  → DONE   (数据层闭环: 学答案 / 调权重 / 学 heuristic — 几十次/天, 自动审)
      └─ 不能 → 写 evidence/{jobId}-{ts}.{html,json}  +  dashboard 标红 "🔴 Needs Code Fix"
                   │ (你点 Promote)
                   ▼
               01-code-calibration 接手 (HTML→fixture→tuner→propose .mjs diff→人审 PR→merge)
                                            └─ 几次/月, 失败半径大, 必须人审+smoke
```

| | **02 数据飞轮** | **01 代码校准** |
|---|---|---|
| 改什么 | qa-bank / 规则 / site-adapter (YAML) | filter / actions / serializer (`.mjs`) |
| 触发 | 每次 apply 后自动 | 02 升级 or 你周期 tune |
| 频率 | 几十次/天 | 几次/月 |
| 失败半径 | 一个 apply 错 | 所有 future apply 错 |
| 审核 | 数据 diff 自动（异常才人审） | 必须人审 + smoke + PR |

---

## ③ 收敛曲线 — 为什么叫"飞轮"

```
数据飞轮命中率:   apply 10 → 40%   ·  50 → 75%  ·  100 → 90%  ·  200 → 95%  (渐近, 长尾持续)
代码校准覆盖率:   fixture 10 → 85% ·  20 → 95%  ·  30 → 98%  ·  50+ → 100% (饱和, ARIA 上限锁定)
整体成功率 ≈ min(两者):  Month1 ~65% → Month3 ~85% → Month6 ~92% → Month12 ~97%
```

---

## 现状提醒

- **核心飞轮（m1–m4）已 ROOM COMPLETE**（2026-05-18，97/97 smoke 绿）：捕获→存储→归纳→人审→热应用 全链路打通，端到端验证过（5 个同站错误 → Haiku 归纳分类规则 → Approve → 下条 live 生效，无需重启）。
- **还差的（m5/m6/m7）是 Plan B 增强**：消费更丰富的 envelope v2 信号（策略 / 标签-答案 / 提交检测）、基于 N-evidence 聚类产更高级提案、unlabeled 池 / 手填模式信号。属于"飞轮转得更聪明"，不是"飞轮转不转"。
- **真正没做的 UI 大头是隔壁的 04-flywheel-dashboard**（`/career/flywheel` 全景看板，0/3）。

---

_由架构梳理生成。相关 spec：[intent-data-flywheel-001](specs/intent-data-flywheel-001.yaml) · 父 sub-epic：[../spec.md](../spec.md)_
