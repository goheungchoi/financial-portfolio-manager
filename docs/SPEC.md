# Financial Portfolio Manager — specification

What the app does, how each feature works, and which screen controls it. Written 2026-11-19 from the code at commit
`9c89338` plus the decided changes listed in section 8. The detail is in four reference parts beside this file:

| Part | File | Covers |
|---|---|---|
| 1 | `spec/1-ui.md` | Every screen, every control with its label, and the call behind it |
| 2 | `spec/2-orders-risk.md` | How an order is made and sent, the broker layer, cash rules, limits, stops |
| 3 | `spec/3-ai.md` | The AI agents: when they run, what they are given, what they may do, what they cost |
| 4 | `spec/4-data-platform.md` | Processes, storage, portfolio data and reports, updates, tests, release |

## 0. How this document is used

- **Before designing or reviewing a feature**, read the sections for the screens, settings and rules it touches.
  Ask the five questions in section 7. A feature that fails one is redesigned, not shipped.
- **Every change that adds or edits a feature amends this document in the same commit**: this file when a feature,
  screen, setting or rule appears, disappears or changes meaning; the part file for the detail.
- Statements here are "verified" (read in the code by the reviewer), "reported" (a helper's reading, not re-read)
  or "decided" (agreed with the user, not yet in the code). Section 9 says which is which. Line numbers drift;
  every reference also names an identifier to search for.

## 1. What the app is

A Windows desktop app (Electron) for one person's stock portfolio at the Korean broker KIS, in Korean and U.S.
stocks. It shows holdings, value and performance; lets the user place orders; and can run an AI "review" on a
schedule or on events, which decides Buy, Sell or Hold and, if the user allows, sends the order itself. Around the
review sit a research "scout", a market narrative, lessons learned from closed trades, stops the AI arms and the app
watches, and cash and risk rules that every order passes. A paper account practises the same flow without a broker.

It trades only: limit orders, 1 to 10,000 whole shares, Korean six-digit codes and U.S. NASD/NYSE/AMEX symbols.

## 2. Architecture in one page (Part 4 §1)

- **Processes.** Main (all logic), a sandboxed renderer (screens only), and three private workers started by one
  class, `KisService`: the KIS broker worker, the AI provider worker, the calendar worker. Only workers open key
  files and hold keys; only fixed error codes come back from them.
- **Renderer boundary.** The page calls `window.portfolio.*` (`electron/preload.cjs`), each mapped to one IPC
  channel checked by `authorize()` (`electron/main.cjs`). The page has no network access of its own.
- **State to the screens.** Five pushed channels (market, events, theme, update, chart tick); everything else is
  polled every two seconds.
- **One clock.** `publishMarket` runs once a second and drives the paper account, `Automation.tick()` (reviews,
  scout, stops every 5 s, order tracking every 3 s), reconciliation every 30 s, notifications and news.
- **Storage.** One file, `%APPDATA%\Financial Portfolio Manager\portfolio.sqlite` (119 tables, most an id plus a
  JSON payload). No migration runner and no backup code. Credentials are never stored: only the path of the file
  the user imported.
- **Lifecycle.** Single instance, no tray: closing the window quits, and nothing is watched while the app is
  closed. After every start the session is **paused**: nothing automatic runs, stops included, until Start auto
  trading. Each market's "trading on" and "automatic" switches live in memory and are off after every start.

## 3. Feature map

Each row: the feature, where the user meets it, the settings that govern it, and where the detail is.

### 3.1 Portfolio and reports

| Feature | Screens | Governed by | Detail |
|---|---|---|---|
| Account value, cash, day result | Home tiles | — (valuation rules) | P4 §3.1, P1 Home |
| Holdings, allocation, exposure, movement | Home card, Holdings | — | P1 Holdings |
| Company view, candles, indicators, research panel | Charts, pop-out window | — | P1 Charts, P4 §3.6 |
| Performance against benchmarks, drawdown, corrections | Performance | — | P4 §3.3 |
| Cash-flow detection ("cash checks") | Home "Needs you" line | — | P4 §3.3 |
| Order history, Today strip, origin of each order | Activity | period on screen | P1 Activity, P4 §3.4 |
| Realized P&L (KIS's Korean report) | Performance | — | P4 §3.4 |
| Fees, taxes, income | Fees & taxes | cost and tax profile | P4 §3.5 |
| Market sessions and calendars, dated exceptions | Home Markets strip | extended-session switches | P2 §2.8, P4 §3.8 |

### 3.2 Trading

| Feature | Screens | Governed by | Detail |
|---|---|---|---|
| The user's own order ticket | Korea, U.S. | "Activate for this session", limits | P1 Korea/U.S., P2 §3.4–3.5 |
| Automatic sending of AI orders | Korea, U.S., Home Start | **"Allow automatic … orders" per market** (turned on by Start auto trading), "Place orders automatically" | P2 §3.6 |
| Limits ("policy"): stocks allowed, max order, daily turnover, per-company share, daily loss limit | Korea, U.S. | the fields on each tab (blank = none) | P2 §3.12 |
| Cash rules: KIS buying power and the shared funding ledger | not shown today | none (fixed) | P2 §4 |
| Several open orders, several orders per review | Engine → Trading | "Several open orders", "Orders per review" | P2 §3.11 |
| Order tracking (moving an open order with the price) | Engine → Trading | "Order tracking" | P2 §3.9 |
| Stops and other conditional orders, trailing stops | Journal → Orders and triggers | Engine: conditional orders, "Submit them automatically", trailing stops, caps | P2 §6 |
| Leveraged and inverse ETFs, margin, short selling | Short & leverage | the switches and caps there | P2 §5.1–5.2 |
| Daily loss limit response, daily automatic order cap, stop after failed reviews | Engine → guardrails | "When a daily loss limit is hit", caps | P2 §5.3–5.4 |
| Extended sessions (NXT, U.S. pre/after/daytime) | Engine | session switches, size cap | P2 §5.5 |
| Paper account | Paper | paper settings | P2 §3.14 |

### 3.3 AI

| Feature | Screens | Governed by | Detail |
|---|---|---|---|
| Start / Stop auto trading | Home, top-bar chip | 14 conditions refuse Start; Stop is never refused | P3 §1.9 |
| Trading review and its 11 triggers | Home AI activity, Console, Journal | Engine → Schedule and triggers | P3 §1.4 |
| Skips without a model call, review gate | Console | Engine | P3 §1.6 |
| Pending decisions (made while a market is closed) | Journal | — | P3 §1.7 |
| Scout (research plan, shortlist, briefs) | Discover | Engine → Agents, scout slots | P3 §2.4 |
| Market narrative | Discover | Engine → Agents | P3 §2.5 |
| Lessons, trials, scoreboard, position memory | Journal | approval by the user | P3 §2.6 |
| Research tools the model may call | Console | data keys in Connections | P3 §2.7 |
| Models per agent, effort | Engine → Agents | model rows; Claude rules | P3 §2.2 |
| Dry run and replay | Home (Dry run), Journal → Replay | — | P3 §3.8 |
| Budgets, usage, token saving | Engine, Connections provider cards | daily calls and USD per provider | P3 §4 |
| Consent to share KIS data, keys | Connections | per-provider switches | P3 §4.6 |
| Instructions and their fingerprint | not shown | fixed text + the user's guidelines | P3 §3.1 |

### 3.4 Platform

| Feature | Screens | Governed by | Detail |
|---|---|---|---|
| Connections (KIS, calendar, AI, news, SEC, alert keys) | Connections | imported files | P1 Connections, P4 §2.3 |
| In-app updates | Connections → App updates | manual download and install; refused while armed, reviewing or with open orders | P4 §4.1 |
| Start with Windows | Engine | the switch (read from Windows) | P4 §1.5 |
| Alerts to desktop and phone, start notice, digest | Engine → Alerts | webhook key, switches | P4 §4.2 |
| "Needs you" list (20 kinds of item) | Home | — | P1 Home → AttentionPanel |
| News, macro, watchlist | News, Macro, Discover | feeds, keys | P4 §3.9–3.11 |

## 4. How an order happens (Part 2 §7)

1. A proposal is saved as an order record with status **Ready** (it expires after 120 seconds). It comes from a
   review, a conditional order that fired, or the user's ticket; the record keeps which (`madeBy`) and, when sent,
   whether automatically or by the user (`sentBy`).
2. It is **sent** by the user or automatically, through one function that runs every check again: the market
   switched on and not expired; the open-order rule; the saved limits; daily turnover.
3. A fresh balance of the **other** market is read, then the order holds the KIS queue for its **check** at KIS
   (session, price within 2%, KIS's buying power, other open orders), which returns a 15-second ticket.
4. On the checked balance: extended-session rules, product and credit approval, per-company share, the app's
   buying-power check, then the **funding ledger**: every buy in either market must fit **won cash**, with U.S.
   amounts at the rate plus 2%; dollars are not counted. Then the daily-loss restriction.
5. **Placement** with the ticket. A KIS refusal ends Rejected with KIS's code; an unclear reply ends Uncertain.
6. Open orders are reconciled with KIS every 30 seconds and moved with the price every 3 seconds if tracking is on.
7. A refusal that concerns the order alone ("ORDER" codes) is recorded as "Not sent" or "Rejected by KIS" and the
   review completes; one that means the app or account state is wrong ("STOP" codes), or an unknown one, fails the
   review.

## 5. How a review happens (Part 3 §1.10)

A trigger fires → the context is assembled (accounts, holdings, quotes, limits, plan, memory, scout plan, desk,
previous review) and fitted to a size budget → the call is reserved against the provider's daily budget → the model
answers in a fixed form (decision, plan, verdicts, optionally more orders) → fifteen checks (an incomplete plan or an
unexplained reversal turns a Buy into a Hold) → orders go to the engines of section 4 → the review row and Console
lines are written → one-off triggers are consumed. Only the trading review can cause an order, and it has no order
tool: the app places what the checked answer says.

## 6. Design principles (constraints on every change)

From the user, with the day they were set:

1. **A switch does what its label says.** No rule underneath a switch may override it silently, and no second
   gate is added where a switch already states the user's decision. (2026-11-19, the U.S. automatic-orders switch.)
2. **Nothing that stops or limits what the app may trade ships without its own plain question to the user**, and
   a line in the release notes. Approval of a design as a whole does not cover it. A condition that can never be
   met is a permanent block and is presented as one. (2026-11-19.)
3. **The built-in instruction text is clear and reasonable and pushes no trading or portfolio strategy.** Such
   preferences are the user's (their guidelines). Prefer telling the model a fact in its context over changing the
   instruction text. (2026-11.)
4. **A new Claude dry run is demanded only when an update can disrupt reviews or make them fail.** (2026-11-18.)
5. **Whatever can refuse an order is told to the model, shown to the user, and has words.** A refusal path has a
   test in which the model decides the refused thing. (2026-11-19 audit.)
6. **Never read or change the credential files; live calls are read-only; no order by anyone but the app on the
   user's switches.**
7. **Commit, push, publish, install, database writes, opening or closing the app: the user's word**, local commits
   under their standing approval after review.
8. **Settings screens follow the approved card and row style**: short text, details behind More.

## 7. Does a new feature fit? Five questions

1. **Is there already a switch, setting, rule or screen for this?** Search section 3 and Part 1's settings table.
   If yes, extend it; do not add a parallel one.
2. **Does it stop, hold, shrink or redirect any order, or change what is sent?** Then principle 2 and 5 apply:
   the question to the user, the model's fact, the screen text, the words, the refusal test.
3. **Does it change what a model is given or asked?** Say which agent, which context field or instruction part,
   whether the fingerprint changes, and whether a dry run is demanded under principle 4.
4. **What happens after a restart, with the session paused, with a market closed, and when KIS refuses a
   request?** Every feature states its behaviour in those four states.
5. **Where does the user see it, and where is it recorded?** A screen, a Console line, a table. A feature that
   leaves no trace cannot be diagnosed.

## 8. Decided changes not yet in the code at `9c89338`

| Change | State | Spec text that follows it |
|---|---|---|
| Automatic U.S. buys are no longer blocked; the U.S. "Allow automatic … orders" switch covers buys and sales; the ledger's won rule and KIS buying power are the checks; the model and the U.S. tab are told U.S. buys are counted against won cash | being built for 1.5.69 | §3.2 row "Automatic sending", §4 step 4, P2 §9.1 |
| Only Start and Stop arm or disarm a session; a settings save never does | found 2026-11-19, fix not designed | P3 §1.9, P1 Engine settings |
| Release of a cancelled buy's unfilled remainder from the funding ledger | design wanted, question for the user drafted | P2 §4.1 |
| A longer window for anything held for approval | question for the user drafted | P2 §3.6 |
| Dry-run demand narrowed to changes that can fail a review | designed 2026-11-18, not built | P3 §3.7 |

## 9. Known limits and what is verified

**Known limits stated as current behaviour** (audit of 2026-11-19, `artifacts/reviews/2026-11-19-order-rule-audit/`):
a cancelled or expired buy keeps its unfilled amount committed for good; the over-committed flag never clears;
anything held for approval expires after 120 seconds; an unclassified product is held with its reason not shown; all
four Korean credit order types can never be sent although their switches exist; the instructions rule out U.S.
leveraged ETFs although the switch exists; the fixed order constants (last order 10 minutes before the close, the
2% price check, the 2% cash cushion, the $1 U.S. minimum) are not told to the model; saving an Engine setting
re-arms a paused session; no backup and no migration runner; nothing is watched while the app is closed.

**Verification.** The four parts were written by read-only helpers from the code. The reviewer read in the code:
the order path's send and autoSubmit, the funding ledger's check and commitment states, the worker's code mapping,
the feed labels, the Activity modules, the scout failure and retry path, Start and Stop, the dry-run gate, the
session re-arm line, the compacting consent line, and the live settings quoted in the audit. Everything else in the
parts is reported, with file and line, and each part ends with its own "Not determined" list. Part 1's per-screen
sections were merged from five reading passes and only spot-checked by their author. No confirmation phrase is
typed by the user anywhere: each button sends its phrase and the engine checks it (Part 1 §2, Part 2 §1).

## 10. Amending this document

In the commit that changes the feature: update the row in section 3, the step in section 4 or 5 if the flow
changes, section 8 (remove the row once the code matches), section 9 (a limit added or removed), and the part's
section with file and identifier. A handoff names the sections to amend; a review does not clear a commit whose
spec amendment is missing.
