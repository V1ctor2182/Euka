# Autopilot — a self-improving apply system

> **North star:** the system runs on its own, finds a job that fits, evaluates
> it, tailors a résumé, and fills the entire application correctly — getting
> measurably *more autonomous every cycle* until a human touch is rarely
> needed. Designed 2026-06-15, grounded in the real gaps from the first P0 run
> (G1 sponsorship logic bug, G2 Greenhouse education blind spot, G4 auto-submit).

---

## 0. The one dial you control: where the human line sits

The whole system is built around **one deliberate boundary**, and you set it:

| Mode | What's automated | Human touch |
|---|---|---|
| **1-touch (default, safe)** | find → evaluate → tailor → **fill the entire form to the Submit button** | you click **Submit** (1 action) |
| **0-touch (opt-in, per-ATS, after proof)** | everything incl. submit | none |

You just re-affirmed "never auto-submit". So Autopilot ships at **1-touch**, and
0-touch is a **per-ATS privilege that must be earned** (see §7 trust ladder) —
never a default. The north star "fully apply by itself" = **reach 1-touch
reliably, then graduate specific ATSs to 0-touch when *you* trust them.**

---

## 1. The metric the loop optimizes: Autonomy Rate

You can't self-improve what you don't measure. Every cycle computes:

```
Autonomy Rate (per application) =
    (fields auto-filled & verified correct) ─────────────────────
    (total required fields + steps)

Human-Touch Count = # of times the system had to stop and ask you
                    (north-star target: 1 — the Submit click)
```

Tracked **per ATS** (Greenhouse / Ashby / Lever / Workday / iCIMS) because they
fail differently. The loop's job: drive Autonomy Rate → 100% and Human-Touch → 1
for each ATS, one at a time.

---

## 2. The loop (Autopilot cycle)

```
        ┌──────────────────────────────────────────────────────────────┐
        │                      ONE AUTOPILOT CYCLE                       │
        └──────────────────────────────────────────────────────────────┘

  ① FIND        finder scans sources / pulls next pipeline job
       ↓
  ② GATE        hard-filters + evaluate (Stage A Haiku → Stage B Sonnet)
       ↓        → pick the top-scoring job that fits prefs
  ③ TAILOR      CV engine tailors résumé → data/career/output/{jobId}-*.pdf
       ↓
  ④ FILL        Playwright applier fills every field → stops at Submit gate
       ↓        (IRON RULE: never clicks Submit in 1-touch mode)
  ⑤ MEASURE     compute Autonomy Rate; emit one typed Gap per problem:
       ↓           not_seen · mismatch · manual · low_confidence · error
  ⑥ ROUTE       send each Gap to the right fixer lane (§4)
       ↓
  ⑦ ASK         consolidate everything blocking autonomy into the
       ↓         Teach-Me queue: "to go fully auto I need X from you" (§5)
  ⑧ LEARN       apply approved data fixes (hot reload) + merge approved
       ↓         code fixes → corpus replay proves no regression (§6)
  ⑨ REPEAT      next cycle starts smarter. Autonomy Rate trends up.
       └────────────────────────────────────────────► back to ①
```

**This loop already exists as separate pieces in your repo** — Autopilot is the
*driver + scorecard + router* that wires them into a closed cycle.

---

## 3. "Can I use /loop or a goal to do this?" — yes, that's exactly the shape

- **`/loop` is the heartbeat.** It re-invokes the cycle on a cadence (or
  self-paced). Good for the *outer* engine: "run an Autopilot cycle, then again."
- **The "goal" is the exit condition + the optimizer target.** The loop doesn't
  run forever blindly — it runs *toward* a goal and stops when met:
  > Goal: `Autonomy Rate ≥ 100% on Greenhouse across 3 consecutive real applies,
  > Human-Touch == 1`. When met → Greenhouse is "solved", move the goal to Ashby.
- **But `/loop` alone is just a timer.** The value is in *what each beat does* —
  the harness (§2), the gap router (§4), the teach-me queue (§5), the regression
  gate (§6). So: **goal-driven `/loop` as the driver, Autopilot harness as the
  body.** Don't loop a dumb prompt; loop a structured cycle with a scorecard.

Practical: a `scripts/autopilot.mjs` runs one cycle and prints
`{autonomy_rate, human_touches, gaps[]}`. `/loop` (or the `schedule` skill for
unattended cadence) calls it; the goal metric decides when to stop / advance.

---

## 4. Gap routing — three lanes (this is the self-optimization engine)

Every Gap from step ⑤ is classified and sent to exactly one lane:

| Lane | Gap kind | Who fixes | Human role | Speed |
|---|---|---|---|---|
| **🟢 Data** (flywheel) | missing value, label→class, site selector, site quirk | induce → propose YAML/rule | light approve in Learning tab | minutes |
| **🟣 Code** (calibration) | logic bug (G1), snapshot blind spot (G2), new control type, submit detection (G3) | **AI fix agent drafts code+test+PR** | review/merge PR | the meta-loop |
| **🔴 Human** (irreducible) | the Submit click, genuinely ambiguous answer, CAPTCHA | — | do it | minimized over time |

