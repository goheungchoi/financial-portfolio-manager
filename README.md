# Financial Portfolio Manager

Electron + React desktop app for KIS Korean and U.S. cash stocks, portfolio analysis, optional AI management, paper trading, news and an interaction journal.

See the [requirements and missing-feature audit](docs/FEATURE-AUDIT.md), [automated testing guide](docs/TESTING.md), and [React/jQuery architecture comparison](docs/UI-ARCHITECTURE.md). The learning feature currently provides approved context memory; it is not a complete autonomous outcome-analysis or validated self-improvement system.

## Run

Open **Financial Portfolio Manager.exe** in the latest `release/Financial-Portfolio-Manager-*` folder. Keep its surrounding files together; `release/latest.json` identifies the current build. It is an unsigned portable Windows app with no installer or updater.

Development requires Node.js 22.13+:

```powershell
npm install
npm test
npm run test:desktop
npm run test:ui
npm run validate
npm start
npm run package
npm run test:package
```

## Connect

Keep credential JSON outside the repository. In **Connections**, import:

```json
{"environment":"mock","appKey":"YOUR_KIS_KEY","appSecret":"YOUR_KIS_SECRET","accountNumber":"12345678","accountProductCode":"01"}
```

Use `live` only for a live account. Import optional provider JSON in **Connections**:

```json
{"openaiApiKey":"YOUR_OPENAI_KEY"}
```

Optional fields are `dartApiKey` and `pushWebhookURL`. Omit unused fields. Importing an OpenAI key selects and saves OpenAI as provider; it does not enable trading or automatic submission. Startup reconnection preserves later manual provider choices.

Successful imports remember only the absolute file paths in the shared app-data database. Private utility processes reopen those files on subsequent launches/builds; keys and file contents stay in broker memory, never enter model context, and are not stored in SQLite. Keep files in a stable location. **Reconnect** retries; **Forget & disconnect** clears the saved reference without deleting the file. Imports from old builds that did not save paths must be repeated once.

## Agent management

Use **Engine settings → Agent guidelines** to describe profit protection, loss tolerance, concentration preferences and how to respond to changing conditions. Guidelines are saved and included in subsequent reviews, along with current portfolio data, observed daily equity peak, drawdown, configured news and approved journal lessons. They guide the decision provider; they are not translated into hidden investment-policy blocks. No profitability or recovery guarantee is made.

Daily turnover, per-order and company-allocation caps are **optional and off by default**. Blank means no app-imposed cap. A single company can represent 100% of invested positions, subject to cash, fees and share availability. If you explicitly configure an optional cap, execution enforces it. You can clear it later. Existing caps saved in earlier builds remain in their saved policies until replaced; a new blank-cap activation removes them.

**Engine settings → Autopilot guardrails** sets hard limits for unattended trading: what happens when a market's daily loss limit is reached (emergency reviews only, block new AI buys, or stop auto trading for the day), a daily cap on automatic orders, and a stop after consecutive failed reviews. Each trip is logged in AI console and sent through the alerts you enabled. An optional daily digest summarizes equity change, reviews, orders, AI cost and guardrail events once a day at a chosen KST hour. Guardrails do not block orders you approve manually and do not cancel accepted broker orders.

**Performance** records the account value once a day while the app runs (Korea, U.S. and all markets in KRW) and shows time-weighted returns, gain after deposits and withdrawals, and KOSPI / S&P 500 comparisons. Record transfers under **Deposits & withdrawals** so they are not counted as gains; KIS does not report them to the app. History starts when this version first runs. Korean cash is valued at settled (D+2) cash, matching the KIS total.

**Journal → Scoreboard** checks whether the agent's calls worked: each Buy or Sell recommendation is scored 1, 5 and 20 trading days later against KOSPI or the S&P 500, completed trades are compared with the benchmark, each approved lesson shows how decisions did with and without it, and approved lessons that contradict each other are flagged. Small samples are labeled as such.

**News** matches headlines and Open DART disclosures to your holdings, watchlist, allowlists and AI-watched symbols, and flags important filings (capital changes, earnings, large contracts, control changes, trading halts, delisting risk, legal events). With scheduled reviews enabled, **News-triggered reviews** starts a review for important disclosures about your symbols (default), for any matched news, or never; at most one news-triggered review runs every 10 minutes and later events are reviewed together. Budgets and guardrails still apply.

