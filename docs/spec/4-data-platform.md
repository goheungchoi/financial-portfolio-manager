# Part 4. Accounts, portfolio data, reporting, storage and the platform

Read from the code on 2026-11-19 (package.json version 1.5.68; the working tree had uncommitted changes in
`electron/live-engine.cjs` and `tests/shared-funding.test.cjs`). Line numbers are those of that day: where a line may
move, a searchable identifier is given as well. Statements marked "(inferred)" are read from names or comments, not
from the code path itself. The UI is in part 1 (`parts/1-ui.md`), orders and risk in part 2
(`parts/2-orders-risk.md`), the AI in part 3 (`parts/3-ai.md`); this part refers to them and does not repeat them.

## 1. Architecture

### 1.1 The processes

In plain words: one window program (the renderer) that can do nothing by itself, one main program that owns the
database and every decision, and three small private helper programs that are the only ones to hold keys and talk to
the outside.

```
 +--------------------------- Renderer (React, dist/index.html) -----------------------------+
 |  sandboxed, contextIsolation on, nodeIntegration off; CSP connect-src 'none' (index.html:2) |
 |  sees only window.portfolio.* (electron/preload.cjs:2)                                      |
 +-----------^-----------------------------------------------------+-------------------------+
             | webContents.send: market:changed, events:changed,   | ipcRenderer.invoke (124 channels,
             | theme:changed, update:changed, chart:tick           | each begins with authorize(event))
 +-----------+-----------------------------------------------------v-------------------------+
 |  Main process (electron/main.cjs)                                                          |
 |  PortfolioStore -> portfolio.sqlite (node:sqlite, WAL)   timers (1 s, 30 s, 60 s, ...)      |
 |  PaperEngine, Automation, LiveEngine (KR), LiveEngine (US), TradingCosts, Exposure,         |
 |  FundingLedger, PerformanceHistory, FlowDetector, InFlight, ResearchService, SecurityMaster,|
 |  Watchlist/Screener, UsCalendar, MacroStore, Notifications, AppUpdates, ExitRecord,         |
 |  RememberedFiles, agent bridge (named pipe)                                                 |
 +------+------------------------------+-------------------------------+---------------------+
        | KisService()                 | KisService('provider-worker') | KisService('calendar-worker')
        | utilityProcess.fork          | utilityProcess.fork           | utilityProcess.fork
 +------v---------------+   +----------v--------------------+   +------v--------------------+
 | kis-worker.cjs       |   | provider-worker.cjs           |   | calendar-worker.cjs       |
 | "KIS broker"         |   | "Private provider broker"     |   | "KIS market calendar"     |
 | holds the KIS key;   |   | holds OpenAI/Anthropic, DART, |   | holds a live KIS key for  |
 | balance, quotes,     |   | ECOS, FRED keys, SEC contact, |   | one request: the KRX      |
 | orders, history,     |   | phone webhook URL; AI calls,  |   | holiday list (CTCA0903R)  |
 | rankings, WebSocket  |   | macro, FX, SEC, DART, push    |   |                           |
 +------+---------------+   +----------+--------------------+   +------+--------------------+
        v KIS REST + stream            v api providers, sec.gov,        v KIS REST
                                         opendart.fss.or.kr, webhook
 Also in the main process: fetch of KIS public master files (security-master.cjs), Nasdaq calendar
 (us-calendar.cjs), RSS feeds (news.cjs), GitHub Releases (electron-updater).
```

| Process | Started by | What it holds and does | Cite |
|---|---|---|---|
| Main | Electron (`"main": "electron/main.cjs"`, package.json:6) | Database, all engines, timers, IPC handlers, windows | main.cjs:222 `app.whenReady` |
| Renderer (main window, plus one chart window per symbol) | `createWindow` main.cjs:187, `openChartWindow` main.cjs:215 | Screens only. Both load the same `dist/index.html` (hash `overview` or `chart:<symbol>`) so the IPC check is the same | main.cjs:209, 220 |
| KIS worker | `new KisService()` main.cjs:20; forked lazily at the first request (`ensureWorker` kis-service.cjs:5-7) | Opens the credential file itself (`operation==='import'`, kis-worker.cjs:12-24: a regular file of at most 65,536 bytes), keeps the client in memory, runs one request at a time (`busy`, kis-worker.cjs:9). Operations: import/refresh (balance), quotes, history, chart-bars, company-chart, market-evidence, live-context, prepare-order/place-order/revise-order (15-second ticket, kis-worker.cjs:57), charges, orders/profit, index-history, news, research-section, screen, chart-stream, and the `us-*` set | kis-worker.cjs:26-109 |
| Provider worker | `new KisService('provider-worker.cjs')` main.cjs:17 | Reads the providers JSON itself (`ai-router.cjs parseProviderFile`, provider-worker.cjs:7-14; at most 65,536 bytes) and keeps the keys in memory. Operations: test-key, decision, reflection, scout, narrative, compact, push, macro, fx-rates, sec-company/-filings/-earnings/-about, dart-company/-about, disclosures | provider-worker.cjs:15-45 |
| Calendar worker | `new KisService('calendar-worker.cjs')` main.cjs:17 | A second, live KIS key used only for the official Korean holiday list; a mock key is refused (`CALENDAR_NEEDS_LIVE_KEY`). Operations: import, kr-calendar, disconnect | calendar-worker.cjs:1-3, 16, 18-24 |

**One class runs all three workers.** `KisService` (electron/kis-service.cjs:3) takes the worker script name; it forks
it with `utilityProcess.fork(..., {stdio:'pipe'})` and discards the worker's stdout and stderr ("raw broker
data/errors never enter console logs", kis-service.cjs:9-10). Mechanics:

- Request and reply: `{id, operation, ...payload}` out, `{id, ok, snapshot}` or `{id, ok:false, code, ...}` back
  (kis-service.cjs:74, 15-19). A string payload is sent as `{path}` (the file to import).
- One queue per service: requests run in turn (`this.queue`, kis-service.cjs:47). An order can `hold` the queue from
  its broker check to its placement, released after 30 s at most (kis-service.cjs:59-67; see part 2).
- Time limit: 90 s for KIS and calendar requests; for the provider worker the limit comes from
  `ai-router.cjs workerCapMs` (kis-service.cjs:72). On a time-out the worker is killed (`disconnect`).
- `generation` rises at each disconnect; a queued request of an older generation fails `BROKER_UNAVAILABLE`
  (kis-service.cjs:43, 77). A rate-limit reply sets `cooldownUntil`; requests before that time are refused unsent.
- Only the KIS worker's failures are recorded (`noteFailure`, kis-service.cjs:28-32; stored in `kis_failures`,
  main.cjs:261-262), and the worker also pushes unrequested messages: `{type:'quote'}` and `{type:'stream'}`
  (kis-service.cjs:13-14).
- Error codes that leave a worker are fixed lists (`worker-codes.cjs relayCode`, kis-worker.cjs:112;
  `provider-error-reply.cjs errorReply` with `router.redact`, provider-worker.cjs:47).

### 1.2 Start-up sequence (electron/main.cjs)

| # | Step | Cite |
|---|---|---|
| 1 | Single instance: unless `PORTFOLIO_SMOKE_DATA` is set, a second copy quits at once; the first one's window is restored and focused | main.cjs:2, 8 `second-instance` |
| 2 | The three `KisService` objects are created (no worker runs yet) | main.cjs:17, 20 |
| 3 | `--verify-build` with `PORTFOLIO_VERIFY_DIR` moves `userData` to that directory (package check) | main.cjs:172-173 |
| 4 | `app.whenReady`: load `src/domain.mjs`; open `<userData>/portfolio.sqlite` with `PortfolioStore` | main.cjs:223-224 |
| 5 | Exit record: read how the previous run ended, write this run's row, start a 60 s heartbeat | main.cjs:226 |
| 6 | `RememberedFiles`; load the console events; seed the first made-up snapshot; start the synthetic market feed (used only until KIS is connected) | main.cjs:227-233, 246 |
| 7 | `PaperEngine` -> `Automation(db, paper, providerService, interaction)` -> `LiveEngine` (Korea) -> `BalanceHold`/`UsBalanceHold` -> `TradingCosts` -> `Exposure` -> `kis_failures` recorder -> `FundingTracker` -> `LiveEngine` (U.S., through a `us-` prefixed broker facade) -> `FundingLedger` (shared by both engines) | main.cjs:247-291 |
| 8 | `PortfolioView`; IPC for charts, company, portfolio, exposure, costs, `us:*` | main.cjs:299-336 |
| 9 | `Notifications`; the start notice is computed and, if any, sent 3 s later | main.cjs:338-343 |
| 10 | Agent bridge (named pipe for an external agent, part 3) | main.cjs:344 |
| 11 | Market evidence, `SecurityMaster`, `Watchlist`, `Screener`, `StarterCandidates`, `ResearchService`; `UsCalendar` (first refresh after 45 s, then hourly check); SEC warm-up (after 2 min, hourly check, once a day); 6-hour research warm-up | main.cjs:345-454 |
| 12 | `PerformanceHistory`, `ValuationCorrections`, `FlowDetector`, `BrokerBalances`, `BrokerCapacity`, `InFlight`, `FundingTransfers`, `SettlementBaseline`, performance corrections; `detectFlows` is defined; the 60 s `recordValue` timer | main.cjs:456-534 |
| 13 | Korean calendar refresh timer; intraday value sampler (60 s); phone snapshot wiring; benchmarks timer | main.cjs:535-559 |
| 14 | `MacroStore` (first refresh after 30 s, then every 6 h) | main.cjs:597-599 |
| 15 | Attention list, login item, `AppUpdates` (first tick after 30 s, then every 10 min) | main.cjs:602-648 |
| 16 | Charges and tax-history timer (first after 2 min, then every 15 min); scoreboard closes timer | main.cjs:650-677 |
| 17 | Remaining IPC (discovery, runtime, connections, live, paper, market, activity, events) | main.cjs:682-857 |
| 18 | Main timers: `publishMarket` every 1 s, `pollKisQuotes` every 30 s, `refreshKisBalance` every 120 s, synthetic snapshot save every 30 s | main.cjs:754-759 |
| 19 | Application menu, `createWindow()`, then `remembered.restore(...)` reconnects the remembered KIS, providers and calendar files (not in a package check) | main.cjs:858-860 |
| 20 | Any failure in 4-19: an error box ("The local portfolio database could not be opened. The app will close without submitting any orders.") and exit code 1 | main.cjs:862 |

Things connected by assignment after construction (so the order above matters): `automation.live`, `automation.usLive`,
`automation.costs`, `live.costs`, `live.exposure`, `live.funding = usLive.funding = fundingLedger`,
`live.balanceHold`, `automation.notify`, `automation.discovery`, `automation.evidence`, `automation.usCalendar`,
`automation.macro`, `performance.adjustments / corrections / settlement / held`, `notifier.onFill`, `notifier.render`
(main.cjs:249-291, 339, 345, 362, 412, 462-497, 545-553, 597).

The once-a-second tick `publishMarket` (main.cjs:234-245) is the app's clock: it calls `paper.tick()`,
`automation.tick()`, `notifier.observe(...)` and `notifier.tick()`, starts an order reconcile every 30 s, a U.S.
refresh every 60 s, a news refresh every 5 min (auto trading on with a news trigger) or 30 min, polls open charts
every 10 s, and sends `market:changed` to every window.

### 1.3 The renderer boundary (security model)

