# Financial Portfolio Manager — requirements audit

Audited 15 October 2026 (Asia/Seoul). Baseline: the user's original program description and later requests in this conversation, checked against current source and fixture tests. This is an implementation audit, not a certification of trading performance or broker compatibility. No private credential file was inspected.

## Findings

The application has a working desktop, portfolio, review and execution foundation. **The original continuous self-improvement requirement is only partially implemented.** Persisted history and approved context memory exist; autonomous outcome analysis, validated learning and measured improvement do not. Broad market research and discovery are also incomplete.

“Implemented” below means present in code, with relevant automated checks where stated. “Partial” means a narrower capability exists than originally described. “Missing” means no working implementation was found. “Unverified” distinguishes external behavior from fixture behavior; a passing fixture test does not establish live brokerage execution.

## Requirement coverage

| Requirement | Status | What exists / what remains |
| --- | --- | --- |
| Standalone Electron desktop application | Implemented, Windows scope | Electron + React, portable executable. Signed installer, updater, macOS/Linux distributions are missing. |
| React versus jQuery comparison | Documented in this audit | See [UI architecture decision](UI-ARCHITECTURE.md). React is the implemented stack; no jQuery version exists. |
| KIS account and API connection | Implemented; external execution partly unverified | Private worker, authentication, import, normalized account data, reconnect and remembered file references. The user confirmed account refresh and display of a manually purchased U.S. holding. That does not verify every order endpoint. |
| Credential JSON excluded from AI access | Implemented in current API model path | Credential files are read in private utility workers; model context contains normalized portfolio data. Provider keys are not stored in SQLite. File paths and financial history are locally persisted; the database is not an encrypted credential vault. |
| Responsive financial data / 1 Hz or 30 Hz ticks | Partial | UI publication at 1 Hz; domestic stream for up to 20 held symbols, REST quote fallback around 30 seconds, domestic balances around 120 seconds, U.S. REST refresh around 30 seconds when broker capacity permits. No selectable 30 Hz renderer mode or U.S. streaming feed. |
| Korea and foreign holdings in one portfolio | Partial | Korea + supported U.S. NASDAQ/NYSE/AMEX cash equities; combined indicative KRW valuation with native USD/KRW values. Other foreign exchanges, derivatives and fractional-share execution are not implemented. |
| Company / sector / region allocation charts | Partial | Interactive donut/ranked bars, company/sector/region/market/currency grouping, market filter, cash toggle. Sector/exposure labels are user-editable; automatic classification, revenue geography and ETF constituent look-through are missing. |
| Dark/light toggle and same-window console navigation | Implemented | Theme persistence and shared sidebar navigation. Automated theme/navigation checks cover both themes at two viewport sizes. |
| Signed equity change next to totals | Implemented | Positive/negative/zero changes and layout geometry covered by UI regression tests. These are valuation changes, not necessarily investment returns. |
| Save settings and preserve drafts across tabs | Implemented within session | Saved settings reload; unsaved drafts survive navigation. Reload/exit discards drafts. Tests cover important settings, news, paper and KIS forms; not every field combination is exhaustively tested. |
| AI reviews and event-driven scheduling | Implemented foundation | Optional OpenAI API provider; interval, price-movement and loss-emergency triggers; local demonstration provider; approved memory and guidelines. The model makes one bounded decision per review. New news/disclosures do not independently trigger review. |
| Affordable AI with ChatGPT Plus / Dots | Partial alternative | OpenAI API integration and paper-only external-agent bridge. No native Plus subscription/Dot integration. Fixed USD 0.01/request reservation is a local budget estimate, not an actual token-cost ledger or guaranteed provider spending cap. |
| Agent goals and guidelines | Implemented | Saved free-text guidelines plus built-in instructions and cost context. No tested evidence that these goals maximize return or minimize future loss. Local demonstration rules do not interpret natural-language guidelines. |
| AI can discover opportunities across all stocks | Missing | Review universe is holdings or up to 20 selected symbols per market. Cash-only accounts with no selected symbols have no discovery universe. No market-wide screener, instrument search/security master or autonomous watchlist construction. |
| Automatic buy/sell and approval-first option | Implemented mechanics; external behavior unverified | Separate review scheduling, per-market activation, per-market automatic permission, global automatic-submission preference, native cash/share/price/session checks, durable intent before POST and reconciliation. No blanket statement that live execution is production-validated. |
| Flexible allocation; 100% single company allowed | Implemented | Caps optional and off by default. Explicitly configured caps remain enforced. Broker capacity, supported order types and technical size constraints still apply. |
| Loss tolerance in money or percent; emergency response | Partial | Per-market daily baseline triggers emergency reviews instead of blocking orders. No cash-flow-adjusted combined-portfolio drawdown rule, validated profit-protection strategy or guarantee that a suggested rebalance reduces loss. |
| Clear trading history and results | Partial | Paper fills; domestic broker order/activity and realized-profit query; app-originated U.S. intent/fill journal. Complete U.S. broker-history import, external-order linkage, correction/corporate-action accounting and full tax-lot accounting remain missing. |
| Fees/taxes in sale results and provider decisions | Partial | Editable estimates and Korean individual foreign-share annual capital-gains model; cost context supplied to providers. Domestic broker-reported actual fee fields are retained when available. U.S. estimates are not settled fee/tax statements. Historical FX/basis and all-broker annual gains need user input/updates. No automatic account-plan discovery or final tax filing engine. |
| Candle/price-history charts in their own tab | Partial | Domestic/synthetic candles or line, volume, SMA20, range and inspection controls. U.S. history/candle integration is missing. |
| Current total money and earnings by period | Partial | Native and combined indicative equity, unrealized results, domestic period realized query. No complete unified historical NAV, deposit/withdrawal adjustment, time-weighted/money-weighted return, benchmark comparison or validated cross-currency earnings report. |
| News and corporate disclosures | Partial | One configured public RSS/Atom feed and optional latest-day OpenDART disclosures. No guaranteed broad/real-time coverage, full disclosure pagination/history, licensed article corpus, issuer relevance ranking or U.S. SEC filing integration. |
| Company consensus and macro/geopolitical factors | Missing as structured inputs | No consensus/earnings-estimate provider, economic calendar, macro series, geopolitical event pipeline or corresponding trigger engine. Manually supplied headlines are not a substitute. |
| AI console shows program–agent interaction | Implemented | Supplied context, decision/explanation, risk/tool events, token counts and local export. Private internal reasoning is intentionally not exposed. Context/event retention is bounded. |
| Continuous self-improvement | Partial; see below | Generic candidate lessons and manually approved memory only. No complete automated broker-trade outcome-analysis/learning pipeline. |
| Scriptable manager for an external agent | Partial | MCP stdio bridge and local pipe for paper snapshots/proposals/decisions. No external live/KIS order-control API or general desktop scripting environment. |
| Trade notifications on mobile | Partial | Desktop alerts plus persisted webhook outbox/retries. Requires a configured compatible service. No dedicated mobile app; remote control was deferred by the user's later “Desktop only for now” choice. |
| Automated UI testing | Implemented and expanded in this change | Repeatable Electron tests, reports, screenshots, theme/viewport/navigation/layout checks, mock approvals, settings and restart recovery. CI workflow configured; no remote CI execution is claimed. Native dialogs are stubbed and no real orders/paid AI calls are made. |