**Discover** (Research) searches a daily-downloaded symbol list of KOSPI, KOSDAQ, NASDAQ, NYSE and AMEX listings, screens KIS rankings (volume, gainers, losers, market value) and keeps a per-account watchlist. Watchlist symbols are quoted with holdings (up to 20 quotes per market) and included in AI reviews. During reviews the agent can use `screen_market`, `search_securities` and `update_watchlist` (up to 3 symbols per call, at most 10 AI entries, never removing your entries). Discovery never places orders; the KIS trading allowlist and caps still apply.

Providers:

- **OpenAI API:** GPT-6 Luna, bounded structured output, no file/shell/trading tools, `store:false`, maximum 600 output tokens. API billing is separate from ChatGPT Plus. Daily request and local budget caps reserve USD 0.01/request, including failed or uncertain requests; this estimate is not the provider invoice or billing cap.
- **Local rules:** deterministic demonstration, not AI. Ordinary reviews target a 10% per-company example allocation. Emergency reviews propose a bounded reduction of up to 25% of the largest eligible held position. Use OpenAI for interpreting natural-language guidelines; the local example does not interpret them.
- **External agent:** included MCP stdio bridge exposes paper snapshots, paper proposals and structured paper decisions. No KIS keys, filesystem, live-account data or live-order tools. Engine settings shows the command. External clients provide their own scheduling and subscription access; the app does not create a ChatGPT background Dot.

Scheduled reviews require the saved schedule to be enabled and resumed for this app session. Trading is approval-first unless automatic submission is explicitly enabled. Running the app unattended does not require daily manual reactivation: KIS session baselines roll on new Seoul calendar days while the app stays open. App restart/account changes still disable trading and pause scheduled execution until resumed. There is no remote/mobile control interface; management is desktop-only, and automation stops if the app closes or the PC sleeps.

## Emergency response

An optional daily loss threshold can be expressed in KRW or percent. It defaults to **Not set** and remains an advisory emergency trigger, not an order prohibition. Crossing it does not pause execution, cancel orders, force liquidation or reject new orders because of the loss.

For the selected portfolio, armed scheduling starts an immediate emergency review and follows up at most once per minute within API budgets. The provider receives loss/threshold/peak information and a downside-reduction objective. It may rebalance, preserve cash or Hold when trading lacks justification. Approval and optional caps still apply. Manual mode provides **Run emergency review now**. Console and Journal mark emergency activity; recovery below the threshold clears it.

Paper baselines roll at the next Seoul calendar day. KIS baselines use the first fresh broker equity of the session/day and roll automatically. Editing a threshold on the same day preserves its baseline. Deposits/withdrawals affect equity-based loss measurements; observed peaks are sampled values, not guaranteed full-market historical peaks.

## Trading

**Paper trading:** separate KRW 10 million account, synthetic quotes and simulated partial fills, fees/slippage, reservations and cost basis. Optional caps start off. Startup pauses execution and cancels unfinished paper orders. Simulation status remains visible.

**KIS trading:** connect first, optionally enter stock codes/watchlist and optional caps/emergency trigger. Check **Enable trading for this MOCK/LIVE account**, then activate. No phrase typing is required. With a blank stock list, the agent reviews up to 20 held stock codes and manual orders may target any supported Korean cash stock. A supplied list restricts that session to those codes. This is not an all-market screener.

Create a proposal and click **Approve MOCK/LIVE order** after reviewing symbol, side, quantity and price. Automatic execution has a separate checkbox/button and requires Engine settings automatic submission as well. Changing the day does not revoke an active running session.

Broker submissions still check valid/fresh prices and tick sizes, available non-credit cash or shares, market session, identity and unresolved orders. Orders are recorded durably before POST and never blindly retried. Accepted/uncertain orders require broker reconciliation before another order. Match a verified uncertain order using its broker number; no confirmation typing is required, but the backend verifies its contents.

**Stop new orders** prevents subsequent submissions. Accepted broker orders remain active and must be canceled through Korea Investment. No shorts or margin integration is provided. Technical request/quantity limits, the broker's supported markets and API availability still apply.

## After-hours reviews

Read-only KIS reviews can run while the market is closed, using closing data marked with market-session status. They do not imply that an order can execute immediately. Automatic submission is deferred when session status is closed or unverified; short-lived proposals must be refreshed before later execution. Real order preflight continues to verify regular market availability (currently 09:00–15:20 KST plus broker calendar check). Broker features unsupported in mock mode may remain unavailable even though portfolio review succeeds.

Known failures such as closed sessions, authentication, rate limits and broker rejection are distinguished in review status rather than collapsed into a generic failure. Loading a key is not proof of a successful AI request; completed reviews and token usage are recorded in the journal/console.

## Views and data

