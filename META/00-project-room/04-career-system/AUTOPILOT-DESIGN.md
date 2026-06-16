# Autopilot = Claude Code's `/loop` (NOT a system you build)

> **The correction (2026-06-16, owner):** you don't *develop* an "autopilot."
> **Claude Code IS the autopilot.** CC can already run the apply, read what
> broke, fix the code, commit, and a `/loop` makes it repeat toward a goal.
> An earlier draft of this doc proposed building a custom JS harness
> (`diagnose.mjs` / `semanticReview.mjs` / a separate "AI fix agent"). That
> *duplicates abilities CC has natively* — I diagnose by reading the page +
> session + code; I fix by editing (exactly how G1/G3 were fixed). This rewrite
> drops the custom-software framing entirely.

---

## 1. What autopilot is

```
autopilot  =  /loop <goal>  +  Claude Code  +  the existing apply pipeline
```

Each loop iteration, **Claude Code natively** does:

```
1. RUN       drive the apply (existing server + scripts) on a target job
2. READ      look at the result — the session JSON, screenshots, the live
             page, and the relevant source code (full repo context)
3. DIAGNOSE  understand what went wrong + why  ← native; no diagnose.mjs needed
4. FIX       edit code / update data (like the G1, G3 fixes) + run smokes
5. COMMIT    checkpoint the fix
6. REPEAT    until the goal is met, pausing at human gates
```

That's it. The "intelligence" is the agent (me), not a harness.

## 2. Why this is better than building custom software

| Custom harness (dropped) | Claude Code in a `/loop` (this) |
|---|---|
| `diagnose.mjs` — fixed symptom→cause table | I read the actual page/session/code with full context — richer than any fixed taxonomy |
| `semanticReview.mjs` — LLM reviews answers | I review the answers myself (I am Claude) |
| "AI fix agent #5" — a thing to build | just me, editing code in the loop |
| more code to maintain | ~no new code; the agent is the engine |

## 3. The goal & the metric

- **Goal (your decision):** the full chain **find → … → submit** succeeds
  **once**, end-to-end, on a real posting (throwaway identity). One success = done.
- **Metric per iteration:** how much of the form filled correctly on its own
  (autonomy %) + did submit land. I report this each loop by reading the run;
  if you want a hard, objective number, keep the optional scorecard (§6).

## 4. The `/loop` — what you actually run

```
/loop 目标:让一个真实岗位的 find→fill→submit 链路跑通一次。每轮:
  1. 选/确认一个目标岗位(无 CAPTCHA 的 Greenhouse/Ashby)
  2. 跑一次 apply,读 session + 截图,报告 autonomy% 和哪些字段坏了
  3. 诊断根因,修掉解锁最多的那个(改代码就改、改数据就改)+ 跑 smoke
  4. commit
  5. 重复,直到能填满 + submit 成功
  遇到这些停下来问我,别擅自做:
    - 需要我起 server / 点浏览器 / 点 submit
    - 要 merge 到 main
    - 改动碰到“永不自动 submit”等铁律
```

- **Self-paced** (no interval) — each iteration is a fix, not a timer.
- **One commit per fix** — checkpointed, you can see/revert/interrupt anytime.
- **Smokes each round** — green before continuing (no thrashing).

## 5. Human gates (where `/loop` pauses — by design)

```
RUN browser apply  → 🔴 you start the server + watch/approve in the browser
merge to main      → 🔴 you (the loop only commits to the branch)
SUBMIT             → 🔴 you click it (or the agreed one-shot)
```
Everything between — reading, diagnosing, editing code, smokes, commits — is me.
So it's "auto-everything except the gates," and the loop stops at each gate to
ask. (Note: commit/push also trigger CC permission prompts — expected.)

## 6. The only optional helper

A thin **autonomy scorecard** (`scripts/autopilot.mjs`, already built) prints a
consistent autonomy % + gap list so the loop optimizes an *objective* number
instead of my subjective read. Keep it if you want hard metrics. The richer
modules (`diagnose.mjs` logic is its scorer; `semanticReview.mjs`) are NOT the
engine — at most they're measurement helpers. The engine is the `/loop` + me.

## 7. What was already built (and its new status)

| Built earlier | New status |
|---|---|
| `scripts/autopilot.mjs` (scorecard) | ✅ keep — optional objective metric |
| `src/career/autopilot/diagnose.mjs` | scorer behind the scorecard; not "the brain" |
| `src/career/autopilot/semanticReview.mjs` | redundant with native review — remove or leave as a helper |
| P0 fixes (G1 sponsorship, G4 never-auto-submit) | ✅ real bug fixes, keep |

## 8. So the next step is not "build", it's "run the loop"

The apply pipeline + the fixes + the scorecard already exist. The remaining work
is **running the loop** against a real job and letting me fix what breaks each
round — which needs you to bring the server up and be present for the browser
step. No more harness to develop.

---

_Autopilot is a way of working (CC `/loop` + me), not a deliverable. Start the
loop when you're ready to run a real apply; I do the diagnose+fix natively._