## What “self-improvement” currently means

Evidence: `electron/automation.cjs`, `electron/paper-engine.cjs`, `electron/live-engine.cjs`, `src/RuntimeSettings.tsx`, `tests/runtime.test.cjs`.

1. Reviews persist their trigger, provider, decision/explanation, proposal/order links and token usage. Paper fills and app broker intents/results are stored separately.
2. A proposal rejected by app checks can produce a generic candidate lesson. This is not a diagnosis of the investment thesis.
3. Each newly observed losing **paper** sale produces one generic candidate lesson. It explicitly says a loss alone does not establish that the decision was wrong. `reviewed_fills` prevents repeated generation for that fill.
4. The user approves/removes lessons in Journal. Approved rows survive restart; only the latest five approved texts enter each later review. The new memory test verifies one-time generation, persistence, approval, inclusion and removal.
5. This loop does not change model weights, rewrite risk policy or establish that performance improved. It currently does not generate these outcome lessons for broker sales, winning trades, missed opportunities or Hold decisions.

Missing parts of the requested learning loop:

- A durable, complete decision → proposal → broker order → cumulative fills → position/exit outcome link, including externally placed trades.
- Post-trade evaluations after fees, taxes and FX, using explicit horizons and benchmarks. A price move after a trade does not by itself establish causation or a mistake.
- Evidence-based explanations distinguishing thesis error, execution problems, costs, data gaps, ordinary adverse outcomes and market regime changes.
- Structured lessons with source decisions, confidence, scope/account/market, evidence, applicability, review dates, deduplication, contradiction handling and retirement.
- Retrieval by relevance rather than “last five approved texts”; isolation between simulation and broker experience.
- Validation of proposed lessons on held-out historical/paper cases; comparison against an unchanged strategy, including downside and turnover after costs.
- An affordable, scheduled reflection worker with visible status, separate budget, retries and backlog. No such paid reflection worker is running now.
- A dashboard measuring whether approved changes improved out-of-sample behavior. No performance claim can currently be made.