- Overview/Holdings: current equity, unrealized P&L, allocations, company returns, and signed changes between displayed equity updates. Tooltips explain calculation details. Small equity traces show samples observed during the open view, not historical investment returns.
- Charts: interactive candles/price line, volume, 20-bar average, visible ranges and inspection slider. KIS history is bounded to returned adjusted daily or intraday bars. Synthetic history is explicitly labeled.
- Activity/Performance: cumulative order executions and broker-reported realized results. Gross cash flow is not profit; missing fields remain unavailable. Realized-profit endpoint is unavailable for mock accounts.
- News: configured public HTTPS RSS/Atom feed and optional DART latest 100 disclosures for today, refreshed every 30 minutes. No licensed consensus dataset or complete real-time news coverage.
- Journal/console: supplied context, decisions, risk/tool results and approved lessons. Private model reasoning is not shown. Lessons do not retrain model weights or rewrite policy. Local JSON export is available.

KIS streaming supports up to 20 held symbols with reconnect/backoff and REST fallback every 30 seconds; broker balances refresh every two minutes. UI publication is 1 Hz. Quote age/source, simulation, errors and emergency/approval status remain visible. KIS sector classification is Unknown without a classification dataset.

Drafts survive tab navigation in memory. Save, activation and submission are explicit. Reload/exit discards unsaved drafts. KIS drafts are separated by connection session. Optional help keeps the normal interface compact.

Desktop alerts and HTTPS webhook delivery are opt-in; the webhook receives JSON `content` and `text`. A persisted outbox retries failures up to five times and pauses if no webhook is loaded. Actual delivery requires a compatible configured service.

## Storage and validation

SQLite uses the shared Electron user-data directory, normally `%APPDATA%/Financial Portfolio Manager`. It stores saved file paths, preferences/guidelines, optional policies, paper accounting, KIS intents, reviews, lessons and notifications. Latest 600 interaction events and 100 synthetic snapshots are retained. Explicitly shared KIS review context, order records, paths and journal exports are sensitive local data; keep them private. Back up the database while closed.

Renderer sandboxing, context isolation, sender-validated IPC, blocked navigation/new windows, and private credential workers are enabled. Automated tests use isolated fixture accounts and do not make real trades or paid AI calls. Real broker execution and external-service delivery still require validation with your configured services/KIS mock account. The unsigned portable build is not brokerage certification.