| Rule | Mechanics | Cite |
|---|---|---|
| The page has no Node and no network | `contextIsolation:true, sandbox:true, nodeIntegration:false`; CSP `default-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'` | main.cjs:188, 217; index.html:2 |
| Only the app's own page may call | `authorize(event)`: the sender must be the main frame, its URL (without the hash) must equal the file URL of `dist/index.html`, and it must belong to a `BrowserWindow`; otherwise `Unauthorized IPC sender`. Every one of the 124 `ipcMain.handle` handlers calls it (some through wrappers such as `liveAction`, `performanceAction`, `updateAction`, `discoveryAction`, `exposureAction`, `deskAction`, `paperAction`, `scoreboardAction`) | main.cjs:182-186 |
| No navigation, no new windows | `setWindowOpenHandler(()=>({action:'deny'}))`, `will-navigate` prevented | main.cjs:189, 199, 218 |
| Outside links are checked in main | Filings: only `dart.fss.or.kr/dsaf001/main.do?rcpNo=<14 digits>` or `www.sec.gov/Archives/edgar/data/...`; news: only a URL the app itself holds in its news lists | main.cjs:445, 743 |
| The page never sees a key or a file's content | Files are chosen with a main-process dialog and opened inside a worker; the page gets flags (`aiConnected`, `dartConnected`, ...) and the file's base name | main.cjs:696, 732, 829; remembered-files.cjs:10; provider-worker.cjs:14 |
| Error texts are fixed codes | Each wrapper passes only a listed code or a pattern `^[A-Z_]{3,40}$`, else a generic one | e.g. main.cjs:69-70 `kisErrorCode`, 707 |
| The page cannot write the console log | "No renderer write API" for `events` | storage.cjs:21 |
| Permission handlers (camera, etc.) | not determined (no `setPermissionRequestHandler` found in electron/) | |

What the page may call (`window.portfolio`, electron/preload.cjs:2-110), by group:

| Group | Methods |
|---|---|
| Connections | `getKis, importKis, refreshKis, disconnectKis, importProviders, importCalendarKey, forgetConnection, reconnectConnection, testProviderKey, getSecContact, setSecContact, testSec` |
| Portfolio | `getPortfolio, refreshPortfolio, setInstrumentMetadata, getSnapshot, getMarket, pauseFeed, getHistory, onMarket, getMarketStatus` |
| Performance | `getPerformance, addCashFlow, removeCashFlow, confirmCashFlow, flowIsIncome, refreshBenchmarks, getMovementRecords, getMovementCloses, getScoreboard, refreshScoreboard` |
| Activity | `getActivity, getActivityCached, getActivityToday` |
| Costs and tax | `getCosts, saveCosts, getTaxProfile, saveTaxProfile, getTaxSummary, refreshCharges, addOpeningLot, removeOpeningLot, addIncome, removeIncome, declareIncome, setFundClass` |
| Exposure | `getExposure, saveExposurePolicy, setProductOverride` |
| Trading (part 2) | `liveAction(name)`, `usAction(name)` with fixed name lists (preload.cjs:10-11), `getPaper, configurePaperLoss, configurePaperCaps, proposePaper, submitPaper, pausePaper, cancelPaper` |
| Engine (part 3) | `getRuntime, getRuntimeHistory, configureRuntime, startAutoTrading, stopAutoTrading, reviewRuntime, setBackgroundAi, dryRun, dryRunEstimate, runScout, resetReviewWatches, previewDigest, listReplays, runReplay, estimateReplay, approveLesson, reviewLesson, lessonTrial, getOutcomeHistory, cancelTrigger, deleteNote, cancelConditionalOrder, dismissUnprotected` |
| Research and charts | `getCompany, getResearch, openFiling, getMarketOverview, getUSMarketOverview, getMacro, refreshMacro, openChartWindow, getChartBars, watchChart, onChartTick` |
| News and discovery | `refreshNews, openNews, getSuggestedFeeds, refreshNarrative, hideNarrativeDriver, getDiscovery, getWatchQuotes, searchSecurities, screenMarket, updateWatchlist, refreshSecurityMaster` |
| Workspace | `getAttention, dismissAttention, getLoginItem, setLoginItem, getTheme, setTheme, onTheme, getEvents, onEvents, exportJournal, testPhoneSnapshot` |
| Updates | `getUpdates, checkForUpdates, downloadUpdate, installUpdate, saveUpdateSettings, onUpdates` |
| Test only | `runDemo` (the handler throws `TEST_ONLY` unless `PORTFOLIO_SMOKE_DATA` is set, main.cjs:842-843) |

### 1.4 How state reaches the screens

| Channel (main -> page) | Sent when | Content | Cite |
|---|---|---|---|
| `market:changed` | every second (`publishMarket`) and on connection, quote and balance changes (`broadcastMarket`) | `marketState()`: KIS snapshot and quotes (`buildKisMarket`), `connectionId`, `stream`, `marketsOpen`, a rising `revision`; without KIS, the made-up synthetic state | main.cjs:141-142, 243-244 |
| `events:changed` | each new AI console entry (`interaction`) | the whole `events` list (at most 600 rows) | main.cjs:101-108 |
| `theme:changed` | theme saved | 'dark' or 'light' | main.cjs:784-788 |
| `update:changed` | updater state change | `AppUpdates.view()` | main.cjs:641 |
| `chart:tick` | a trade or polled quote for a charted symbol | only to the windows showing that symbol | main.cjs:28 `sendChartTick` |

Everything else is pulled: the page asks (`runtime:get`, `portfolio:get`, `performance:get`, ...). The runtime state
the window polls every two seconds is a light copy (`lightState`, runtime-state.cjs:13-18): the latest three decisions
in brief; the full review lists, outcomes and news events come from `runtime:history` only when `historyVersion`
changes (runtime-state.cjs:1-5, main.cjs:692, 721). The page-side hooks are described in part 1.

### 1.5 App lifecycle

| Topic | Behaviour | Cite |
|---|---|---|
| Closing the window | `window-all-closed` quits the app (except on macOS). There is no tray: with the window closed nothing runs, including stops | main.cjs:873 |
| Quit | `will-quit`: exit record `stop('clean')`; `closing=true`; automation and notifier marked disposed; Korean `live.stop()`; bridge closed; provider and KIS workers killed; timers cleared; a last synthetic snapshot saved; database closed | main.cjs:863-872 |
| Exit record | One row (`app_exit`): `startedAt`, `heartbeatAt` (every 60 s, with the watched account scope), `stop:{kind, at, reasons, tentative, phoneSent}`. Kinds: `clean`, `windows-shutdown`; a run with no stop reads as `unexpected` at its last heartbeat. Nothing in it throws | exit-record.cjs:1-6, 17-34, 43-49 |
| Windows restart or shutdown | `query-session-end` writes a tentative stop (the shutdown may be cancelled; a later heartbeat clears it); `session-end` confirms it and, best effort, sends one phone message straight to the webhook (not the outbox). Nothing holds Windows back | main.cjs:190-198; exit-record.cjs:22-32; start-notice.cjs:43-47 |
| After any restart | Auto trading is not armed again by itself: the session starts paused (the package check asserts `sessionArmed===false`, scheduler label `Paused after restart`, main.cjs:204; `auto-launch.cjs`, part 3). The last review time is kept (`auto-launch.cjs:30-31`) | |
| Start notice | Only when a previous run is on record and (stop orders are armed, or trailing stops are armed and allowed, or auto trading was running): desktop and phone alert 3 s after start (id `restart-notice:<startedAt>`), and a dismissible Home item until Start or Dismiss. Text: how it stopped, "auto trading is paused", how many stop orders are not being watched, what trailing stops will do on Start | start-notice.cjs:33-40; main.cjs:342-343, 624, 633 |
| Start with Windows | Read from Windows every time (`getLoginItemSettings` with the exe path quoted), never from a saved copy. Only the installed app may set it; a source run answers "Available in the installed app."; test runs use an in-memory fake. Turning on first removes every Run value for this exe in the user's key, then adds one. No hidden or minimised start argument is passed (none found in `login-item.cjs`) | login-item.cjs:2-12, 27-51; main.cjs:632-634 |
| Environment switches | `PORTFOLIO_SMOKE_DATA` (test profile: no single-instance lock, no downloads, fake login item, updates off, `demo:run` allowed), `PORTFOLIO_MASTER_DIR`, `PORTFOLIO_PERFORMANCE_SEED`, `PORTFOLIO_MACRO_SEED`, `PORTFOLIO_UPDATE_TEST`, `PORTFOLIO_VERIFY_DIR` with `--verify-build` / `--verify-profile` | main.cjs:2, 113, 172-178, 355-356, 464, 597, 630, 636 |
| Where the data lives | `app.getPath('userData')/portfolio.sqlite`; app name set to "Financial Portfolio Manager" before the path is used | main.cjs:171, 224 |

## 2. Storage

### 2.1 The file

One SQLite file, `portfolio.sqlite`, opened with Node's built-in `node:sqlite` (`DatabaseSync`), `journal_mode=WAL`,
`busy_timeout=3000`, `user_version=1` (storage.cjs:1-9). The one connection (`store.db`) is passed to every module;
each module creates its own tables with `CREATE TABLE IF NOT EXISTS` in its constructor.

- **Migrations**: there is no migration runner. `user_version` is set to 1 and not read anywhere found. New columns
  are added in place: `notification_outbox.payload, createdAt` by `ALTER TABLE` in try/catch (notifications.cjs:6);
  `funding_releases.citationId` after a `PRAGMA table_info` check (funding-ledger.cjs:37); `securities.sector,
  marketCap` after a `PRAGMA table_info` check, which also clears `security_master_meta` so the master downloads again
  (security-master.cjs:48). Most tables hold one JSON `payload` column, so new fields need no schema change.
- **Backups**: none found in electron/ (no backup, copy or VACUUM call). The release check works on a manual copy of
  the profile (section 6).
- **Most rows are JSON**: the pattern is `id/scope/account + payload TEXT`. A damaged row is skipped and named in the
  System log for `nav_history` and `cash_flows` (`performance.onSkipped`, main.cjs:457-459).

### 2.2 Settings

| What | Where | Shape | Written by / read by | Cite |
|---|---|---|---|---|
| App settings (plain, not secrets) | `settings(key,value)` | keys found: `theme` ('dark' default / 'light'); `sec-contact-email`; `connection-file:kis`, `connection-file:providers`, `connection-file:calendar` (absolute paths) | `PortfolioStore.setTheme/setSetting`, `RememberedFiles` | storage.cjs:11-19; main.cjs:376, 699; remembered-files.cjs:6-9 |
| Engine settings | `automation_settings` (one row, id=1, JSON) | the `automation.config` object (scope, enabled, autoSubmit, alerts, news feeds, model choices, ...; fields in part 3) | `Automation.configure` (IPC `runtime:configure`) | automation.cjs:110; main.cjs:724 |
| Korean and U.S. trading policy | `live_policy(accountKey, payload)`: one row per account key; the U.S. engine uses `<account>:US` | limits, allowlist, loss baseline (part 2) | `LiveEngine.configure` | live-engine.cjs:20; main.cjs:266, 709 |
| Leverage, margin, short policy | `exposure_policy(account, payload)`; `product_overrides(symbol, factor)` | per account | `Exposure.savePolicy / setOverride` | exposure.cjs:34, 49; main.cjs:324-325 |
| Update settings | `app_update_settings` (one row) | `{checkAutomatically}` only; default true; any other key is refused | `AppUpdates.saveSettings` | app-updates.cjs:20-21 |
| Fees and tax inputs | `trading_cost_settings` (one row), `tax_profile` (one row), `fund_tax_class(symbol)` | section 3.6 | `TradingCosts.save`, `profile.save`, `setFundClass` | trading-costs.cjs:89; tax-profile.cjs:45 |
| Paper settings | `paper_account`, `paper_loss_policy`, `paper_caps` (one row each) | part 2 | `PaperEngine` | paper-engine.cjs:10-12 |

