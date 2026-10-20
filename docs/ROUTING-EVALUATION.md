# Model routing evaluation protocol

Question: can some reviews run on the cheaper model (GPT-6 Luna, no reasoning) instead of the configured model
(GPT-6 Sol, medium) without materially worse decisions, and does the complete routing policy save enough to be worth it?

The criteria in section 6 were approved by the user on 2026-10-20 (section 10) and are frozen. A pass would show only
that no material routing harm was observed, within the stated uncertainty, on the situations evaluated. It would not
show that the cheaper model is never worse, or that Sol, Luna or the app makes reliable investment decisions. A pass
does not by itself enable live routing; that remains a separate decision.

## 1. Shadow design

- While shadow evaluation is on, every live review is decided by the main model. This is enforced where the model is
  chosen, before any budget fallback, so the experiment cannot move a live review to the cheaper model.
- The cheaper model decides the same review at the same time, on an independent copy of the exact context the live
  review received (the saved `review_contexts` row). Neither model sees the other's answer.
- Evidence is shared: a read request either model makes (market evidence, company research, market overview,
  screening, search, formula) is fetched once and both receive the same result. A request only one model makes is
  fetched when it asks; its time is recorded. Each model's full tool transcript is stored, with the shared results,
  so adjudication can tell a reasoning difference from an evidence difference.
- The shadow run cannot change anything. Its write tools (watchlist, review interval and watches, desk notes, triggers,
  conditional orders) answer "not applied". Its output is never shown to the live model or later reviews, never enters
  lessons, plans or the scout, and never places orders. It is stored only in `routing_eval`.
- Shadow calls use their own daily allowance (`shadow_usage`, default $1), never the live review budget.
- The frozen contexts behind shadow pairs are exempt from the app's context pruning.
- Limitation: the cheaper model is evaluated on portfolio states the main model's decisions produced. The routing
  simulation (section 3) replays the router's own history of baselines, streaks and previous decisions, but cannot show
  how cheaper-model decisions would have changed holdings.

## 2. What each record holds