References: [KIS official examples](https://github.com/koreainvestment/open-trading-api), [OpenAI billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Open DART](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001).

## U.S. stocks and trading costs

**U.S. stocks** uses the same private KIS credential connection and separate USD balances for NASDAQ (`NASD:AAPL`), NYSE (`NYSE:IBM`) and AMEX (`AMEX:SPY`). Refresh the account, select a stock list or leave it blank for holdings, and activate the session with the checkbox. Whole-share, regular-session cash limit orders at USD 1 or above are supported. Overview and Holdings combine Korean and U.S. positions with All/Korea/U.S. filters. Charts and broker Activity/Performance remain domestic; U.S. app order results are in the U.S. workspace. No implicit USD/KRW summation or currency conversion occurs. Broker permissions and quote entitlements apply; snapshots may be delayed. U.S. balances attempt refresh about every 30 seconds while KIS is connected; explicit refresh retries immediately. No real-time U.S. stream or whole-market stock screener is claimed.

Choose **KIS · U.S. stocks (USD)** in Engine settings for AI reviews. Approval is the default; automated execution requires both U.S. session opt-in and automatic submission. The local domestic demonstration strategy holds U.S. assets rather than applying KRW sizing to them. Read-only reviews remain available after hours. A New York calendar handles DST, standard holidays and early closes with a ten-minute closing buffer; broker checks still determine order eligibility and unexpected closures. All app broker intents are journaled before POST; uncertain submissions require reconciliation rather than blind retries.

**Fees & taxes** stores editable commission/sale levy estimates and a South Korean resident individual tax profile. Initial U.S. assumptions are 0.25% commission and 0.00206% sale levy (USD 0.01 minimum). Korean assumptions are 0.015% commission and 0.20% sale tax; verify your actual account/product rates. These are estimates, not a claim about negotiated fees. Broker average acquisition prices are treated as excluding acquisition commissions, which are estimated separately. Filled app orders recalculate estimated net proceeds and gains from cumulative executed quantity and price; domestic Performance retains broker-reported actual fees/taxes where available. U.S. execution reports do not provide every settlement fee, so the app labels U.S. costs as estimates.

Foreign-company share capital-gains estimates use the marginal change in annual tax at 22% after the shared KRW 2,500,000 eligible-gain deduction. Enter current net realized gains across all brokers, a tax year, indicative sale-settlement USD/KRW rate, and historical KRW acquisition cost per share including acquisition expenses. Missing inputs leave tax unknown. Subsequent app sales with known tax inputs update that saved annual baseline automatically, including partial-fill changes; trades outside the app and unknown-basis sales require manual updates. Saving a new all-broker baseline anchors the app ledger to prevent double counting. Estimates can decrease after a loss but do not represent a guaranteed cash refund. Annual tax is payable separately from immediate sale proceeds; final settlement FX, tax lot accounting, residency duration, special-product rules and the broker tax report may change the filing amount. This profile excludes special accounts, major-shareholder domestic taxation and dividend tax.

AI context includes the same cost settings, one-share examples, current annual baseline, historical tax basis and explicit unknown-tax flags. Providers must evaluate full-quantity entry/exit costs and marginal annual tax; one-share tax estimates cannot simply be multiplied. The paper simulator retains its explicitly simulated 0.1% commission and 0.1% slippage, with no tax simulation.

Sources checked during implementation:
- [Official KIS overseas API examples](https://github.com/koreainvestment/open-trading-api/tree/main/examples_llm/overseas_stock)
- [KIS commission and market-fee schedule](https://securities.koreainvestment.com/main/bond/research/_static/TF03ca050000.jsp)
- [KIS overseas share tax guide](https://securities.koreainvestment.com/main/bond/research/_static/TF03ca030100.jsp)
- [NTS capital-gains calculation and shared deduction](https://i.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274)
- [NYSE holiday calendar](https://www.nyse.com/trade/hours-calendars)

Automated tests use fake broker transports and isolated user-data directories. No real overseas order or account permission has been verified by the build tests.

## Unified market management

Korean and U.S. trading sessions can both be active. Choose **KIS · Korea + U.S. together** in Engine settings to supply both portfolios in one review. Read-only reviews require the normal OpenAI data-sharing consent but do not require order-session activation. Creating or submitting a broker proposal requires activation for its target market. The agent receives native currencies, market-specific costs, hours and cash, and can propose one bounded order per review into either market. Automatic submission is routed to that market only and requires its market-specific automatic-execution opt-in. A closed Korean session does not stop a justified U.S. proposal, and vice versa. The local demonstration provider holds combined portfolios; use OpenAI for cross-market decisions.

Overview shows native KRW/USD totals and an indicative KRW combined valuation. Allocation supports company, sector, region, listing market and currency. Conversion uses the KIS first-published USD/KRW rate when available, otherwise the user-entered indicative rate in Fees & taxes. Missing rates or incomplete balances leave combined weights unknown, rather than adding USD directly to KRW. Quote failures retain balance visibility and show warnings. A retained balance can be stale after a failed refresh; review the displayed timestamps and status.

Use **Edit classification** on a holding to persist a sector and region/exposure label. Unknown sectors remain unclassified. Default region describes listing location, not revenue exposure or a fund's underlying constituents; fund look-through is not implemented. These labels are included in combined AI reviews. Coverage currently includes supported Korean and U.S. cash equities, not every foreign exchange.

U.S. response normalization handles empty/single-object/list records documented in KIS examples and missing sellable quantity without assuming share availability. Authentication, rate limiting, broker rejection, incomplete data and request failures are retained as specific, stage-labelled errors. Only a validated broker message code is exposed for diagnostics; raw broker messages and credentials are excluded. Live-account refresh success cannot be established by fixture tests. If a query still fails, the displayed stage/code and broker reference identify the next diagnostic step.

### Intermittent USD cash refresh errors

All broker HTTP requests share a client queue, with at least 1.1 seconds between mock request starts. Scheduled polling skips a busy broker and overlapping U.S. refreshes share one request. HTTP failures preserve only a numeric status and validated broker message code. KIS rate-limit code EGW00201 is recognized even on HTTP 500, with a one-minute client cooldown. Transient GET network/timeout/server failures retry at most once; POST/token/order requests are never automatically retried. Failed U.S. refreshes label retained combined/U.S. valuations as last known. Fixture tests do not prove a user's current server connectivity or account access.

## Read-only reviews and execution status

KIS reviews can run with trading sessions off. Disabled markets use a read-only context and no execution policy is implicitly activated. Recommendations for a disabled market are recorded in Journal/AI console without creating an order. Automatic submission requested in Engine settings is distinguished from actual per-market execution permission: Korea and U.S. session/automatic states are shown separately. If the market session is enabled but its automatic execution is off, a checked proposal awaits manual approval instead of failing the whole review. Restart continues to disable broker execution and pause scheduled reviews. No session is enabled by running a review.