### 2.3 Remembered files (credentials)

In plain words: the app never copies a key. It remembers where the file is, and at each start asks the worker to open
it again.

1. **Import**: the user picks a JSON file in a main-process dialog (`kis:import` main.cjs:826-837, `runtime:providers`
   main.cjs:732-738, `calendar:import` main.cjs:695-697). The earlier path is forgotten first.
2. The path (a string) goes to the worker (`request('import', file)`), which opens and parses the file and keeps the
   keys in its own memory (kis-worker.cjs:12-24; provider-worker.cjs:7-14; calendar-worker.cjs:12-17).
3. **Remember**: on success the absolute path is saved in `settings` under `connection-file:<kind>`
   (`RememberedFiles.remember`, remembered-files.cjs:8; main.cjs:80, 92, 97). Only the path: no file content, no
   encryption (no `safeStorage` use found).
4. **Restore**: after the window is created, `remembered.restore` reconnects all three in parallel (main.cjs:860).
   A provider file restored this way does not switch the AI provider (`selectProvider=false`, main.cjs:78-80, 858).
   On failure the path stays remembered, the status is `error` with a fixed sentence, and the user can press
   Reconnect (`connections:reconnect`, main.cjs:694).
5. **Forget**: `connections:forget` deletes the row and disconnects that worker; for KIS it also stops both engines
   and clears the snapshot and quotes (main.cjs:693). `kis:disconnect` disconnects without forgetting (main.cjs:839).
6. The page sees `{remembered, name (base name only), status, error}` per kind (remembered-files.cjs:10).