**The 🟣 Code lane is what makes it "optimize itself."** Today *I* (Claude Code)
manually diagnose G1/G2/G3 and write the fix. Autopilot formalizes that:

```
Gap (code-fixable) + evidence (captured page HTML + snapshot + expected value)
        ↓
  AI Fix Agent  ──►  `claude -p` / Claude Code headless, given the evidence +
        ↓            the repo, drafts: code fix + REVIEW-named regression test
  opens a PR  ──►  you review & merge (the human gate for code, same as Submit
        ↓            is the human gate for sending)
  corpus replay confirms Autonomy Rate ↑, nothing regressed (§6)
```

This is the "越用越准 for code" loop — the missing half of self-iteration
(`01-code-calibration`, currently 0 real runs). It runs off your local
`claude -p` (no API key), the same backend you just wired.

---

## 5. The Teach-Me queue (your exact ask: "tell me what you need, then learn it")

A single ranked surface (extends the Learning / Flywheel dashboard). Each item
says **what it needs, what it unblocks, and one action**:

```
🔴 Blocking Greenhouse autonomy (−12 fields)
   "I can't read your Education block (School / Degree / Start–End dates).
    Fill it once on this form and I'll learn the Greenhouse pattern."
                                                   [ Teach me once ▸ ]

🟡 Low-confidence answer
   "'Now or in the future require sponsorship?' — I'll answer Yes (F-1 OPT,
    future H1B). Confirm so I stop asking."          [ Confirm ✓ ]

🟣 Code fix ready for review
   "Sponsorship mapping bug → drafted fix + test in PR #N. Merging makes
    every future sponsorship question correct."      [ Review PR ▸ ]
```

Rule: **the queue is sorted by autonomy unlocked.** The top item is always
"the single thing that buys you the most automation right now." That *is* the
"it tells me what to provide" experience — turned into a prioritized backlog.

---

## 6. Regression safety — never let self-improvement break you

Self-modifying systems rot without guard rails. Three:

1. **Capture before fix.** Every gap snapshots the real page HTML →
   `data/career/applier/evidence/` (the shared Evidence Store). Fixes are
   designed against real evidence, not guesses.
2. **Replay corpus.** Promoted evidence becomes a fixture. Before any data/code
   fix is "learned", replay it across the whole corpus → Autonomy Rate must go
   **up**, and no prior fixture may regress. (This is `01-code-calibration`'s
   "adapter rule replay" milestone.)
3. **Two human gates, nothing else.** Submit (sending) + PR merge (code). Data
   fixes are reversible YAML. No silent self-application of anything risky.

---

## 7. Milestone ladder → the north star

```
M0  ✅ now   manual P0 runs, I fix gaps by hand (G1/G3/G4 done)
M1          Autopilot harness: scripts/autopilot.mjs runs ①–⑤ for one job,
            prints {autonomy_rate, human_touches, gaps[]}. Turns ad-hoc P0
            into a repeatable, scored cycle.
M2          Live gap capture: wire recordVerifyFailure into live apply (G2
            blind spot) + type/route every gap (§4).
M3          Teach-Me queue UI (§5) — the "tell me what you need" surface.
M4          Data lane closed: teach-once → flywheel induces → you approve →
            hot-apply → Autonomy Rate climbs on repeat ATS.
M5          Code lane: AI Fix Agent (§4 🟣) — gap+evidence → claude -p drafts
            fix+test+PR. Self-optimization is live.
M6          Replay corpus + regression gate (§6).
M7          Trust ladder: when an ATS hits Autonomy Rate 100% / Human-Touch 1
            across N real applies → it's "solved". Optionally graduate that
            ATS to 0-touch (auto-submit) — explicit, per-ATS, your call.

🎯 North star reached when: Autopilot runs unattended, finds + evaluates +
   tailors + fills a real job to the Submit gate, the Teach-Me queue is empty
   for that ATS, and you click Submit once (or zero times, if graduated).
```

**Sequencing logic:** M1 makes it *measurable*, M2–M4 close the *data* loop
(fast wins, your "teach me" vision), M5–M6 close the *code* loop (the deep
self-optimization), M7 is the trust dial. Each milestone moves one number:
Autonomy Rate up, Human-Touch down.

---

## 8. What already exists vs what's new

| Capability | Status | Milestone |
|---|---|---|
| find / evaluate / tailor / fill pipeline | ✅ built | — (wire into harness) |
| flywheel capture (site-failure, field-edit, misclassified) | ✅ live | M2 (add verify-failure) |
| induction trigger + reclassify | ✅ m4c | M4 |
| Learning/Flywheel dashboard | 🟡 partial | M3 (→ Teach-Me) |
| **Autonomy scorecard** | 🆕 | **M1** |
| **Gap router (3 lanes)** | 🆕 | M2 |
| **AI Fix Agent (code self-opt)** | 🆕 | M5 |
| **Replay corpus + regression gate** | 🟡 spec'd | M6 |
| never-auto-submit guarantee | ✅ A-fix | enforced throughout |

---

_Start at **M1** (the harness + scorecard) — it's small, it makes everything
after it measurable, and it turns "run a P0 by hand" into "run Autopilot and
read the number." Everything else is "make the number go up."_