One `routing_eval` row per shadowed review, keyed by the review id: the assessment computed before the model was chosen
(features with their source: `snapshot`, `baseline` or `previous-review`; the consequence gate; the difficulty score),
both decisions (action, symbol, quantity, plan, scout-target verdicts, the model's rating of the next decision), both
tool transcripts, the shared evidence, tokens and cost for each side, an automatic triage (section 4), and the
adjudication (section 5).

## 3. Router under evaluation and the routing simulation

- Consequence gate: the largest held position and the largest new position the sizing rules allow (capped by cash),
  as a share of total equity, when a market can trade now. 20% is a policy choice, not a validated boundary.
- Difficulty score: signals grouped by underlying event (price, market, news, events, conflict, confidence); a group
  counts its strongest signal, distinct groups add, the trigger adds nothing; the previous review's rating only raises
  the score and expires after a material change.
- Mandatory escalations (`electron/routing-sim.cjs` `hardRule`, shared with live routing): first review after starting,
  consequence gate, no main-model review in 12 hours, first review of a regular session, the cheaper-model limit
  (4 reviews or 120 minutes). A cheaper-model trade or verdict change goes to the main model; a failed cheaper-model run
  falls back to the main model; a sampled spot check has the main model decide.
- The simulation applies spot checks to sampled reviews (deterministically, by a hash of the review id), resetting its
  history as the live router would; keeps failed cheaper-model runs, with their fallback and both costs; and reports
  records missing their saved context, which makes the result inconclusive.
- The simulation calls the live router's own decision function (`route` in `electron/token-saver.cjs`) with the inputs
  recorded at review time, so emergencies, user requests and important disclosures escalate exactly as live.
  Validated complexity routing has no near-budget fallback, so budget behavior does not differ between the two.
- The routing simulation replays the router in time order with its own last-main-model baseline, cheaper-model streak
  and previous decision (the cheaper model's own when it would have been used). Routing shares, savings and which
  reviews count as cheaper-routed come from this simulation, not from the live history.

## 4. Automatic triage

`same`, `wording` (immaterial); `verdict`, `size`, `action`, `symbol` (material differences, candidates for
adjudication); `failed`. Size differences are measured against equity in won, with U.S. prices converted. A material
difference is not a miss.

## 5. Adjudication

Adjudicated: every review the simulated router would have left to the cheaper model, whatever its triage; every
material difference on the other reviews; and a predefined random audit of `same` and `wording` pairs on reviews the
main model would have decided (audited when the first byte of SHA-256(review id) is below 26, about 10%), with at least
20 audited pairs required. Agreement between the models does not establish correctness. A situation enters the
confidence bounds only when every cheaper-routed review in it has been adjudicated, so unjudged cases never count as
successes.

Each queued pair is judged on the information available at the time (the frozen context and both transcripts), never
on what prices did afterwards. Missed actions are assessed explicitly in every adjudication: should either model have
acted, or changed a verdict, and did not?

- Outcome: `sol-better`, `luna-better`, `both-defensible`, `both-wrong` (recorded separately, with whether the cheaper
  model was worse), `immaterial`.
- Error category for the worse side: `missed-action`, `wrong-action`, `sizing`, `constraint`, `factual`,
  `evidence-ignored`.
- Severity, by what the error puts at stake as a share of total equity, without overlap: low below 2%; medium from 2%
  to below 10%; high at 10% or more. A `constraint` error is at least medium.

A routing miss is a `sol-better`, or a `both-wrong` with the cheaper model worse, on a review the simulation would have
left to the cheaper model. Claude proposes adjudications; the user confirms every high-severity one. They are stored in
`artifacts/routing-eval/adjudications.jsonl`, one JSON object per line. A record counts only when complete; anything
else stays pending:

- always: `reviewId`, `outcome`, `reason` (at least a sentence), `judgedAt` (a date), `missedActionChecked: true`;
- when a side was worse (`sol-better`, `luna-better`, `both-wrong`): `category` and `severity`;
- `both-wrong`: `lunaWorse` (true or false); `high` severity: `confirmedByUser: true`; a `constraint` error is not `low`.

## 6. Pass criteria (approved 2026-10-20, frozen)

The unit is a distinct cheaper-routed situation in the evaluation period (section 7).

1. High-severity misses: none observed during evaluation. Reported with the sample size and the one-sided 95%
   Clopper-Pearson upper bound. One or more is a fail.
2. Medium-severity misses: tolerance 2%. The one-sided 95% Clopper-Pearson upper bound on the medium miss rate must be
   at most 2%. An observed rate above 2% is a fail; an observed rate at or below 2% with an upper bound above 2% is
   inconclusive. (With zero misses this needs at least 149 cheaper-routed situations; with one, about 237.)
3. Coverage minimum: at least 10 distinct situations in each category: held positions, quiet, stress, event-driven.
   This is a minimum for coverage, not proof of a sufficient sample. The held-position requirement stays: no stock is
   bought to satisfy it.
4. Adjudication complete: every queued pair (section 5) adjudicated, including at least 20 audited same/wording pairs.
   Missed actions, wrong actions, sizing errors, constraint violations and both-model errors are reported separately.
5. Savings: at least 30% against main-model-only cost, measured on the complete proposed policy: mandatory
   escalations, trade and verdict escalations, spot checks, retries and ongoing audits. The one-time shadow evaluation
   cost is reported separately and not counted against the policy.

Verdict: `pass` only when all five hold; `fail` on any high-severity miss, a medium rate above 2% or savings below 30%;
otherwise `inconclusive`. `scripts/routing-report.cjs` computes the checks.

## 7. Situations, periods and freezing

- Results count distinct situations: on one account, a new situation starts with a price, news or regime change
  against the previous review, a new scout plan, or a gap of more than four hours.
- Only records from a verified live broker account count: each record stores its provenance (the account label at
  review time and the connected account's environment), and both must be live. Paper, mock and unknown provenance are
  supplementary.
- Before the evaluation period starts, `node scripts/routing-report.cjs --freeze` records the binding (protocol
  version, a hash of the routing code, both models and efforts, threshold, spot-check rate, cheaper-model limits and the
  consequence gate) and the start time in `artifacts/routing-eval/freeze.json`; the date goes in section 10. Only
  records from live accounts made after the start under that binding count; records under another binding are
  excluded and reported. If the router is tuned using any evaluation-period results, run `--freeze` again: that starts
  a new, untouched period and the earlier records no longer count.
- The period's length is set by coverage and sample size (section 6), not a calendar date.

## 8. Supplementary evidence

Historical replays (Journal → Replay) and paper-portfolio runs may test the router on situations prospective data lacks,
such as held positions. They are reported separately and never counted toward the criteria in section 6.

## 9. If it passes

Enabling live routing is a separate decision. The engine accepts a pass only from a report with verdict `pass`, every
check passing, prospective data from a frozen period, and a binding equal to the one now in force; the pass stops
counting as soon as the models, router settings, protocol version or routing code change. Without a valid pass the
engine keeps the main model even if complexity routing is selected, before any budget fallback. If enabled, live
routing keeps the mandatory escalations, random spot checks and the same triage and adjudication.

## 10. Record of decisions

- 2026-10-20: protocol written before data collection.
- 2026-10-20: pass criteria approved by the user with these changes: zero observed high-severity misses reported with
  their bound; medium misses judged by a one-sided 95% upper bound of at most 2% (Clopper-Pearson); non-overlapping
  severity boundaries; full adjudication of material differences plus a predefined random audit; savings on the
  complete policy with the shadow cost reported separately; router and criteria frozen before the evaluation period,
  with a new untouched period required after any tuning on it; held positions kept, no purchases to satisfy coverage.
  Approval of the criteria does not authorize live routing.
- 2026-10-20: clarifications after a second code review, applied before any data: every cheaper-routed review is
  adjudicated and only fully adjudicated situations enter the bounds; the freeze and binding mechanism; passes are
  validated and invalidated on change; failed runs and sampled spot checks are part of the simulated policy; records
  missing their context make the result inconclusive. These tighten how the approved criteria are applied; the
  thresholds are unchanged.
- 2026-10-20: clarifications after a third code review, before any data: a pass must contain every named check;
  incomplete adjudication records stay pending; only verified live-account records count; the simulation runs the
  live routing function and validated complexity routing has no budget fallback. Thresholds unchanged.
- 2026-10-20: clarifications after a fourth code review, before any data: the consequence gate and difficulty score read
  Korea-only and U.S.-only contexts as well as combined ones; each record stores its market scope and the holiday
  calendar used, the simulation applies only those, and the market scope is part of the binding. Thresholds unchanged.
- Evaluation period start: 2026-10-20 23:36:22 KST (2026-10-20T14:36:22Z), frozen with `scripts/routing-report.cjs
  --freeze` after the user turned on shadow evaluation (main model only, 100% shadowed, $1/day shadow allowance) and
  started auto trading on the KIS live account. Binding: protocol 2026-10-20, routing code a7c2695f4ce0179b (app 1.5.20),
  scope both, main gpt-6-sol medium, cheaper gpt-6-luna none, threshold 40, spot checks 25%, cheaper-model limit
  4 reviews or 120 minutes, consequence gate 20%. The one pair recorded before the start (23:34:56 KST) does not count.