The provider file's fields, as the worker reads them: `openaiApiKey, anthropicApiKey, dartApiKey, pushURL, ecosApiKey,
fredApiKey, secContactEmail` (provider-worker.cjs:12-13). The KIS file's fields: not determined here (parsed by
`kis-client.cjs parseCredentials`; see part 2).

### 2.4 Every table

Columns are complete as created. "JSON" means a `payload TEXT` column holding one JSON object. Owner = the module
whose constructor creates the table and which holds its reads and writes unless noted. Retention "kept" = no pruning
statement found for the table (`DELETE FROM` search over electron/). Row meanings for trading and AI tables are short
here; parts 2 and 3 describe them.

**Platform and app state**

| Table | Created | Columns | A row is | Owner; other users | Retention |
|---|---|---|---|---|---|
| `settings` | storage.cjs:6 | key PK, value | one plain setting (2.2) | PortfolioStore, RememberedFiles | kept; deleted on forget / null |
| `events` | storage.cjs:7 | seq PK auto, id unique, payload JSON | one AI console / System log entry (`id, runId, timestamp, kind, title, body`, optional `account, accountLabel`; each at most 32,000 characters) | `appendEvent` via `interaction` (main.cjs:101); read `getEvents` | newest 600 (storage.cjs:32) |
| `snapshots` | storage.cjs:8 | id PK auto, timestamp, payload JSON | the made-up (synthetic) portfolio, `environment:'synthetic'`; not the real account | `saveSnapshot` every 30 s and at quit (main.cjs:757-759, 868) | newest 100 (storage.cjs:53) |
| `app_exit` | exit-record.cjs:8 | id=1, payload JSON | how this run started and stopped (1.5) | ExitRecord | one row |
| `app_update_settings` | app-updates.cjs:8 | id=1, payload JSON | update settings | AppUpdates | one row |
| `notification_outbox` | notifications.cjs:5-6 | id PK, message, attempts, nextAt, delivered, payload (added), createdAt (added) | one phone message waiting or sent | Notifications | kept (rows expire unsent after 12 h by `attempts=99`, never deleted) |
| `kis_failures` | main.cjs:261 | id PK auto, at, payload JSON | one failed KIS request (operation, codes, wait and run time; no payload, no account data) | `kisService.onFailure` | newest 200 (main.cjs:262) |
| `kr_calendar` | main.cjs:85 | day PK, open, fetchedAt | one Korean day, open or closed, from KIS | `refreshKrCalendar`; read `officialKrCalendar` | kept |
| `daily_digests` | daily-digest.cjs:45 | day PK, payload JSON | the day's digest as sent | daily-digest.cjs | kept |
| `activity_last` | activity-cache.cjs:9 | kind PK, payload JSON | the last KIS report per kind (`orders`, `profit`) with its account | ActivityCache | one row per kind |

**Account values, performance, cash and settlement**

| Table | Created | Columns | A row is | Owner; other users | Retention |
|---|---|---|---|---|---|
| `nav_history` | performance.cjs:28 | account, day, payload JSON; PK(account, day) | one Seoul day's recorded account value and positions | `PerformanceHistory.record` (main.cjs:533); read by `series/summary/history`, `movement:records` (main.cjs:580) | kept |
| `cash_flows` | performance.cjs:28 | id PK, account, payload JSON | one deposit, withdrawal or transfer (recorded by the user or detected) | PerformanceHistory, FlowDetector, FundingTransfers | kept; user removal (performance.cjs:94) |
| `benchmark_closes` | performance.cjs:28 | idx, day, close; PK(idx, day) | one index daily close | `saveCloses` from `refreshBenchmarks` (main.cjs:555-557) | kept |
| `intraday_values` | phone-snapshot.cjs:7 | account, at, equity; PK(account, at) | one equity sample of today | `IntradayValues.record` (main.cjs:544) | pruned by time (phone-snapshot.cjs:11; window in 3.1) |
| `valuation_adjustments` | valuation-corrections.cjs:42 | id PK, account, payload JSON | one versioned correction to a recorded value | ValuationCorrections | kept |
| `flow_watch` | flow-detector.cjs:120 | account PK, payload JSON | the flow detector's last observation and held changes | FlowDetector | one row per account |
| `inflight_settlement` | valuation.cjs:238 | account PK, payload JSON | U.S. fills KIS does not reflect yet | InFlight | one row per account |
| `settlement_funding` | integrated-settlement.cjs:33 | account PK, payload JSON | which part of unsettled U.S. buys is KRW-funded | FundingTracker | one row per account |
| `settlement_baselines` | settlement-baseline.cjs:28 | account, day, at, payload JSON; PK(account, day) | the tracker's pieces at the day's loss baseline | SettlementBaseline | kept |
| `settlement_events` | settlement-evidence.cjs:34 | id PK auto, account, at, kind, payload JSON | append-only log of settlement changes (triggers refuse updates and deletes, settlement-evidence.cjs:3) | settlement-evidence.cjs | kept |
| `settlement_evidence` | settlement-evidence.cjs:37 | id PK, evidenceId, version, account, source, amountCents, currency, payload | one piece of evidence, versioned | same | kept |
| `settlement_allocations` | settlement-evidence.cjs:38 | id PK, account, evidenceId, version, pieceId, orderId, cents, rule, at, reversedBy | evidence used for one order piece | same | kept |
| `settlement_k_groups` | settlement-evidence.cjs:39 | id PK, account, payload JSON | a group of KRW-route pieces (inferred) | same | kept |
| `funding_commitments` | funding-ledger.cjs:30 | orderId PK, account, market, payload JSON | the money one buy has committed | FundingLedger (part 2) | kept |
| `funding_events` | funding-ledger.cjs:30 | id PK, at, orderId, payload JSON | ledger event log | FundingLedger | kept |
| `funding_meta` | funding-ledger.cjs:30 | key PK, value | ledger bookkeeping | FundingLedger | kept |
| `funding_releases` | funding-ledger.cjs:34, 37 | id PK, orderId, account, cents, route, reconciliationId, at, reason, citationId (added) | one release of committed funding | FundingLedger | kept |
| `funding_transfers` | funding-transfers.cjs:79 | account, key, payload JSON; PK(account, key) | the KRW part of U.S. buys booked as a transfer; state per key | FundingTransfers | per key; deleted by key (funding-transfers.cjs:92, 280) |
| `broker_balances` | broker-raw.cjs:19 | id PK auto, account, market, at, payload JSON | KIS's own balance figures at a reading, kept when they change | BrokerBalances (`detectFlows`, main.cjs:500) | by age and row cap (broker-raw.cjs:30-31) |
| `broker_capacity` | broker-raw.cjs:42 | same columns | KIS's orderable answers at an order preparation | BrokerCapacity (main.cjs:470) | by age and row cap (broker-raw.cjs:51-52) |

**Costs, tax, income, FX**

| Table | Created | Columns | A row is | Owner | Retention |
|---|---|---|---|---|---|
| `trading_cost_settings` | trading-costs.cjs:89 | id=1, payload JSON | commission plan and the user's tax inputs | TradingCosts | one row |
| `fx_rates` | trading-costs.cjs:89 | day PK, rate, source | the USD/KRW reference rate of a day | `saveRates` (main.cjs:598, 660) | kept |
| `tax_events` | trading-costs.cjs:89 | id PK, account, payload JSON | one taxable trade (buy or sale) in the tax record | TradingCosts (`syncHistory`, engines) | kept; replaced on import (trading-costs.cjs:91, 177) |
| `tax_opening_lots` | trading-costs.cjs:89 | id PK, account, payload JSON | a holding's cost entered by the user for shares bought before the record | TradingCosts | user removal |
| `fund_tax_class` | trading-costs.cjs:89 | symbol PK, payload JSON | the user's tax class of a Korean ETF | TradingCosts | user removal |
| `trade_history_reads` | trading-costs.cjs:222-223 | account PK, day | the day of the last full U.S. history read (`fullReadDay`) | TradingCosts | one row per account |
| `trade_history_gaps` | trade-history.cjs:48 | account PK, payload JSON | date ranges of the U.S. history not read whole | trade-history.cjs | one row per account |
| `trade_history_jobs` | trade-history.cjs:66 | account PK, payload JSON | an unfinished history import job | trade-history.cjs | one row per account |
| `tax_profile` | tax-profile.cjs:45 | id=1, payload JSON | the taxpayer profile and linked accounts (no identifiers) | TaxProfile | one row |
| `income_events` | income-events.cjs:31 | id PK, account, payload JSON | one dividend, distribution or interest payment | IncomeEvents | user removal |
| `income_declarations` | income-events.cjs:31 | year PK, payload JSON | the user's declaration for a tax year | IncomeEvents | kept |

**Market data, research, news, discovery**

| Table | Created | Columns | A row is | Owner | Retention |
|---|---|---|---|---|---|
| `securities` | security-master.cjs:46, 48 | symbol PK, name, englishName, market, type, isin, industry, sector (added), marketCap (added) | one listed instrument | SecurityMaster | replaced per market at refresh (security-master.cjs:69) |
| `security_master_meta` | security-master.cjs:46 | market PK, count, updatedAt | when a market's list was loaded | SecurityMaster | one row per market |
| `instrument_metadata` | portfolio-view.cjs:22 | symbol PK, payload JSON | the user's own labels for a holding | PortfolioView (`portfolio:metadata`) | kept |
| `watchlist` | discovery.cjs:8 | scope, symbol, payload JSON; PK(scope, symbol) | one watched symbol of an account (source user or AI, reason, pin) | Watchlist | removal; AI entries capped (discovery.cjs:12) |
| `research_cache` | research-service.cjs:39 | symbol, source, at, payload JSON; PK(symbol, source) | the latest answer of one source for one symbol | ResearchService | one row per pair; overwritten |
| `research_snapshots` | research-service.cjs:39 | symbol, day, payload JSON; PK(symbol, day) | a per-day research record (inferred) | ResearchService | kept |
| `research_gaps` | research-gaps.cjs:30 | scope, symbol, payload JSON; PK | a lasting data gap for a symbol | research-gaps.cjs (part 3) | deleted when closed |
| `macro_snapshot` | macro.cjs:119 | id=1, payload JSON | the last macro reading | MacroStore | one row |
| `us_earnings` | us-calendar.cjs:19 | symbol PK, date, payload JSON | the next listed U.S. earnings date of a company | UsCalendar | past dates deleted (us-calendar.cjs:36) |
| `us_largest` | us-calendar.cjs:19 | symbol PK, rank, marketCapUSD | the largest U.S. companies | UsCalendar | replaced at refresh (us-calendar.cjs:38) |
| `us_calendar_meta` | us-calendar.cjs:19 | key PK, value | refresh times | UsCalendar | kept |
| `news_events` | news-events.cjs:35 | id PK, firstSeenAt, payload JSON | a headline or filing matched to a relevant symbol | NewsEvents | by age (news-events.cjs:48) |
| `market_narratives` | narrative.cjs:52 | id PK, timestamp, payload JSON | one market narrative | narrative.cjs | newest 60 (narrative.cjs:53) |
| `narrative_hidden` | narrative.cjs:52 | id PK | a driver the user hid | narrative.cjs | until unhidden |
| `narrative_slots` | automation.cjs:122 | id=1, slot | the last narrative time slot run | Automation | one row |
| `market_episodes` | episodes.cjs:27 | id PK, day unique, payload JSON | a large market move with its narrative | episodes.cjs | kept (single deletes) |
| `symbol_closes` | scoreboard.cjs:22 | symbol, day, close; PK | a daily close for scoring decisions | scoreboard.cjs (`refreshDecisionCloses`, main.cjs:673-676) | kept |
| `symbol_close_fetches` | scoreboard.cjs:22; scout-feedback.cjs:48 | symbol PK, at | when a symbol's closes were last fetched | both | one row per symbol |

**Trading engines (part 2)**

| Table | Created | Columns | A row is | Retention |
|---|---|---|---|---|
| `live_policy` | live-engine.cjs:20 | accountKey PK, payload JSON | an account's trading policy | one per account |
| `live_intents` | live-engine.cjs:20 | id PK, accountKey, payload JSON | one order the app proposed or sent | kept |
| `broker_orders` | live-engine.cjs:20 | id PK, accountKey, day, seenAt, payload JSON | one order as KIS reported it, with KIS's kind name (`creditName`) and loan date (`loanDate`) when given | kept |
| `broker_order_charges` | live-engine.cjs:20 | id PK, accountKey, payload JSON | KIS's fee-and-tax figure for a Korean order made outside the app, or its read attempts | kept |
| `buyback_removals` | buyback.cjs | account, market, symbol PK, removedAt | your Remove of a buy-back block (covers sales up to its time; a later sale outside the app blocks again) | kept |
| `exposure_policy`, `product_overrides` | exposure.cjs:34 | see 2.2 | | |
| `guardrail_events` | guardrails.cjs:8 | id PK, day, payload JSON | a guardrail that tripped | kept |
| `review_failures` | guardrails.cjs:8 | day PK, count | failed reviews per day | kept |
| `auto_order_slots` | guardrails.cjs:8 | id PK, day, payload JSON | one automatic submission slot of a day | kept |
| `conditional_orders` | agent-desk.cjs:35 | id PK, scope, status, payload JSON | a stop, take-profit or other conditional order | kept |
| `plan_stop_failures` | agent-desk.cjs:35 | id PK, scope, payload JSON | a purchase left without a stop | kept |
| `agent_triggers` | agent-desk.cjs:35 | id PK, scope, status, payload JSON | a review trigger the agent set | kept |
| `agent_notes`, `agent_note_history` | agent-desk.cjs:35 | scope, symbol, payload (PK scope+symbol); history: id auto, scope, symbol, payload, replacedAt, reason | the agent's note per symbol and its earlier versions | notes deleted by user or staleness (agent-desk.cjs:42, 70, 76); history kept |
| `pending_decisions` | pending-decisions.cjs:11 | id PK, scope, symbol, status, payload JSON | a decision made while the market was closed | non-pending rows deleted (pending-decisions.cjs:15) |
| `waits` | waits.cjs:50 | id PK, scope, symbol, status, payload JSON | what a symbol waits for | ended rows deleted (waits.cjs:55) |
| `review_watches` | review-watches.cjs:3 | scope, symbol, payload JSON; PK | a price watch set by a review | reset per scope |
| `alert_observations` | watch-alerts.cjs:81 | id auto, at, payload JSON | what the selective alert rules would do | kept |
| `alert_trials` | alert-trial.cjs:31 | id auto, payload JSON | an alert trial | kept |
| `paper_account`, `paper_loss_policy`, `paper_caps`, `paper_proposals`, `paper_orders`, `paper_fills` | paper-engine.cjs:10-15 | one-row JSON x3; id PK + payload x2; fills: seq auto, id unique, payload | the simulated account | kept |

**AI, learning, scout (part 3)**

| Table | Created | Columns | Retention |
|---|---|---|---|
| `automation_settings`, `claude_trading_state`, `review_backoff` | automation.cjs:110, 112, 619 | id=1, payload JSON | one row each (`claude_trading_state` deleted at automation.cjs:989) |
| `reviews` | automation.cjs:110 | id PK, payload JSON | kept |
| `lessons` | automation.cjs:110 | id PK, text, approved | kept |
| `reviewed_fills` | automation.cjs:110 | id PK | kept |
| `ai_usage`, `ai_usage_vendor` | automation.cjs:110 | day PK, calls, reservedMicro; vendor table PK(day, vendor) | kept |
| `ai_calls` | automation.cjs:111; reflection.cjs:10 | id PK, day, payload JSON | kept |
| `dry_runs` | automation.cjs:110 | id PK, timestamp, payload JSON | kept |
| `review_clock` | automation.cjs:110 | scope PK, payload JSON | one per scope |
| `provider_backoff` | automation.cjs:626 | vendor PK, payload JSON | one per vendor |
| `token_savings` | automation.cjs:328, 333 | day PK, payload JSON | kept |
| `review_gate`, `review_gate_log` | review-gate.cjs:133 | scope PK + payload; log: id auto, at, payload | log by age (review-gate.cjs:140) |
| `review_intervals` | review-interval.cjs:8 | scope PK, payload JSON | one per scope |
| `schedule_observations` | schedule-observer.cjs:50 | id PK, at, kind, payload JSON | kept |
| `context_failures` | context-failures.cjs:23 | id PK, hash unique, firstAt, lastAt, count, bytes, payload | by age and row cap (context-failures.cjs:35-36) |
| `review_contexts`, `replay_runs`, `routing_eval` | replay.cjs:7 | id PK, timestamp, payload (routing_eval also account) | contexts capped (replay.cjs:10); runs newest 20 (replay.cjs:12); routing_eval kept |
| `assessments` | assessments.cjs:33 | scope, symbol, version, payload; PK all three | pruned per scope (assessments.cjs:52) |
| `trade_outcomes`, `outcome_versions` | outcome-ledger.cjs:27 | id PK + payload; versions: outcomeId, version, signature, payload, recordedAt | kept |
| `lesson_evidence`, `lesson_lifecycle`, `lesson_history`, `lesson_trials` | learning-memory.cjs:33; lesson-trials.cjs:4 | id PK (+signature) + payload; history seq auto | kept |
| `reflections`, `reflection_usage` | reflection.cjs:10 | id PK + payload; day PK, calls, reservedMicro | kept |
| `scout_plans`, `scout_slots`, `scout_requests`, `scout_failures` | scout.cjs:68, 79 | plans: id PK, scope, timestamp, payload; slots: scope PK, slot; requests: PK(scope, day), count, lastAt; failures: scope PK, payload | plans newest 30 per scope (scout.cjs:71) |
| `scout_briefs`, `scout_picks` | scout-feedback.cjs:21, 48 | briefs: id PK, scope, timestamp, status, payload; picks: id PK, scope, symbol, pickedAt, endedAt, payload | kept |

Total: 119 distinct table names in 56 files (search `CREATE TABLE IF NOT EXISTS` in electron/; `ai_calls`,
`symbol_close_fetches`, `token_savings` and `trade_history_reads` are each created in two places with the same
columns).

## 3. Portfolio and reporting features

Each feature: what it does / where the data comes from / where it is shown. Screens are named only; part 1 has them.

### 3.1 Holdings and account value

| Feature | What it does | Data and mechanics | Shown |
|---|---|---|---|
| Korean balance | Cash, settled (D+2) cash and holdings of the Korean account | KIS `inquire-balance` (TR `TTTC8434R` live / `VTTC8434R` mock, kis-client.cjs:183) through worker operations `import`/`refresh` (kis-worker.cjs:105-109). Refreshed every 120 s (main.cjs:756) and on request (`kis:refresh`, `portfolio:refresh`) | Home, Portfolio (`UnifiedPortfolio.tsx`), `KisAccount.tsx` |
| Korean prices | Latest price per held, watched or allowed symbol, at most 20 | REST `quotes` every 30 s (main.cjs:146-160, 753) plus the KIS stream (`kisService.onQuote`, main.cjs:34-43); a streamed tick wins unless it is over 60 s old (main.cjs:155). A `RATE_LIMITED` poll waits 120 s (main.cjs:158) | `market:changed` -> every page |
| U.S. balance and prices | USD cash, pending sale proceeds, holdings, quotes | Worker `us-context` (kis-worker.cjs:31): KIS overseas `inquire-balance` `TTTS3012R` and `inquire-present-balance` `CTRP6504R` (kis-overseas.cjs:44, 47). Every 60 s when KIS is free and not cooling down (`automation.refreshUS`, main.cjs:241, 293-298); at most 20 symbols | Portfolio, U.S. stocks |
| Settlement holds | While KIS moves a settlement overnight, a reading that is inconsistent is not used: the last consistent one is held, or the new one is marked provisional | `BalanceHold` / `UsBalanceHold` (settlement-check.cjs; `useKr`, `useUs`, main.cjs:45-59). A provisional reading sets no daily record, high, low or graph point (main.cjs:47, 530, 544) | part 2 for the rules |
| Combined portfolio | One list of rows (both markets) with sector, region, colour, value in KRW, and totals | `combinePortfolio` (portfolio-view.cjs:4-20): Korean equity = settled cash (or deposit cash) less KRW committed to unsettled U.S. buys + holdings; U.S. equity = USD cash + pending sale proceeds + holdings; U.S. values in KRW at `fx.usdKRW`. `totals.equityKRW` only when both markets are in scope and the low bound is known (portfolio-view.cjs:18) | Home Holdings card (every holding), Portfolio, allocation chart |
| Net equity (the valuation) | One figure per market and combined, as a low and a high bound with components and reasons; the headline is the low bound | `valuation.cjs value` (formula at valuation.cjs:1-20: cash + long value + receivables - settlement payables - margin principal - short liability - accrued financing). U.S. sale proceeds awaiting settlement are the receivable; U.S. buys awaiting settlement are a payable in full, not netted against those sales (`integrated-settlement.cjs settlement`, since 1.5.71). Unknown is never zero: it makes the value incomplete or a range. Credit accounts take KIS net assets (`nass_amt`) and are marked unverified (valuation.cjs:17-19), except a settled distribution short (B3a, found in live use): when every credit row is a distribution short (유통대주; no margin loan, no own-stock-loan short), net assets = total value - tot_loan_amt to the won and tot_loan_amt = the shorts' loan_amt to the won, the value is exact: net assets (which count a short as zero) plus each short's proceeds less its obligation at market (stln_slng_chgs - loan_amt). The rule depends on the summary and the rows coming from one balance response (they do: `getBalance` reads both from the same pages). Otherwise the range stays, with a reason naming an own-stock-loan short or a margin loan; by design the old range branch still deducts a short twice in its low reading until 자기대주 and 융자 rows have been seen. The flow detector moves Korean cash for the app's own short sale by its fees only, and for its cover by the proceeds of its own lot (the app's short sales of the stock whose KIS loan date, `lotLoanDate` from the order history, is the cover's `credit.loanDate`) less the buy-back and fees; a cover with no short of its lot known is not explained. Also feeds the loss check (`netEquityOf`, main.cjs:518-521) | Portfolio valuation notes; AI context (`automation.valuation`, main.cjs:404) |
| In-flight U.S. fills | U.S. fills KIS's figures do not show yet are tracked until evidence or age closes them | `InFlight` (valuation.cjs:238, table `inflight_settlement`), `FundingTracker`, `FundingTransfers`, settlement evidence tables; run at each new U.S. reading inside `detectFlows` (main.cjs:500-504). Rules in part 2 | one read-only line on the U.S. page (`settlingFills`, main.cjs:487); `SettlementEffects.tsx` |
| Instrument labels | The user's sector and region per symbol | `instrument_metadata`; `PortfolioView.save` accepts exactly `{sector, region}`, each at most 100 characters (portfolio-view.cjs:24) | Portfolio |
| Daily record (`nav_history`) | One row per account and Seoul day: per market `equity, cash, open, high, low, positions` (at most 80 holdings each), `fx`, `equityKRW` with its high and low, the valuation bounds, the settlement tracker's state | `PerformanceHistory.record` (performance.cjs:33-53) called every 60 s and when Performance opens (`recordValue`, main.cjs:530-534, 572). Not written: while a reading is provisional; before the U.S. balance has loaded; when the U.S. refresh failed and a U.S. buy may await settlement (the day then has no record; one log line per day, main.cjs:526-533). History cannot be backfilled from KIS (main.cjs:463) | Performance, Home value box, Movement cards |
| Intraday values | Today's equity samples for the "Today" chart | `IntradayValues.record` every 60 s, at least 120 s apart, only a value covering the account's markets and no held or provisional reading; rows older than 3 days are deleted (phone-snapshot.cjs:8-13; main.cjs:544) | phone snapshot chart (chart-image.cjs); Home value box (not determined) |
| Snapshot (`snapshots`) | The made-up demo portfolio used before KIS is connected. It is not the real account | `saveSnapshot` (storage.cjs:37-54); `syntheticState` (main.cjs:131-136) | `getSnapshot`; pages without a KIS connection |
| Broker's raw figures | KIS's own numeric balance fields, kept when they change, for later reconciliation | `BrokerBalances.record` in `detectFlows` (main.cjs:500); limits 30 days and 3,000 rows (`LIMITS`, broker-raw.cjs:17) | not shown (evidence) |

### 3.2 FX rates

| Use | Rate | Cite |
|---|---|---|
| Valuation and buying power | From the U.S. balance: the USD cash row's first published rate (`frst_bltn_exrt`, "KIS first published rate"); with no USD held, the base rate on a holding row (`bass_exrt`); else unknown | kis-overseas.cjs:29-35 `usdRate` |
| Fallback when no U.S. reading exists | The user's indicative rate from the costs settings (`usdKRW`, "User indicative rate") | main.cjs:299 `automation.fx` |
| Tax ledger (settlement-date conversion) | ECOS USD/KRW reference rate per day, stored in `fx_rates`; fetched by the provider worker (`fx-rates`) for the days the ledger lacks, at each charges check, and saved from each macro refresh | main.cjs:598, 660; macro.cjs:112; provider-worker.cjs:29-30 |
| Daily record | The rate of the reading is saved with the day (`fx`) and used to convert U.S. flows and values in the combined series | performance.cjs:48, 121 |

### 3.3 Performance

| Feature | What it does | Data and mechanics | Shown |
|---|---|---|---|
| Series | Three series: `KRW` (Korea), `USD` (U.S.), `COMBINED` (both, in KRW) | From `nav_history`, `cash_flows`, corrections and adjustments (performance.cjs:121-130 `series`) | `AccountPerformance.tsx`, `PerfCharts.tsx` |
| Returns | Time-weighted: a flow is applied at the start of its day, so a deposit is not a gain. Transfers between the two markets count in each market's series and not in the combined one. A day without a valid base has no return (never 0%); a gap breaks the chain and the window's return is then unavailable | performance.cjs:2-3, 132-142, 232-234 | Performance summary; Home Result tile |
| Periods | `1W, 1M, 3M, YTD, 1Y, All` | `PERIODS` performance.cjs:5 | Performance |
| Benchmarks | Index daily closes: KOSPI, KOSDAQ, KOSPI 200, S&P 500, Nasdaq Composite, Nasdaq 100, Dow, SOX, VIX. The combined series is compared with KOSPI; each market with `benchmarkFor(kind)` (the mapping itself: not determined) | KIS index history (`index-history`; TR `FHKUP03500100` domestic, `FHKST03030100` overseas, kis-index.cjs:6-8), saved in `benchmark_closes`. Refreshed every 6 h and soon after each market close (main.cjs:555-559), and on request | Performance, Scoreboard, market narrative (`indexCloses`, main.cjs:386) |
| Risk figures | Peak and trough value, max drawdown, "below return peak" (current drawdown), annualised volatility (daily standard deviation x sqrt(252)), best and worst day. Drawdowns come from the time-weighted index, not raw values, and are null when the window has a day without a return | `analyze` (performance.cjs:230-257); `reviewRisk` rules D1 (performance.cjs:263-286) | `AccountPerformance.tsx:71`; AI context (main.cjs:563-566) |
| Result tile | Total result since the first daily record, the latest day, unrealized gain, the benchmark. Unknown figures are null with a reason, never zero; realized gain is left out | `src/home-result.mjs` (lines 1-4, 58-90), from `performance:get` | `Home.tsx:56, 72` |
| Movement | Per holding: recorded daily positions (last 200 days) and the app's filled orders, with daily closes | `movement:records` (nav_history + `automation.engineOrders()`), `movement:closes` (research cache `daily`, 6 h) (main.cjs:573-587; movement-records.cjs) | `HoldingMovement.tsx` |
| Deposits and withdrawals | The user records a flow, confirms or removes a detected one, or marks a detected inflow as income (it becomes an income record) | `performance:add-flow / confirm-flow / remove-flow / flow-is-income` (main.cjs:588-593). A recorded flow replaces a matching detected one (same market and sign, amount within KRW 10,000 or USD 10, date in range; performance.cjs:79-81) | Performance |
| Flow detection | Finds deposits and withdrawals the user did not record: between two balance readings, the cash change no order explains. It is first held, then resolved by evidence (balances returning, an exchange between markets, a settlement payment); otherwise recorded as a detected flow after 2 hours (`HOLD_MS`), up to 4 days while a U.S. settlement could explain it (`MAX_HOLD_MS`); a rise nothing else can explain after 10 minutes (`SHORT_MS`) and 2 reads of the other market. Korean orders KIS lists that the app did not send (orders made outside the app, `outside-fills.cjs`) are counted like the app's fills: a cash sale + amount − fees and tax, a purchase − amount − fees, a short sale (유대신규) − fees only, its cover (유대상환) + the short's proceeds − the buy-back − fees; margin kinds and unknown names are not explained. Fees are KIS's figure for the order (read once filled, `refreshOutsideCharges`), the estimate until then; a fill of ₩20,000,000 or more waits for KIS's figure. KIS's history is read whether or not Order tracking is on (`syncHistories`). A fill KIS lists before its cash reaches the balance holds the change it makes ("an order made outside the app is waiting for its cash"), never recorded early, and says so when the cash arrives. A Korean rise is recorded early only once the day's KIS order history was read after it (`ordersThrough`; not read for 3 minutes: the 2-hour hold, reason "the day's KIS orders were not read"). A detected flow such an order explains when its row comes later is withdrawn, or reduced to the rest, with a note; one the user confirmed stays and is asked about on Home (dismissible, 7 days). An order is known by its day and KIS number together (numbers restart daily). A row without KIS's kind name (recorded before names were kept) is not explained. An outside fill keeps the cash effect it was first counted with; only KIS's figure replaces an estimate, once, and a fill that grows is counted anew. A recorded detected flow is settled only by fills whose amount is within the threshold of the flow's (one fill, or the fills first seen together), whose cash did not move in this reading, and which the history read after the flow did not leave out; a larger flow is never reduced. A detected flow the user removed is remembered for 10 days, so its fill arriving later is not counted again. The detector gets no outside orders until today's history and the missed days were read for the connected account; the first reading that has them counts fills already in the cash as seen. The Korean history is read every 60 s while the market is open, every 5 minutes after the app's session until 20:00 KST (KIS's last fill of the day), once after it, once at a start on a closed market, yesterday's once at a new day, and the missed days (the newest 10 business days) once per account; a failing read waits 1, 2, 4 … 30 minutes. It is complete up to its last read, or, after the day's last fill, until 08:00 of the next business day (`historyThrough`). A fee figure that could not be read after 6 attempts leaves a large fill estimated (`estimate-unread`), and its Activity note says so. A large fill waiting for KIS's figure holds a Korean rise ("an order made outside the app waits for KIS's fee figure") until it is counted. A sale held before the history was read is explained at the first reading that has it, not seeded. A detected flow counts as removed by the user only through the user's Remove (`noteRemoved`); a flow the user replaced with their own record is asked about. Each reading is one transaction. Reads: also every 5 minutes from 08:00 to 09:00 KST; at a new day yesterday's history and the missed days again; a failing read waits at most 3 minutes while the session is open. After 10 minutes without a complete history, Home says so (`history-unread`). When more than one recorded flow fits a fill, only the one whose window holds the order without the 10-minute slack is settled, and only if exactly one does; otherwise none is changed and each is asked about on Home (as is a lone fit through the slack while a flow of about that amount the user removed is remembered). KIS's fee figures are read newest first, for rows the detector can list. A fill is held back from seeding, and from settling a recorded flow, only when a held change has a part of about its amount made at or after the order. KIS's fee figure is read for today's and yesterday's outside fills and for any older large fill still waiting; after 6 failed attempts it is estimated (`estimate-unread`), which ends the wait. The missed days (both markets) are the business days from the last reading before the start (latched per account at the first reading of the start: `buyback.cjs startLatch`; none: 31 days back), that day included, in each market's own days (the U.S. by the New York day), within the last 31 calendar days; read one at a time a second apart, off the tick, with progress kept per day; a failing day is retried after 5 minutes and named on Home after 3 tries; after a day change and an account switch they are read again (a switch reads the history at once). The buy-back list is kept 5 seconds and dropped when a market's history is recorded or a block removed. U.S. order rows carry KIS's order time (KST) when given. A reading's notes are sent only once it is saved; outside fills' stored effects and counted fills are pruned after 110 days. Known behaviour: a weekday holiday the calendar does not know is read needlessly. | `FlowDetector.observe` at the end of `detectFlows` (main.cjs:509-512); flow-detector.cjs:1-29; state in `flow_watch`; results in `cash_flows` | Performance; System log |
| Cash checks | The Home "Needs you" line for a change the detector still holds: "Korean cash up ... seen 14:02 - checking; not a return yet", with [Record it] (opens Performance with the form filled). One item per market, or one for both when they point opposite ways (may be an exchange); nothing to record when an open order may explain it | `cash-checks.cjs attentionItems` (lines 14-24) from `flowDetector.pending` (main.cjs:606) | Home; AI context `cashChangesBeingChecked` (main.cjs:565) |
| Effect on figures | While awaiting the user, the headline counts detected and held changes as deposits or withdrawals; the summary is marked provisional and carries the other scenario (`provisional.excluded`). The AI context keeps the 'exclude' reading | performance.cjs:122-125, 199-203; main.cjs:563-565 | Performance |
| Valuation corrections | A recorded day is never rewritten. A correction is a versioned adjustment kept beside it, previewed first and applied only with approval; a later version supersedes | `ValuationCorrections` (valuation-corrections.cjs:1-16), `performance.adjustments` (main.cjs:462). No IPC channel applies one (none in preload.cjs); how the user approves: not determined | series only |
| Accounting corrections | Cash-free changes of the U.S. low basis from settlement bookkeeping, shown apart and left out of P/L and returns | `performance-corrections.cjs`, `performance.corrections` (main.cjs:491-494) | `SettlementEffects.tsx` (inferred) |
| Damaged records | A row that cannot be parsed is skipped, counted and logged once per run; a failed read gives `PERFORMANCE_UNREADABLE` | performance.cjs:55-58; main.cjs:457-459, 569-571 | "The performance records could not be read." |

### 3.4 Activity

| Feature | What it does | Data and mechanics | Shown |
|---|---|---|---|
| Period list (orders) | Orders in both markets for a date range of at most 60 days back, newest first | `kis:activity` (main.cjs:800-825): KIS Korean order history (`orders`, kis-worker.cjs:72; shapes checked in `normalizeOrders`, kis-activity.cjs:25-44) joined with `us-order-history`; a U.S. failure still shows the Korean part (`usError`) | `ActivityReport.tsx` |
| Chains | KIS gives a revised or cancelled order its own row; where the app knows the chain, rows that would count fills twice are marked | `activity-chains.cjs markChains` (main.cjs:816) | totals (`src/activity.mjs`) |
| Origin | Each row says where it came from: a review, a conditional order (stop), the user's ticket, "Changed outside the app", "Outside the app"; orders decided but not sent are listed with the reason | `activity-origin.cjs labelRows`, `order-origin.cjs` (`madeBy` mark on `live_intents`; older orders matched to reviews in SQL) (main.cjs:817-820) | Activity "From" column |
| Today strip | Today's app orders by outcome and the latest five, with no KIS request | `activity:today` from `live_intents`, reviews and conditional orders (main.cjs:795-798; activity-today.cjs:1-4) | Activity |
| Cache | The page opens with the last report; a report of another account is never shown | `activity_last` (activity-cache.cjs:1-16). An automatic refresh is skipped while an order is being sent, a review runs or another account request runs (`skipReason`, main.cjs:805); at most every 5 minutes (`FRESH_MS`) | Activity, Performance |
| Realized P&L | Realized profit per trade day with fees and taxes, "as KIS reports it, not total return" | KIS `profit` report (`rlzt_pfls`, `fee`, `tl_tax`; kis-activity.cjs:45-53). Korean account only (the handler adds U.S. rows to `orders` only, main.cjs:813). The app computes no realized P&L of its own for the Home tile (home-result.mjs:4) | `ActivityReport.tsx:92-102` |
| Console log | Every AI and System entry | `events` table, newest 600 (storage.cjs:20-36) | AI console; export to JSON by the user (`events:export`, main.cjs:841) |

### 3.5 Fees, taxes and income

| Feature | What it does | Data and mechanics | Shown |
|---|---|---|---|
| Commission plan | Rates used for estimates: Korea 0.015%, U.S. 0.25%, U.S. sale fee 0.00206% with a USD 0.01 minimum (defaults; the user edits them) | `DEFAULT_COSTS` trading-costs.cjs:5; `costs:get/save` | `TradingCosts.tsx` |
| Korean sale tax | Dated statutory rules: 2026 KOSPI 0.05% + 0.15% rural tax, KOSDAQ 0.20%, KONEX 0.10%; ETFs and ETNs exempt; an unknown market takes the higher rate, labelled an assumption; the user may set an override | `KR_SALE_TAX` tax-rules.cjs:15-20; trading-costs.cjs:24-25 | order estimates, Tax ledger |
| Broker-reported charges | Actual fee and tax per executed order | `engine.refreshCharges()` for both engines every 15 minutes (KIS `charges`, kis-worker.cjs:69; main.cjs:660-666) | Costs page |
| U.S. tax record | The broker's U.S. trade history is the tax record: from January of last year once a day in 90-day windows, the last two weeks at every check; live accounts only. A range not read whole stays a named gap and is retried | `importTaxTrades` (main.cjs:651-659), `TradingCosts.syncHistory`, `trade-history.cjs`; tables `tax_events`, `trade_history_*` | `TaxLedger.tsx` |
| Overseas gains tax | Yearly: net gain above KRW 2,500,000, then 20% + 2% local; amounts below 10 won dropped (an assumption) | `OVERSEAS_GAINS`, `overseasGainsTax`, `ROUNDING` tax-rules.cjs:21-41 | Tax ledger |
| Lots | Cost basis per instrument and account: moving average (KIS's method, default) or FIFO; opening lots entered by the user for shares bought before the record | tax-lots.cjs:1-10; `taxMethod` trading-costs.cjs:5, 16; `costs:add-opening-lot` | Tax ledger |
| Tax result certainty | Every figure is `reconciled`, `estimated`, `incomplete` or `unsupported`, with missing inputs and assumptions | `taxResult` tax-rules.cjs:44-49 | Tax ledger |
| Taxpayer profile | Whether the ordinary rules apply (resident, account type, major shareholder) and which accounts are the same owner; no identifiers kept | tax-profile.cjs:1-3; `costs:tax-profile` | Tax ledger |
| ETF tax class | The user says how a Korean ETF is taxed (the master cannot tell) | `fund_tax_class`; security-tax-classification.cjs:1-3 | Tax ledger |
| Income | Dividends, distributions, interest: gross, foreign and Korean withholding and net kept apart (15.4% Korean withholding rule); yearly declaration | income-events.cjs:1-3; `WITHHOLDING` tax-rules.cjs:25; `costs:add-income / remove-income / declare-income` | Tax ledger |

### 3.6 Charts and indicators

| Feature | What it does | Data and mechanics | Shown |
|---|---|---|---|
| Company chart | Company facts, daily and minute bars for one symbol | `company:get`: three `company-chart` requests (`company`, `daily_technicals`, `minute_technicals`), cached 30 s, one at a time (main.cjs:313-315) | `CompanyView.tsx`, `CandleChart.tsx` |
| Technical summary bars | Extra bars: Korea today's 1-minute bars (combined into 5/15/30/60), 200 weekly, 100 monthly; U.S. 120 bars per intraday interval | `chart:bars` -> `kis-evidence.cjs fetchBars` (lines 46-49), cached 60 s per symbol (main.cjs:303-312) | `TechnicalSummary.tsx`, `src/technical-summary.mjs` |
| Live ticks | A chart window follows its symbol: Korean symbols join the stream (at most 5 charted, 20 in all); U.S. symbols, and Korean ones while the stream is down, are polled every 10 s while a session is open. Ticks do not feed the portfolio or reviews | main.cjs:23-37, 237, 305-308; kis-worker.cjs:89-92 | `ChartWindow.tsx` |
| Holdings history | Daily, 1-minute and 5-minute candles for held symbols | `market:history`, cached per time bucket (main.cjs:769-781) | Portfolio charts |
| Indicators | RSI 14, stochastic RSI, MACD (12/26/9), ATR 14, ADX 14 with +DI/-DI, CCI 14, ultimate oscillator, 20-day range position; values only, no buy or sell labels; needs 15 candles | `indicators.cjs technicals` (lines 22-29). Callers: not determined (the screen's summary is computed in `src/technical-summary.mjs`, inferred) | AI evidence (part 3) |
| Phone chart image | Today on top, last 30 days below, drawn as a PNG in a hidden sandboxed window | chart-image.cjs:1-2; `notifier.render` (main.cjs:545) | phone snapshot |

### 3.7 Security master and instrument data

- **What**: a local list of every listed instrument (KOSPI, KOSDAQ, NASD, NYSE, AMEX) with name, English name, type
  (stock, etf, etn, reit, fund), ISIN, industry, sector, market cap.
- **Source**: KIS's public master files at `https://new.real.download.dws.co.kr/common/master/` (five ZIP files; no
  account access), downloaded in the main process (security-master.cjs:3-9). Refreshed when older than 20 hours
  (`REFRESH_MS`), checked hourly (main.cjs:454); each market is replaced in one transaction and a failed market keeps
  its rows (security-master.cjs:57-70). Tests never download (main.cjs:354-356).