## Recommended implementation order

1. **Outcome ledger and evaluation:** link broker fills to decisions; handle partial fills idempotently; preserve native currency, cost assumptions and evidence. Separate broker-reported results from estimates.
2. **Learning pipeline:** generate structured candidate reflections from that ledger, show evidence in Journal, retrieve relevant approved lessons, and evaluate changes in paper replay before promoting them. Keep an explicit opt-in boundary for changes that affect execution.
3. **Market discovery and research:** searchable security master/watchlist, screened candidates, relevant disclosures/news, then licensed consensus and macro sources. Report unavailable coverage honestly.
4. **Unified charts and performance:** U.S. candles/history, broker-history reconciliation, cash-flow-aware historical portfolio returns and tax/basis import.
5. **Release and operational hardening:** exact API-cost ledger, signed distribution/update strategy, broader failure/recovery and external mock-account validation. Continue regression testing every change.

The existing desktop/approval/credential boundaries should be kept while implementing these steps. This audit does not authorize real trades, paid reflection runs, changing user guidelines or enabling automation.

## Validation and remaining test limits

Run `npm run validate` for type checks → build → unit tests → Electron UI suite → portable packaging → isolated startup verification. Run `npm run test:ui` for the UI suite alone. See [testing guide](TESTING.md).

The suite covers fixture behavior. The user's successful balance refresh and displayed U.S. holding are useful integration evidence, but do not establish autonomous trade quality, all KIS permissions, mobile delivery, tax correctness for every product, live settlement reconciliation or profitable adaptation. Screenshot capture and layout geometry checks are not a trained visual-difference model. No backtest/walk-forward strategy evaluation, model-output quality evaluation suite or broker production certification exists.

## Follow-up: outcome ledger foundation

Added a durable derived ledger for app-originated broker executions and paper fills. Journal shows linked decisions, cumulative executed quantity, average execution price (new broker reconciliations), net cash, after-fee outcomes, and estimated-tax availability. Repeated cumulative broker reports replace the same outcome rather than double-counting. Paper fills aggregate by order. Manual approval links through the original proposal. Decision and proposal links are now saved before automatic submission, so a failed submission does not erase the recommendation.

Raw local ledger evidence preserves account partition, broker order reference and captured cost assumptions; renderer summaries omit account identity. Unknown costs remain unknown. No cross-currency performance total is computed. Broker results remain cost estimates, and older records may lack actual fill prices or observation times. The view covers the latest 100 outcomes; records persist beyond that.

This completes the first ledger foundation, not full outcome evaluation: external trades, entry-to-exit tax lots, benchmarks/holding horizons, causal reflection, relevant lesson retrieval and validated strategy improvement remain outstanding. No new paid AI calls or automatic lesson promotion were introduced.

