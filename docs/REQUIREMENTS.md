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
6. **Done** — Candle and price-history charts for Korean and U.S. stocks (about 200 adjusted daily bars, or today's minute bars), labeled in the exchange's own time zone with USD cents, and an **Open in new window** pop-out (one chart window per symbol, follows the theme, refreshes every minute, closes with the app). Follow-ups: longer intraday history and drawing tools.
7. **Done** — Current total money and earnings per period: daily account-value history, recorded deposits/withdrawals, time-weighted returns and KOSPI / S&P 500 benchmarks. Follow-ups: automatic transfer detection, money-weighted return.
8. **Partial** — Clear trading history. Planned: import of trades placed outside the app so history and learning cover the whole account.

### AI agent
9. **Done, *changed*** — Engine: the app wakes the agent only when needed (interval the agent can choose, price moves, AI price watches, loss emergencies) through the OpenAI API with local budgets. *ChatGPT Plus / Dots is dropped:* Plus has no API access an app can use. The paper-only MCP bridge remains for external agents.
10. **Done** — Approval-first or automatic buying and selling, per market, with optional caps.
11. **Done, *new*** — **Autopilot guardrails** for unattended trading: a chosen response to the daily loss limit (emergency reviews, block new AI buys, or stop for the day), a daily automatic order cap, a stop after consecutive failed reviews, and a daily digest sent through the existing desktop/webhook alerts. The existing Stop auto trading button is the kill switch.
12. **Done** — **Market discovery:** daily KIS master files (KOSPI/KOSDAQ, NASDAQ/NYSE/AMEX) in a local security master with search; a KIS ranking screener (volume, gainers, losers, market value); a per-account watchlist the agent adds to (capped at 10 AI entries) whose symbols join review quotes. Follow-ups: fundamental/factor filters and automatic sector classification (item 5).
13. **Done** — News and disclosures as inputs and triggers: matched to portfolio symbols, important DART filings flagged, news-triggered reviews batched every 10 minutes at most. Follow-ups: U.S. SEC filings, alias matching (abbreviations), licensed news.
14. **Done, *changed*** — **Macro inputs** from free official sources: Bank of Korea ECOS (base rate, USD/KRW, 3- and 10-year KTB yields, CPI inflation) and FRED (effective fed funds, 2- and 10-year Treasuries, CPI inflation, unemployment, VIX), refreshed every 6 hours, shown under Research → Macro and given to the AI as background with the next two weeks of U.S. releases (CPI, jobs, GDP, FOMC, PPI, PCE, retail sales, JOLTS) from the FRED release calendar. Works without keys (FRED downloads, ECOS sample access); an ECOS key lifts the 10-row sample limit and a free FRED key enables the calendar. *Analyst consensus is deferred:* there is no free licensed source. Follow-ups: Bank of Korea meeting dates, macro-triggered reviews.
15. **Partial** — Self-improvement. Done: outcome ledger, lessons with a reviewed lifecycle, opt-in AI reflection, replay and forward lesson trials, and a **learning scoreboard**: broker Buy/Sell recommendations scored 1, 5 and 20 trading days later against KOSPI / S&P 500, completed trades against the benchmark over their holding period, per-lesson comparison of decisions made with and without each approved lesson, and keyword contradiction checks between approved lessons (also flagged to the AI). Remaining: significance testing, held-out validation and external trade import.
16. **Done** — AI console showing what the program and agent exchanged.

### Operations
17. **Partial** — Notifications: desktop and webhook, including guardrail alerts and the daily digest. No dedicated mobile app.
18. **Done** — Automated unit and Electron UI tests with fixtures; no real orders or paid calls in tests.
19. **Done (unsigned)** — Windows installer (NSIS, per-user, keeps data on uninstall) and in-app updates from GitHub Releases: automatic checks every 6 hours (optional), user-started download verified by SHA-512, and install only when no auto trading, open broker order or review is active. Remaining: a code-signing certificate (Windows SmartScreen warns until then) and macOS/Linux builds.
20. **Done, *new*** — **Token saving:** scheduled reviews are skipped when holdings, prices and cash (within half the price trigger), news, lessons and market sessions have not changed since the last review (a full review at least every 2 hours by default; never for emergencies, user requests, price or news triggers); optional routing sends routine reviews to a cheaper model and escalates emergencies, user requests and important disclosures, with any trade proposed by the cheaper model confirmed by the selected model; near 80% of the daily budget, routine reviews use the cheaper model at twice the interval instead of stopping; compact, stable-first context with a fixed prompt cache key. Measured with gpt-6-luna on a real review context: compaction −10% input tokens; research rounds that extend the previous prompt were 95% cached (2,674 of 2,820 tokens) and identical repeats 99.9%; prompts whose prices change mid-context were not cached. Engine settings shows skips, routing counts and per-review cost. Not done: batch-tier reflections and prefetching evidence.
21. **Done, *new*** — **Accurate fees and taxes:** executed orders use broker-reported figures when KIS provides them (Korea: the order inquiry's fee-and-tax total, live and mock; U.S.: settled trade history with fees, settlement amount and exchange rate, live accounts only), checked every 15 minutes, with estimates kept and labeled otherwise. Domestic ETFs/ETNs pay no sale tax. A KRW ledger computes Korean capital-gains tax on overseas shares (moving average as KIS uses, or FIFO; settlement-date rates from KIS or the Bank of Korea reference rate; realized by settlement date) and estimates the year's 22% tax above ₩2,500,000 together with gains entered for other brokers. Follow-ups: dividends and FX gains, corporate actions, U.S. exchange holidays in estimated settlement dates.
22. **Partial, *new*** — **Short selling and leverage:** leveraged and inverse ETFs in both markets (classified from the KIS symbol list, common U.S. tickers and user overrides), Korean margin buying (신용매수) and short selling (대주매도) through KIS credit orders, each off by default with its own caps, risk warnings (holding period, loan maturity, collateral, short stop level and repayment deadline) and approval or automatic submission. Closing positions is always allowed. Credit orders are live-only at KIS; the user's live account is cash-only today (KIS APBK1617), so margin and short orders are fixture-tested and still need a supervised live test after a KIS credit agreement. U.S. short selling is not offered by KIS to retail.

## Roadmap

Each step is planned, implemented, tested and committed on its own before the next starts.

| # | Feature | Why now |
| --- | --- | --- |
| 1 | ~~Autopilot guardrails (item 11)~~ Done | Unattended auto-trading is the main purpose; it needs a hard stop and a kill switch before the agent gets more reach. |
| 2 | ~~Market discovery (item 12)~~ Done | The agent can now screen and build a watchlist beyond holdings. |
| 3 | ~~Event-driven news and disclosures (item 13)~~ Done | Relevant disclosures now start a review within minutes. |
| 4 | ~~Performance and settled cash (items 4, 7)~~ Done | Returns are now measured against KOSPI / S&P 500 with deposits excluded. |
| 5 | ~~Learning scoreboard (item 15)~~ Done | Decisions and lessons are now scored against the benchmark. |
| 6 | ~~Charts: U.S. candles and pop-out window (item 6)~~ Done | U.S. candles in New York time and a pop-out chart window. |
| 7 | ~~Macro inputs (item 14)~~ Done | Official rates, inflation, FX and volatility now reach the AI. |
| 7b | ~~Accurate fees and taxes (item 21)~~ Done | Broker-reported order costs and a KRW tax ledger for overseas gains. |
| 8 | ~~Token saving (item 20)~~ Done | Skips unchanged reviews, routes routine ones to a cheaper model and uses the prompt cache. |
| 8b | ~~Short selling and leverage (item 22)~~ Done (credit orders await a live credit account) | Requested by the user; leveraged/inverse ETFs work on mock. |
| 9 | ~~Installer and auto-update (item 19)~~ Done, unsigned | NSIS installer and GitHub Releases updates; publishing needs a GitHub repository and token. |

## Testing with real credentials

Fixture tests stay the default. A run that imports the user's real KIS or OpenAI credentials through the app is done only with the user's go-ahead for that run, read-only on the account (no order submission), and with a small API budget.
