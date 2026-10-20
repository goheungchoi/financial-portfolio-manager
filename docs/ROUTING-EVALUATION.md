# Model routing evaluation protocol

Question: can some reviews run on the cheaper model (GPT-6 Luna, no reasoning) instead of the configured model
(GPT-6 Sol, medium) without materially worse decisions, and does that save enough to be worth it?

This protocol is written before any shadow data is collected. The pass criteria in section 6 are fixed before the
tuning data is examined. Changing them later requires a dated note in section 9 explaining why.

A pass would show only that routing did not make decisions measurably worse than Sol on the situations seen. It would
not show that Sol, Luna or the app makes reliable investment decisions.

## 1. Shadow design

- Live routing stays off. Sol decides every review, as before.
- After each live review, Luna decides the same review in the background, on an independent copy of the exact context
  Sol received (the saved `review_contexts` row). Neither model sees the other's answer.
- Luna's run cannot change anything. Its read tools (market evidence, company research, screening, search) work
  normally. Its write tools (watchlist, review interval and watches, desk notes, triggers, conditional orders) answer
  "shadow run, not applied" and do nothing. Its output is never shown to Sol or to later reviews, never enters
  lessons, plans or the scout, and never places orders. It is stored only in `routing_eval`.
- Limitation: Luna is evaluated on the sequence of portfolio states Sol's decisions produced. Shadow mode cannot show
  what would happen after Luna's own decisions changed holdings and later context. That gap remains when moving to
  live routing, so live routing starts with the hard rules and spot checks described in section 8.

## 2. What each record holds

One `routing_eval` row per live review, keyed by the review id:

- The input: the review id, whose `review_contexts` row is the frozen context both models received.
- Features, each labeled with its source:
  - `snapshot`: the current context only.
  - `baseline`: compared with the context of the last Sol review.
  - `previous-review`: the previous review's outputs (its rating of the next decision, confidence, verdicts).
  No feature uses the current review's own output; everything is known before a model is chosen.
- The consequence gate and the difficulty score (section 3), and what a router at the default threshold would choose.
- Both decisions: action, symbol, quantity, plan, scout-target verdicts, the model's rating of the next decision and
  its uncertainty reasons.
- Tokens and cost for each side.
- An automatic triage of the difference (section 4), and later the adjudication (section 5).

## 3. Router under evaluation

Two separate questions, computed before choosing a model:

1. Consequence gate: is enough at stake to require Sol regardless? Measured against total portfolio equity:
   the largest held position's weight, and the largest new position the sizing rules allow (its weight of equity).
   It needs a market where the app can trade now. It does not depend on what any model proposes, so it can catch
   inaction. The 20% threshold is a policy choice, not a validated boundary.
2. Difficulty score (0-100): does this case need stronger reasoning? Signals are grouped by underlying event; a group
   counts its strongest signal, and distinct groups add:
   - price: a held stock or scout target moving since the last Sol review or from its previous close
   - market: regime change, breadth shift, extreme breadth, VIX jump
   - news: important news new since the last Sol review
   - events: earnings within a day (holdings, or candidates in a market that can trade now), major U.S. data
   - conflict: the scout plan wants more of a stock than the sizing rules allow; the last review passed on a target
     the scout still recommends
   - confidence: the last review had low confidence
   - agent rating: the previous review's rating of the next decision can only raise the score (both models), and
     only while nothing material has changed since that review.
   The trigger that started a review adds nothing by itself.

## 4. Automatic triage of differences

Each pair is triaged as one of:

- `same`: same action, symbol and quantity, same verdict on every scout target.
- `wording`: same decision and verdicts, different explanation. Immaterial.
- `verdict`: same trade decision, a scout-target verdict differs (waiting vs passed vs acted).
- `size`: same action and symbol, quantities differ by more than 25% or by at least 1% of equity.
- `action`: one model trades and the other holds, or they trade in opposite directions.
- `symbol`: both trade, different symbols.

`verdict`, `size`, `action` and `symbol` are candidates for adjudication. A candidate is not a miss.

## 5. Adjudication

Each candidate is judged on the information available at the time (the frozen context and the tool results each
model received), never on what prices did afterwards. A profitable outcome does not show sound reasoning.

Outcome, recorded separately:

- `sol-better`, `luna-better`, `both-defensible`, `both-wrong`, `immaterial`.

When one side is worse, the error category and severity:

- Categories: `missed-action` (should have acted, or changed a verdict, and did not), `wrong-action`, `sizing`,
  `constraint` (broke a portfolio rule, budget, session or sizing limit), `factual` (misread the context),
  `evidence-ignored`.
- Severity, by what the error puts at stake as a share of total equity: high at 10% or more, medium at 2-10%, low
  below 2%. A `constraint` error is at least medium.

A routing miss is a `sol-better` or `both-wrong`-with-Luna-worse adjudication on a review the router would have sent
to Luna. Adjudications are made in a session with the user (Claude proposes, the user confirms high-severity ones)
and stored in `artifacts/routing-eval/adjudications.jsonl` with the review id, outcome, category, severity, a
one-paragraph reason and the date judged.

## 6. Pass criteria (proposed: need the user's approval before tuning starts)

Evaluated on the evaluation period only (section 7), for the router at the tuned settings:

1. High-severity routing misses: 0.
2. Medium-severity routing misses: at most 1 per 50 Luna-routed situations, reported with a 95% upper bound.
3. Missed actions reported on their own, separate from wrong actions, sizing and constraint errors; any high-severity
   missed action fails.
4. Coverage: at least 10 distinct situations in each stratum: held positions, quiet, stress, event-driven. Fewer is
   "insufficient evidence", not a pass.
5. Net savings of at least 30% against Sol-only cost, after the consequence gate, hard rules, spot checks, retries
   and the shadow or audit calls themselves.

## 7. Situations, periods and uncertainty

- Reviews close together in the same market episode are correlated. Results count distinct situations: a run of
  consecutive reviews on one account with no material change between them (same scout plan, no price, market, news
  or event group change) is one situation.
- Tuning period: the first half of the situations collected. Evaluation period: the following, untouched half.
  Weights and thresholds are fixed before the evaluation period is examined.
- Rates are reported with Wilson 95% intervals. The time needed is set by coverage (section 6.4), not a calendar.

## 8. If it passes

Live routing starts with: the consequence gate, Sol for the first review after starting and of each regular session,
a limit on consecutive Luna reviews, Sol for any Luna trade or verdict change, and random spot checks (independent,
frozen inputs) across the full score range, monitored with the same triage and adjudication.

## 9. Changes to this protocol

- 2026-10-20: written before data collection.