## Follow-up: research tools and structured memory

See [Agent evidence and alerts](AGENT-EVIDENCE.md) for the current increment: bounded read-only model tool calls, KR/U.S. company snapshots and technical calculations, AI-adjustable review thresholds, and evidence-linked sale checklists with account/symbol-aware approved-memory retrieval. This supersedes the earlier snapshot-only API and generic-only learning descriptions. ROE/consensus adapters, full historical evaluation and validated autonomous strategy improvement remain outstanding.


## 2026-10-16 — Workspace usability

- Removed page search and synthetic portfolio fallback from Overview/Holdings/Charts; disconnected/connecting accounts show a connection state. Paper simulation is explicitly selected.
- Global Start auto trading uses saved scope, provider, guidelines and caps, activates the selected funded sessions, opts into automatic submission and starts a review. The label identifies PAPER/MOCK/LIVE and markets. Account/configuration fingerprint rejects stale clicks. OpenAI sharing and API budget prerequisites remain explicit. Stop disables new automatic orders; already accepted broker orders are not canceled. Restart remains paused.
- Paper screen separates account, metrics, manual practice and collapsed settings/fill details. Removed synthetic quote ticker, repeated status messages, console Run demo and production developer-tools menu. Scripted demo IPC is test-only.
- Journal has Trades, Decisions and Reviewed lessons views. AI console remains an independent interaction log, with no journal records embedded.
- News retained as a headline/disclosure input to AI: source configuration, freshness, filtering and empty/error states. Partial source failure retains successful items; newest items first. No complete news coverage or full article reading claimed.
- Charts includes read-only Korean/U.S. company lookup, day/52-week ranges, PER/PBR/EPS/BPS and daily/minute MA5/10/20 and fast stochastic. Price candles/line and volume use broker data. ROE/consensus unavailable until additional adapters exist. Data is cached for 30 seconds, explicitly refreshed, and may be delayed. Five-minute chart bars are aggregated; indicators remain based on one-minute completed bars in intraday mode.


## 2026-10-16 — Versioned outcome evaluation and supervised learning

See [Learning pipeline](LEARNING-PIPELINE.md). Added economic evidence versions, retraction handling, cost-drag/return evaluation, decision-time context capture, structured candidates, a continuous local evaluation pass, editable applicability and notes, approval/renewal/retirement/expiry, stale-approval rejection, and account/symbol-aware retrieval. Journal now exposes evidence versions and the learning queue. This supersedes the earlier generic-checklist-only description, but not the remaining replay, benchmark, causal-reflection and external-trade gaps.

The same update adds user-selectable Sol/Astra models and reasoning, model-aware local request reservations and per-call token-cost estimates. Existing selections and budget amounts are preserved. No paid model calls or live trades were used for validation.


### 2026-10-16 — Post-trade reflection
Implemented durable evidence-versioned reflection jobs, separate daily budget/call limits, opt-in normalized-data sharing, bounded retries/restart recovery, tool-free structured hypotheses and Journal draft adoption. Approval remains explicit. Replay/held-out validation, external trade import, complete lot matching and automatic strategy promotion remain outstanding.

### 2026-10-16 — Navigation, monitoring cadence and replay foundation
Holdings company names open the matching Charts view. Allocation segments expose value, weight and constituent details on hover/focus. Auto review interval lets the agent choose 1–60 minutes per account/scope while budgets, enablement and emergency timing remain independent. KIS requests use more conservative spacing, escalating 1–5 minute cooldowns, a shared parent-process cooldown and 60-second U.S. background refreshes; production duplicate instances are blocked. Other programs sharing the API key can still consume broker quotas.

Charts includes a deterministic offline loss-threshold comparison against buy-and-hold using earlier/later daily-bar partitions. This is an explicit-rule research illustration, not general natural-language lesson validation or automatic promotion. See LEARNING-PIPELINE.md for execution/cost assumptions and exclusions.