- **Used by**: search (`discovery:search`), names on orders (`live.nameOf`), product classification, news matching,
  U.S. calendar symbol mapping, peers (security-master.cjs:72-73). Shown in `Discover.tsx`, `SymbolField.tsx`.

### 3.8 Market calendars and sessions

| Item | Source and mechanics | Cite |
|---|---|---|
| Korean holidays | Official KRX list from KIS (`chk-holiday`, TR `CTCA0903R`) through the calendar worker, for today and 24 days ahead, into `kr_calendar`; refreshed every 6 hours. Needs a second, live key. Without it: "Weekdays only" | main.cjs:83-89, 535, 706; calendar-worker.cjs:21-23 |
| Korean days with other hours | A hand-kept table; today only 2026-11-19 (exam day: regular 10:00-16:30, app orders until 16:20) | kr-hours.cjs:9-16; docs/EXTERNAL-FACTS.md `F-KRX-CSAT-2026` |
| U.S. holidays and early closes | Rules in code ("NYSE holiday and early-close rules, checked against nyse.com for 2026-2027") | main.cjs:708; market-sessions.cjs (part 2) |
| Session status | Every session today for both markets, what is open, what is next, what this account may trade | `market:status` (main.cjs:707-708) -> `MarketStatus.tsx` |
| U.S. earnings dates | Nasdaq's public calendar API (`api.nasdaq.com/api/calendar/earnings?date=`), every weekday for 21 days ahead, 0.8 s apart; and the 200 largest U.S. companies from Nasdaq's screener. Refreshed when older than 20 hours | us-calendar.cjs:27-41; main.cjs:411-415 |
| Event calendar | Macro releases, options expiries, earnings, dividend record dates and meetings for relevant symbols; built from cached research, nothing fetched | event-calendar.cjs:1-2, 16; main.cjs:427-431 |
| Korean earnings | OpenDART (announced results date replaces the estimate); U.S.: the listed date first, then an SEC-based estimate | main.cjs:428-431 |

