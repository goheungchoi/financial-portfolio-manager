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
4. **Partial** — Korea and U.S. holdings in one portfolio, valued in KRW and native currency. Combined equity should use settled cash so unsettled purchases are not counted twice.

### Portfolio view
5. **Partial** — Allocation charts by company, sector, region, market and currency. Planned: automatic sector/region classification from the security master (item 12).
6. **Partial** — Candle and price-history charts. Planned: U.S. candles, and a Charts window that can be popped out into its own window (original requirement, not yet built).
7. **Partial** — Current total money and earnings per period. Planned: daily NAV history, deposit/withdrawal adjustment, time-weighted return and a KOSPI / S&P 500 benchmark.
8. **Partial** — Clear trading history. Planned: import of trades placed outside the app so history and learning cover the whole account.

### AI agent
9. **Done, *changed*** — Engine: the app wakes the agent only when needed (interval the agent can choose, price moves, AI price watches, loss emergencies) through the OpenAI API with local budgets. *ChatGPT Plus / Dots is dropped:* Plus has no API access an app can use. The paper-only MCP bridge remains for external agents.
10. **Done** — Approval-first or automatic buying and selling, per market, with optional caps.
11. **Done, *new*** — **Autopilot guardrails** for unattended trading: a chosen response to the daily loss limit (emergency reviews, block new AI buys, or stop for the day), a daily automatic order cap, a stop after consecutive failed reviews, and a daily digest sent through the existing desktop/webhook alerts. The existing Stop auto trading button is the kill switch.
12. **Done** — **Market discovery:** daily KIS master files (KOSPI/KOSDAQ, NASDAQ/NYSE/AMEX) in a local security master with search; a KIS ranking screener (volume, gainers, losers, market value); a per-account watchlist the agent adds to (capped at 10 AI entries) whose symbols join review quotes. Follow-ups: fundamental/factor filters and automatic sector classification (item 5).
13. **Partial** — News and disclosures as inputs. Planned: a new disclosure or headline about a held or watched company triggers a review; issuer matching via the security master.
14. **Planned, *changed*** — Macro inputs from free official sources: Bank of Korea ECOS (rates, FX, CPI) and U.S. FRED, plus an economic calendar. *Analyst consensus is deferred:* there is no free licensed source; the field stays marked "not connected".
15. **Partial** — Self-improvement. Done: outcome ledger, lessons with a reviewed lifecycle, opt-in AI reflection, replay and forward lesson trials. Planned: benchmark and horizon evaluation, a scoreboard showing whether approved lessons improved results, and contradiction checks between lessons.
16. **Done** — AI console showing what the program and agent exchanged.

### Operations
17. **Partial** — Notifications: desktop and webhook, including guardrail alerts and the daily digest. No dedicated mobile app.
18. **Done** — Automated unit and Electron UI tests with fixtures; no real orders or paid calls in tests.
19. **Planned** — Signed installer and auto-update.

## Roadmap

Each step is planned, implemented, tested and committed on its own before the next starts.

| # | Feature | Why now |
| --- | --- | --- |
| 1 | ~~Autopilot guardrails (item 11)~~ Done | Unattended auto-trading is the main purpose; it needs a hard stop and a kill switch before the agent gets more reach. |
| 2 | ~~Market discovery (item 12)~~ Done | The agent can now screen and build a watchlist beyond holdings. |
| 3 | Event-driven news and disclosures (item 13) | Reacting to a disclosure within minutes is a core reason to automate. |
| 4 | Performance and settled cash (items 4, 7) | Correct cash and a benchmark are needed to judge both the agent and its lessons. |
| 5 | Learning scoreboard (item 15) | Builds on the benchmark from step 4. |
| 6 | Charts: U.S. candles and pop-out window (item 6) | User-facing completeness. |
| 7 | Macro inputs (item 14) | Useful context once discovery and events work. |
| 8 | Installer and auto-update (item 19) | Release hardening. |

## Testing with real credentials

Fixture tests stay the default. A run that imports the user's real KIS or OpenAI credentials through the app is done only with the user's go-ahead for that run, read-only on the account (no order submission), and with a small API budget.
