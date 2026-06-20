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

- **Ultimate goal:** automatically find jobs and reach **100% auto-apply per
  ATS** (Greenhouse → Ashby → Lever → Workday …) — find → fill → submit, with
  the human touch shrinking to ~zero on the ATSs that allow it.
- **Decision (2026-06-16, updated — supersedes the earlier throwaway-identity
  plan):** experiment with **real data + the real résumé**, applying to jobs the
  owner would actually take. The submit is then a *genuine* application — no
  fake-to-real-company spam, and it validates submit for real.
- **Metric:** **autonomy % per ATS** = fields auto-filled-correct / required,
  plus "did the form's validation pass + submit land." Tracked per ATS because
  they fail differently. The loop drives each ATS's number to 100%, one at a time.
- **Convergence, not one-shot:** every miss found in a round → fixed → added to
  regression → caught forever after. An ATS is "solved" when autonomy hits 100%
  with zero validation misses across N real jobs; then re-point the loop.

### ⚠️ Honest ceiling per ATS
Greenhouse / Ashby / Lever (single-page or simple multi-step, usually no login)
→ **100% auto is realistic**. **Workday** (account + login + multi-page + heavy
JS + frequent CAPTCHA) → CAPTCHA is a hard human gate (iron rule), so Workday
caps at "auto-fill ~95% + you clear login/CAPTCHA." Solve the 100%-able ATSs
first; bank the wins; then tackle Workday knowing some steps stay human.

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

## 4a. What ONE loop iteration actually does (the 9 steps)

```
For a target job on a target ATS:
1 SELECT   pick/confirm the target (one ATS at a time, e.g. Greenhouse)
2 RUN      drive apply: fill every field up to the submit gate
           📸 capture per-step screenshots + a final full-page shot (MANDATORY)
3 PROBE    click submit to trigger the FORM'S OWN validation → read the
           "missing required" errors it lists. 📸 screenshot the post-validation
           page. Do NOT complete the submission (unless this run is all-green = the
           real final submit). This respects "never auto-submit" while using the
           form's validation as ground truth for completeness.
4 MEASURE  fuse 4 detectors into the run-report (§4b)
5 DECIDE   pick the single gap that unblocks the most autonomy
6 FIX      data → YAML/profile; code → snapshot/classifier/submitFlow; ATS quirk
           → add/extend that ATS's adapter (greenhouse.yml / workday.yml)
7 VERIFY   smokes green + re-run/replay → autonomy ↑ and nothing regressed
8 COMMIT   checkpoint; add the failing case to regression (permanent guard)
9 LOOP     repeat until autonomy 100% AND validation reports zero missing → then
           the final run actually submits (a real application).
```

## 4b. How each round finds problems (completeness model)

No single detector is complete — read-back's denominator can even lie (it can't
count fields it never perceived). Completeness comes from fusing four, with the
form's own validation as the closest thing to ground truth:

```
DOM read-back       cheap first pass; mechanical errors (filled? landed?)  — incomplete
+ agent reads        screenshot + answers → "filled-wrong / never-seen / low-quality"
+ form validation    PROBE submit → the ATS itself lists what's missing      ← most complete
+ your final glance  last human check before the real submit                 ← backstop
```

Screenshots are a first-class input every round (step 2 + 3) — they're how the
agent sees what the DOM missed and confirms the submit landed.

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