### 3.9 Macro snapshot

- **What**: 15 series. Korea (ECOS): base rate, USD/KRW, 3- and 10-year KTB yields, CPI y/y. U.S. (FRED): fed funds,
  2- and 10-year Treasury, CPI y/y, unemployment, VIX, WTI, Brent, broad dollar index, high-yield spread
  (`SERIES`, macro.cjs:4-20). Plus a release calendar (CPI, jobs, GDP, PPI, PCE, retail sales, JOLTS; macro.cjs:23)
  and FOMC days from a hand-kept 2026 schedule (macro.cjs:95).
- **Source**: fetched in the provider worker (`macro`); works without keys (FRED CSV downloads, ECOS sample access
  limited to 10 rows); keys add full ECOS access and the FRED release calendar (provider-worker.cjs:26-28;
  macro.cjs:3, 76). First refresh 30 s after start, then every 6 hours (main.cjs:599). One row, `macro_snapshot`; a
  series keeps its last good value when a refresh fails for it (macro.cjs:120).
- **Shown**: `MacroView.tsx` (`macro:get`, `macro:refresh`); given to the AI in a compact form (macro.cjs:128).

### 3.10 News

| Item | Mechanics | Cite |
|---|---|---|
| Sources | The user's RSS/Atom feeds (https only, no private addresses, 15 s limit, at most 50 items, 500,000 characters); Yahoo per-ticker feeds for up to 5 U.S. holdings or watchlist names (`usTickerNews`); KIS market headlines (`FHKST01011800`, `kisNews`); today's OpenDART filing list (up to 5 pages of 100) | main.cjs:109-124; news.cjs:5-37; kis-worker.cjs:78-80; provider-worker.cjs:37-44 |
| Refresh | Every 5 minutes when auto trading is on with a news trigger, else every 30 minutes; and on request | main.cjs:242, 737 |
| Headlines list | Up to 200, newest first, deduplicated by URL, kept in memory | main.cjs:121 |
| Events | Items matched to relevant symbols (holdings, watchlist, allowlists, watches) are stored once in `news_events` with importance; kept 14 days (`RETAIN_MS`) | news-events.cjs:1-3, 37-48; main.cjs:452-453 |
| Stories | "Top stories": a term bursting across many outlets in 24 hours groups headlines into a story | news-stories.cjs:1-5 |
| Trigger | An event not yet used starts a review while inside its trigger window: mode `all`, or `disclosures` (default: only high-importance DART filings), or `off` | news-events.cjs:55-62; automation.cjs:15 `newsTrigger` |
| Shown | `NewsView.tsx`, `NewsSources.tsx`; Home item "important disclosures about your stocks today" | main.cjs:619 |
| Opening a link | Only a URL the app holds; opened in the system browser | main.cjs:745 |

