# Requirements and roadmap

Revised 16 October 2026 from the original proposal. Current status for each item lives in [FEATURE-AUDIT.md](FEATURE-AUDIT.md); this file says what the app should become and in which order.

## Purpose

Let an AI agent manage a Korea Investment (KIS) portfolio automatically, safely and affordably while the user cannot trade, and let the user see at a glance what the portfolio looks like and what the agent did.

## Requirements

Status: **Done**, **Partial** or **Planned**. Items marked *changed* differ from the original proposal; the reason follows.

### Platform and data
1. **Done** — Standalone Electron + React desktop app (React chosen; comparison in [UI-ARCHITECTURE.md](UI-ARCHITECTURE.md)).
2. **Done** — KIS account and KIS Developers API key supplied by the user in a JSON file. Credential and provider files are read only by private workers; the AI never sees them.
3. **Partial, *changed*** — Market data refreshes the UI at 1 Hz. *30 Hz is dropped:* KIS REST limits and the 20-symbol stream cap make 30 Hz meaningless for decisions taken minutes apart.
4. **Partial** — Korea and U.S. holdings in one portfolio, valued in KRW and native currency. Korean cash now uses settled (D+2) cash, so unsettled purchases are no longer counted twice. U.S. settlement is not yet modelled the same way.

### Portfolio view
5. **Partial** — Allocation charts by company, sector, region, market and currency. Planned: automatic sector/region classification from the security master (item 12).
6. **Partial** — Candle and price-history charts. Planned: U.S. candles, and a Charts window that can be popped out into its own window (original requirement, not yet built).
7. **Done** — Current total money and earnings per period: daily account-value history, recorded deposits/withdrawals, time-weighted returns and KOSPI / S&P 500 benchmarks. Follow-ups: automatic transfer detection, money-weighted return.
8. **Partial** — Clear trading history. Planned: import of trades placed outside the app so history and learning cover the whole account.

### AI agent
9. **Done, *changed*** — Engine: the app wakes the agent only when needed (interval the agent can choose, price moves, AI price watches, loss emergencies) through the OpenAI API with local budgets. *ChatGPT Plus / Dots is dropped:* Plus has no API access an app can use. The paper-only MCP bridge remains for external agents.
10. **Done** — Approval-first or automatic buying and selling, per market, with optional caps.
11. **Done, *new*** — **Autopilot guardrails** for unattended trading: a chosen response to the daily loss limit (emergency reviews, block new AI buys, or stop for the day), a daily automatic order cap, a stop after consecutive failed reviews, and a daily digest sent through the existing desktop/webhook alerts. The existing Stop auto trading button is the kill switch.
12. **Done** — **Market discovery:** daily KIS master files (KOSPI/KOSDAQ, NASDAQ/NYSE/AMEX) in a local security master with search; a KIS ranking screener (volume, gainers, losers, market value); a per-account watchlist the agent adds to (capped at 10 AI entries) whose symbols join review quotes. Follow-ups: fundamental/factor filters and automatic sector classification (item 5).
13. **Done** — News and disclosures as inputs and triggers: matched to portfolio symbols, important DART filings flagged, news-triggered reviews batched every 10 minutes at most. Follow-ups: U.S. SEC filings, alias matching (abbreviations), licensed news.
14. **Planned, *changed*** — Macro inputs from free official sources: Bank of Korea ECOS (rates, FX, CPI) and U.S. FRED, plus an economic calendar. *Analyst consensus is deferred:* there is no free licensed source; the field stays marked "not connected".
15. **Partial** — Self-improvement. Done: outcome ledger, lessons with a reviewed lifecycle, opt-in AI reflection, replay and forward lesson trials. Planned: benchmark and horizon evaluation, a scoreboard showing whether approved lessons improved results, and contradiction checks between lessons.
16. **Done** — AI console showing what the program and agent exchanged.

### Operations
17. **Partial** — Notifications: desktop and webhook, including guardrail alerts and the daily digest. No dedicated mobile app.
18. **Done** — Automated unit and Electron UI tests with fixtures; no real orders or paid calls in tests.
19. **Planned** — Signed installer and auto-update.
20. **Planned, *new*** — **Token saving:** skip AI calls when nothing relevant changed since the last review; route routine reviews to a cheaper model and escalate to a stronger one for emergencies, important disclosures and any trade (the stronger model confirms trades); order context so stable parts are cached; send compact, delta-style context; prefetch commonly requested evidence to avoid tool round trips; run reflections at a discounted batch tier where available; degrade (cheaper model, longer interval) near the daily budget instead of stopping. Measure cost per review before and after.
21. **Planned, *new*** — **Accurate fees and taxes:** replace estimates with broker-reported figures per execution (KIS order/fill inquiries report commission and tax for domestic and overseas trades), and model South Korean taxes on overseas stocks precisely (annual capital-gains tax on net foreign gains above the basic deduction, using KRW amounts at settlement-date exchange rates across all brokers). Keep estimates only where the broker has not reported yet, and label them.

## Roadmap

Each step is planned, implemented, tested and committed on its own before the next starts.

| # | Feature | Why now |
| --- | --- | --- |
| 1 | ~~Autopilot guardrails (item 11)~~ Done | Unattended auto-trading is the main purpose; it needs a hard stop and a kill switch before the agent gets more reach. |
| 2 | ~~Market discovery (item 12)~~ Done | The agent can now screen and build a watchlist beyond holdings. |
| 3 | ~~Event-driven news and disclosures (item 13)~~ Done | Relevant disclosures now start a review within minutes. |
| 4 | ~~Performance and settled cash (items 4, 7)~~ Done | Returns are now measured against KOSPI / S&P 500 with deposits excluded. |
| 5 | Learning scoreboard (item 15) | Builds on the benchmark from step 4. |
| 6 | Charts: U.S. candles and pop-out window (item 6) | User-facing completeness. |
| 7 | Macro inputs (item 14) | Useful context once discovery and events work. |
| 7b | Accurate fees and taxes (item 21) | Requested as a side item; uses broker-reported fees and taxes per execution. |
| 8 | Token saving (item 20) | Best done once the context and tools are stable, so savings are measured against the final workload. |
| 9 | Installer and auto-update (item 19) | Release hardening. |

## Testing with real credentials

Fixture tests stay the default. A run that imports the user's real KIS or OpenAI credentials through the app is done only with the user's go-ahead for that run, read-only on the account (no order submission), and with a small API budget.