### 3.11 Discovery, watchlist and research cache

| Feature | What it does | Data and mechanics | Shown |
|---|---|---|---|
| Watchlist | Per account; symbols join the review universe and the quote poll. The user adds, removes, pins; the AI may add up to 3 per call and remove only its own unpinned entries; AI entries are capped | `watchlist` table; `discovery:watch` (main.cjs:689); discovery.cjs:12, 42 | `Discover.tsx` |
| Screener | KIS rankings joined with the master | worker `screen` -> `kis-rankings.cjs` (kis-worker.cjs:86-88); `discovery:screen` | Discover |
| Starter candidates | With no allowlist, watchlist or holdings in a market, its largest listed companies | `StarterCandidates` (main.cjs:369-372; discovery.cjs:51-53) | AI context |
| Company research | Sections (overview, about, analysts, estimates, financials, dividends, events, release, flows, risk, valuation, peers, fund, holdings, factors, fairvalue) built from KIS, OpenDART and SEC EDGAR | `ResearchService` (research-service.cjs:15-24); `research:company` (main.cjs:446) | `ResearchPanel.tsx`, `CompanyView.tsx`; AI tools |
| Research cache | One row per symbol and source with its read time. Freshness per source: overview 15 min; fund 30 min; market 10 min; U.S. market 5 min; flows 2 h; analysts, daily, index-daily, SEC earnings 6 h; estimates, DART 12 h; SEC filings 20 h; financials, dividends, meetings, valuation, holdings, SEC facts 24 h; about texts 7 days. A failed source is not retried for 10 minutes | `SOURCES`, `FAILURE_TTL` research-service.cjs:20-25 | |
| Warm-ups | Every 6 hours: daily history, overview, dividends, meetings and DART for up to 25 held or watched symbols (main.cjs:433-434). Daily: SEC filings for the 200 largest U.S. companies and relevant symbols, full facts for a seventh of them, 0.4 s apart (main.cjs:418-425) | | |
| Market overview | Korean breadth, sectors, flows; U.S. indices and sector ETFs with the latest VIX | `research:market`, `research:us-market` (main.cjs:379-381) | `MarketPulse.tsx` |
| SEC contact | SEC asks each client for a contact email; saved in the app (`sec-contact-email`) or in the providers file; sent only to sec.gov; a Test button requests Apple's filings | main.cjs:375-377, 696-703; provider-worker.cjs:31-34 | Connections |

## 4. Platform features

### 4.1 In-app updates

In plain words: the app looks for a new version by itself (if allowed); the user starts the download and the
install; the install is refused while trading is active.

| Topic | Behaviour | Cite |
|---|---|---|
| Source | GitHub Releases of `goheungchoi/financial-portfolio-manager` through `electron-updater`; only installer builds (they carry `app-update.yml`); portable and source runs show `disabled` | package.json build.publish; main.cjs:636-639 |
| Check | Automatic every 6 hours when `checkAutomatically` (default true); ticked 30 s after start and every 10 minutes; or the user presses Check | app-updates.cjs:4, 20, 27; main.cjs:642 |
| Download | Never automatic (`autoDownload=false`); only from state `available` | app-updates.cjs:11, 24 |
| Verification | electron-updater checks the file against `latest.yml` (SHA-512); the desktop test rejects a wrong checksum. Errors reach the screen as codes only (`NETWORK_UNAVAILABLE`, `RELEASE_NOT_FOUND`, `CHECKSUM_MISMATCH`, `SIGNATURE_INVALID`, `UPDATE_FAILED`). Code signing of the installer: not determined (no certificate setting in package.json) | app-updates.cjs:30-31; tests/update-desktop.cjs:1 |
| Install | Only on the user's press, from state `downloaded`; `quitAndInstall(false, true)`. Refused with `AUTO_TRADING_ARMED`, `REVIEW_RUNNING` or `ORDERS_OPEN` (an order Submitting, Uncertain, Accepted or Partially filled). No install on quit (`autoInstallOnAppQuit=false`), no prerelease, no downgrade | app-updates.cjs:11, 25; main.cjs:640 |
| User controls | One setting (`checkAutomatically`); buttons Check, Download, Install | app-updates.cjs:21; `AppUpdates.tsx` |
| Home | "Version X is ready to install" once downloaded | main.cjs:627 |

### 4.2 Notifications, phone snapshots, digest

| Feature | Behaviour | Cite |
|---|---|---|
| Desktop alerts | A Windows notification (`Notification`) when `desktopAlerts` is on | main.cjs:338; notifications.cjs:14, 23 |
| Phone alerts | A webhook URL (`pushURL` in the providers file). Messages are queued in `notification_outbox` and sent one per second-tick by the provider worker (`push`: POST, 20 s limit, no redirects). Retry after 30 s x 2^attempts (at most 1 hour), 5 attempts; unsent after 12 hours expires | notifications.cjs:1, 31-43; provider-worker.cjs:21-25 |
| What is sent | Order status changes (Accepted, Partially filled, Filled, Risk stopped, Canceled, Uncertain, Rejected) of paper, Korean and U.S. orders created after this start; engine alerts (guardrails, start notice, digest) through `automation.notify` | notifications.cjs:9-25; main.cjs:239, 339 |
| Phone snapshot | When a buy or sell fills and `phoneSnapshots` is on: a short post with the portfolio chart instead of the one-line alert. Discord gets an embed with the image; other webhooks plain text; with amounts hidden only percentages. A snapshot older than 30 minutes is sent as text only. A Test button posts one | phone-snapshot.cjs:1-2, 60-63; notifications.cjs:16, 37-40; main.cjs:548-554 |
| Shutdown message | Sent straight to the webhook when Windows ends the session (1.5) | main.cjs:194-198 |
| Phone control | Nothing inbound exists: the app only posts to the webhook; no listener or command channel was found in main.cjs or preload.cjs | |
| Daily digest | Once per Seoul day at or after `digestHour` (default 16, off by default) while the app is open; missed days are not sent later. Content: value and change per market, the day's investment return or why it is unavailable, reviews by decision, orders by outcome, AI calls and cost, guardrails. Local only: no AI or broker call. Stored in `daily_digests`, sent through `notify`; preview with `runtime:digest-preview` | daily-digest.cjs:2, 11-52; automation.cjs:15 |
| Outbox on screen | The last 30 rows (`status()`) in the runtime state | notifications.cjs:45; main.cjs:692 |
| Needs you | The Home attention list is computed on request (`workspace:attention`): cash checks, connect KIS, orders awaiting approval, lessons, guardrail, loss limit, review back-off, provider wait, last review failed, credit warnings, important disclosures, unreadable stops, Claude first review, missing plan stops, the restart notice, an update ready | main.cjs:602-630 |

### 4.3 CPU and responsiveness safeguards

| Safeguard | Mechanics | Cite |
|---|---|---|
| State cache | The parts of `automation.getState()` that only read stored history are reused while the key is unchanged: SQLite `total_changes()`, the settings revision, the account scope, the clock minute and `PRAGMA data_version` (`stateCached`, `historyVersion`). `stateCacheOff` disables it for tests | automation.cjs:127-141 |
| Light state | The two-second poll carries three brief decisions; the 1.6 MB history is fetched only when `historyVersion` changes | runtime-state.cjs:1-18 |
| Learning sync key | The learning sync reruns only when the change count, minute or data version moved | automation.cjs:134-136 |
| Indexed reads | `news_events` is read in index order instead of sorting the table; review ids for Activity are read with `json_extract`, cached per window | news-events.cjs:33-34; order-origin.cjs:25-32 |
| Request caches | Company view 30 s, chart bars 60 s, candle history per bucket, research cache TTLs, one shared U.S. refresh task | main.cjs:292-298, 310, 313, 771-778 |
| Throttles | Quote poll skipped while KIS is busy; 120 s wait after a rate limit; KIS cooldown honoured before any send; Activity's automatic refresh never ahead of an order, review or account request | main.cjs:147, 158, 803; kis-service.cjs:43 |
| Timers | Background timers are `unref()`ed; long loops pause between requests (SEC 0.4 s, Nasdaq 0.8 s) | main.cjs:415, 422, 425; us-calendar.cjs:27 |

### 4.4 Logging policy (what is never written)

- There is no log file: no file logger, crash reporter or log path was found in electron/. The app's log is the
  `events` table (newest 600) shown in the AI console.
- Worker stdout and stderr are discarded so raw broker data and errors never reach a console (kis-service.cjs:9-10);
  the updater's logger is off (app-updates.cjs:11).
- Keys never leave a worker: provider error messages are run through `redact`, which removes every loaded key by
  value (ai-client.cjs:231; ai-router.cjs:26; provider-error-reply.cjs:16-20); provider file values "are never
  logged" (ai-router.cjs:39).
- A failed KIS request's record holds the operation name, codes and timings: "No payload and no account data"
  (kis-service.cjs:24-26).
- Codes that cross a boundary are checked against patterns (`^[A-Z0-9_-]{1,24}$` broker code, HTTP status 100-599),
  and updater errors, which can contain URLs and paths, are mapped to five codes (app-updates.cjs:30-31).
- Console entries are shortened to 500 (title) and 32,000 (body) characters and a storage error never fails the
  review that wrote it (main.cjs:101-107).
- `console.log` in the main process appears only in the package check (main.cjs:207-208).
- The key Test logs one System line with the vendor and one of the fixed results (main.cjs:396-400; key-test.cjs).

### 4.5 docs/EXTERNAL-FACTS.md

A hand-kept table of every outside fact the app states to the user or the AI (market hours, fees, tax rates, product
rules): id, fact, value in the app, where it is used, source, date last checked (docs/EXTERNAL-FACTS.md:1-29), plus a
list of facts "stated but not checked yet" (lines 31-36). Its own rule: "Review this list before each release", and
when a fact changes, update the code, set a session's `to` date and update the row. Code refers to its ids
(`kr-hours.cjs` `source:'F-KRX-CSAT-2026'`; `market-sessions.cjs`), and two tests name it
(`tests/facts-fixes.test.cjs`, `tests/kr-shifted-day.test.cjs`); what those tests assert about the file: not
determined. The docs folder is shipped beside the app (package.json build.extraFiles; scripts/package.cjs:10).

## 5. Tests

| Command | What runs | Cite |
|---|---|---|
| `npm test` | `node --test` on a list of test files written by hand in package.json. On 2026-11-19 the list has 236 files and matches the 236 `*.test.cjs|mjs` files in tests/ (counted; 1.5.69 work). The last check report: 1,978 tests | package.json:10; 2026-11-19-pre-release-1569/check-report.md:12 |
| `npm run test:hours` | The files of that list that start a scout, run again with the clock started at six times: Korean hours, evening extended sessions, U.S. hours, no market open, weekend, and the 2026-11-19 late open. `helpers/shift-clock.cjs` shifts `Date` from `PORTFOLIO_FAKE_NOW` | tests/run-hours.cjs:1-19 |
| `npm run test:desktop` (= `test:ui`) | Build, then 19 cases, each a real Electron process on the compiled page with its own made-up profile; stops at the first failure; writes `artifacts/ui-tests/run-*/report.html`, logs and screenshots; 180 s per case | tests/run-desktop.cjs:5-28; package.json:14, 16 |
| `npm run package` | Build, then a portable folder `release/Financial-Portfolio-Manager-<time>/` (Electron's files, `electron/`, `dist/`, two `src` modules, the bridge script, README, docs) and `release/latest.json` | scripts/package.cjs:2-12 |
| `npm run test:package` | Starts the packaged exe with `--verify-build` on a fresh profile (20 s limit): the Home page loads, the page has no `require`, paper is paused, broker execution and auto trading are off, the provider worker starts. With `--profile <dir>`: the same on a copied profile, asserting the saved preference is kept, the session is paused after restart and no order row was added | scripts/verify-package.cjs:2-6; main.cjs:200-208 |
| `npm run validate` | Six stages in order, stopping at the first failure: types, build, unit (every test file on disk, not the hand list), ui, package, portable-startup; report in `artifacts/validation/latest.json` | scripts/validate.cjs:3-7 |
| `npm run dist` | Build and an NSIS installer without publishing | package.json:18 |
| CI | `.github/workflows/validate.yml` is described as running `npm run validate` on Windows; whether it runs remotely: not determined | docs/TESTING.md:32-34 |

**The desktop harness.** Each case script sets `PORTFOLIO_SMOKE_DATA` to a new data folder
(tests/run-desktop.cjs:3-4, 24), replaces `KisService.prototype.request` with fixture answers
(tests/kis-desktop.cjs:12; tests/activity-desktop.cjs:27) and then loads the real `electron/main.cjs`
(tests/kis-desktop.cjs:113). In that mode the app takes no single-instance lock, downloads nothing, uses a fake
login item, has updates off except against a local release server (`PORTFOLIO_UPDATE_TEST`,
tests/update-desktop.cjs:1-2) and accepts seeded history (`PORTFOLIO_PERFORMANCE_SEED`, `PORTFOLIO_MACRO_SEED`). The
windows are real and visible (`show:!verificationDirectory`, main.cjs:188) and show made-up data; the user's real
app can keep running beside them. How a case points `userData` at its folder: not determined (not in main.cjs;
inferred to be in each case script). Native file dialogs are stubbed (docs/TESTING.md:38).

**The mock KIS.** `tests/helpers/mock-kis.cjs` is a stateful stand-in answering the engines' broker interface
(`request(operation, payload)`) for a Korean and a U.S. account; the test decides fills and faults (a rejection with
a KIS code, a lost reply, the rate limit, a closed session, failing history reads) (lines 1-12).
`tests/mock-kis-contract.test.cjs` runs the real Korean and U.S. clients on fixture HTTP bodies and compares the
shape of every answer with the mock's (lines 1-7). `tests/helpers/app-harness.cjs` builds what main.cjs builds
around the two engines (funding ledger, costs, exposure, the `detectFlows` reading order), and
`tests/app-harness.test.cjs` checks that order against main.cjs's own source (lines 1-14).
`tests/helpers/scenario.cjs` injects a review's answers through the real AI client on a fake network (lines 1-4).
Its scenarios run under the app's own funding regime (`unknown`): a U.S. buy is counted against Korean won cash at
the rate plus 2%. Since the U.S. buy block was removed (1.5.69) there is no option to verify a separate U.S. pool,
so no scenario passes a U.S. buy by a regime the app never has. The harness gives the automation the U.S. quotes it
needs (`usQuotes`) and the conditional-entry path for U.S. symbols (`tests/us-auto-buy-flow.test.cjs`).
No test reads a credential file, places a real order or makes a paid AI request (docs/TESTING.md:22).

## 6. The release process, as the code and the practised checks show it

Steps 1-8 are the pre-release check as written in `artifacts/reviews/2026-11-18-pre-release/check.md` and reported
in the `check-report.md` files of 1.5.66, 1.5.68 and 1.5.69. Steps 9-14 are what `scripts/release.cjs` does.

1. **Fix the scope**: a named HEAD commit on top of the last released one; "no further change goes in". A fix found
   by a failing run is staged and reported before any commit (check.md:7-18).
2. **Unit checks**: `npm test`, `npm run test:hours`, `tsc --noEmit`, `npm run build`. A pass is every test green
   and a clean build (the chunk-size warning is usual) (check.md:22; 1568 report:7-10).
3. **Desktop suite**: the whole `npm run test:desktop` run, at a time that does not disturb trading; the user is
   told that windows with made-up data will open. Pass: every case; screenshots of the changed screens are named
   in the report for the reviewer to look at (check.md:3-5, 23-30; 1569 report:15-21).
4. **Instruction fingerprints**: the four fingerprints of the AI instructions (current and proposed, single and
   several orders) are compared with the last release; unchanged means no new Claude dry run is needed
   (1568 report:19-27; 1569 report:30-32; the rule is in part 3).
5. **External facts**: review docs/EXTERNAL-FACTS.md (its own rule, line 4). Whether the practised checks record
   this step: not determined (not in the reports read).
6. **Release notes**: a draft `release-notes-<version>.md` beside the report, in plain words, saying what changes
   in what the model is given and in the order path (check.md:31-34).
6b. **Privacy scan**: `npm run privacy:scan -- --notes <release-notes file>` (scripts/privacy-scan.cjs), with
   `PRIVACY_VALUES_FILE` naming a values file the reviewer writes from the live database and deletes afterwards.
   It checks every commit to be pushed (its message, and that author and committer are the GitHub no-reply
   address), every tracked file and the notes for key shapes, personal e-mail domains, dated account events, the
   owner's known values (a git-ignored list in `artifacts/`) and the live values in plain, comma-grouped and unit
   forms. Hits print locations only; a release is not pushed or published with a hit. The report records
   "privacy scan: 0 hits" (SPEC.md principle 9; tests/no-personal-data.test.cjs runs the general rules in
   `npm test`).
7. **Unverified list**: what cannot be proved before it runs for real (real KIS, a real model, the user's install)
   is listed (check.md:35-37; every report's last section).
8. **Report and approval**: counts, failures with output, screenshots and the notes go to the reviewer, who reports
   to the user. The check approves nothing else: "Version bump commit, tag, push, publish, install, closing or
   opening the user's app, any live-account or database write, a real AI call. Each needs the user's own words"
   (check.md:38-44).
9. **Version**: raise `version` in package.json by hand; `release.cjs` refuses a tag that is already published
   (scripts/release.cjs:8).
10. **`npm run release`**: build, then `scripts/release.cjs` (needs `gh auth login`): create a draft GitHub release
    `v<version>` on `main` if none exists (release.cjs:7-9).
11. Run `electron-builder --win --publish always` with the `gh` token: an NSIS x64 installer
    `release/installer/Financial-Portfolio-Manager-Setup-<version>.exe` and `latest.yml` are built and uploaded to
    the draft (release.cjs:10-11; package.json build).
12. **Verify**: `latest.yml` must name this version and its `sha512` must equal the SHA-512 of the built installer;
    otherwise the draft stays unpublished (release.cjs:12-14).
13. **Publish**: `gh release edit --draft=false --latest` (release.cjs:15). Installed apps then find it at their
    next check (4.1).
14. **Install** is the user's action in the app (Download, then Install when nothing is trading). The installer is
    not one-click, installs per user, lets the folder be chosen and keeps app data on uninstall (package.json
    build.nsis). After the restart auto trading is paused until Start is pressed (1.5).

Optional package checks available but not seen in the reports read: `npm run package` + `npm run test:package`
(fresh profile), and `node scripts/verify-package.cjs <exe> --profile <copied profile>` (section 5).

## 7. Not determined

- Permission-request handling for the page (no handler found; Electron's default applies, inferred).
- The fields of the KIS credential file (not opened; see `kis-client.cjs parseCredentials`).
- `benchmarkFor` mapping for the KRW and USD series; the exact meaning of `valuation.cjs` `STALE_MS` (15 min) and
  `MAX_DAYS` (7).
- Whether the Home value box reads `intraday_values`; which callers use `indicators.cjs`.
- How a valuation correction is approved by the user (no IPC channel found).
- Retention windows of `context_failures`, `review_gate_log`, `review_contexts`, `assessments` (pruning exists;
  the limits were not read). What `research_snapshots` and `settlement_k_groups` rows hold in detail.
- Realized P&L for U.S. trades in the Activity report (only Korean `profit` was seen).
- Installer code signing; whether the portable folder build carries the node modules the app requires
  (`@anthropic-ai/sdk`, `electron-updater`): `scripts/package.cjs` copies no `node_modules`.
- Whether CI runs remotely; what the two tests that name EXTERNAL-FACTS.md assert.
- How each desktop case redirects `userData`; the 2026-11-17 `check.md` was not read.
