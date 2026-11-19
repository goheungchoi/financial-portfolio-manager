# Part 1 — User interface

Written 2026-11-19 by reading the code (read-only; nothing was run). All paths are relative to the repository root. "main.cjs" means `electron/main.cjs`.

How to read this part:
- Every statement cites `file:line` or a file plus a searchable identifier. Many components are one very long line, so a line number is often given with a quoted string to search for.
- "(inferred)" marks a statement that was reasoned from the code rather than read directly. "not determined" marks a gap; all gaps are collected in section 6.
- **Line numbers in `electron/main.cjs`**: the working tree changed while this part was written (an uncommitted change by another session added two lines after line 272). Citations below line 272 are stable. Above it, a citation can be off by two lines between sections; search by the channel name (for example `'runtime:configure'`) to land on the handler.
- The per-screen sections were drafted by five reading passes and merged here. Each screen uses the same sub-headings: Purpose / Component files / What it shows / Controls / Calls and channels / Subscriptions / Saved state / Notes.

Contents:
1. The shell (window, sidebar, top bar, menu)
2. Screens, one by one
3. Settings table (every user-facing setting)
4. Cross-cutting conventions
5. First run, connections, updates, Start with Windows, alerts
6. Not determined

---

# 1. The shell

## 1.1 Windows and entry point

- **Main window**: `createWindow` (main.cjs:187-188). 1360×880, minimum 760×600, title "Financial Portfolio Manager", background `#f3f6fa` (light) or `#181818` (dark) from the saved theme. Preload `electron/preload.cjs`, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. New windows from page content are denied (`setWindowOpenHandler`, main.cjs:189) and in-page navigation is prevented (`will-navigate`, main.cjs:199).
- **Single instance**: a second launch quits and the first window is restored, shown and focused (main.cjs:2, main.cjs:8 `second-instance`).
- **Pop-out chart window**: 1040×780, minimum 560×480, title "<symbol> · Chart" (main.cjs:217). It loads the same bundle with the hash `#chart:<symbol>`; `src/main.tsx:155-156` then renders `<ChartWindow symbol=…/>` instead of `<App/>`. See "Pop-out chart window" in section 2.
- **First tab**: `AI console` when `location.hash === '#console'`, otherwise `Home` (`src/main.tsx:43`; `HOME`, `src/WorkspaceUX.tsx:5`). Where the `#console` hash is set: not determined (the only occurrence found is this read).
- **Stylesheets** loaded by the shell: `style.css`, `themes.css`, `polish.css` (`src/main.tsx:29-31`).
- **Browser preview** (no preload bridge, `window.portfolio` undefined): the theme is read from and written to `localStorage` key `theme` (`src/main.tsx:76-78`, `:119`); KIS actions answer "KIS connection is available in the desktop app." (`src/main.tsx:109`).
- **Startup failure**: if the database cannot be opened, a native error box "Startup failed" / "The local portfolio database could not be opened. The app will close without submitting any orders." and the app exits (main.cjs:862).
- **Quit**: closing all windows quits the app except on macOS (main.cjs:873). There is no tray icon: no `Tray` is created anywhere in `electron/main.cjs` (searched for `new Tray`, `setContextMenu`, `setToolTip`: no match).

## 1.2 Application menu

Defined once at main.cjs:858 (`Menu.setApplicationMenu`):

| Menu | Items |
|---|---|
| File | Quit (`role:'quit'`) |
| Edit | Electron's standard edit menu (`role:'editMenu'`: undo, redo, cut, copy, paste, select all) (items are Electron's; inferred) |
| View | Reset zoom, Zoom in, Zoom out, separator, Toggle full screen (`resetZoom`, `zoomIn`, `zoomOut`, `togglefullscreen`) |
| Window | Electron's standard window menu (`role:'windowMenu'`) |

There is no reload or developer-tools item in the menu.

## 1.3 Layout

`src/main.tsx:135` renders, in order: `TopBar`; an `<aside>` holding the sidebar `<nav aria-label="Workspace">`; and `<main>`, which holds `EmergencyBanner`, the active tab's components, one error notice (`role="alert"`, class `notice error`) and the `Toaster` (`src/main.tsx:152`).

## 1.4 Sidebar groups and tabs

Groups and tabs are `workspaceGroups` (`src/WorkspaceUX.tsx:4`). Short sidebar names are `navLabels` (`src/WorkspaceUX.tsx:7`); the full tab name shows in the breadcrumb. Each button's tooltip is `tabGuides[name].description` (`src/WorkspaceUX.tsx:9-27`, used at `src/main.tsx:135`). `tabGuides` also carries `next` and `target` fields per tab; no use of them was found in the shell (not determined whether any component reads them).

| Group | Tab (internal name) | Sidebar label | Description (`tabGuides`) | Mounted components (`src/main.tsx` line) |
|---|---|---|---|---|
| (brand button) | Home | "◈ Portfolio" | "What needs you, what the AI did, and where your money is." | `HomeMetrics`, `MarketStatus compact`, `HomeTrend`, `HomeCalendar`, `AttentionPanel`, `AiActivity`, `HomeHoldings` (135) |
| Portfolio | Holdings | Holdings | "Every position with its price, weight and unrealized gain." | `ExposurePanel`, `UnifiedPortfolio mode="holdings"` (137) |
| Portfolio | Charts | Charts | "Price history with candles, volume and a moving average." | `CompanyView` (138) |
| Portfolio | Performance | Performance | "Account value and returns against KOSPI and the S&P 500." | `AccountPerformance` (144), then `ActivityReport mode="profit"` (145) |
| Portfolio | Activity | Activity | "Broker order history: fills, cancellations and rejections." | `ActivityReport mode="orders"` (145) |
| Trade | KIS trading | Korea | "Korean orders through your KIS account, within your limits." | `LiveTrading` (149) |
| Trade | U.S. stocks | U.S. | "USD holdings and NASDAQ, NYSE and AMEX orders." | `LiveTrading market="US"` (147) |
| Trade | Paper trading | Paper | "A simulated account for practising trades." | `PaperTrading` (146) |
| AI | Journal | Journal | "AI decisions and the lessons you approve for future reviews." | `RuntimeSettings mode="journal"` (150) |
| AI | AI console | Console | "Each review as a conversation between the app and the AI." | `AiConsole` (151) |
| Research | Discover | Discover | "Find stocks and keep a watchlist the AI reviews." | `Discover` (139) |
| Research | News | News | "Headlines and DART disclosures for your stocks." | `RuntimeSettings mode="news"` (150) |
| Research | Macro | Macro | "Rates, inflation, FX and volatility the AI uses as background." | `MacroView` (140) |
| Settings | Connections | Connections | "Your KIS account and optional AI, news and alert keys." | `Connections` (142), then `AppUpdates` (143) |
| Settings | Engine settings | Engine | "How and when the AI reviews and trades." | `RuntimeSettings mode="settings"` (150) |
| Settings | Fees & taxes | Fees & taxes | "Commissions, sale fees and capital-gains tax estimates." | `TradingCosts`, `TaxLedger` (148) |
| Settings | Short & leverage | Short & leverage | "Leveraged and inverse ETFs, margin and short selling." | `ShortLeverage` (141) |

What mounts when:
- Only the active tab's components are mounted; leaving a tab unmounts them (each is rendered behind `tab === '…' &&`, `src/main.tsx:135-151`). Unsaved view state survives through `useDraftState` (section 4.3).
- The portfolio parts of Home, and all of Holdings and Charts, need `isKis` (`market?.source==='kis'`, `src/main.tsx:95`). Without it those three tabs show the empty state: "Connect your portfolio" / "Connect a KIS account to see holdings, company information and prices." with the buttons "Connect account" (opens Connections) and "Open paper trading". While a saved connection is restoring: "Connecting your portfolio…" / "Restoring your saved KIS connection." and only "Open paper trading" (`src/main.tsx:136`).
- Home's "Needs you" and AI activity row (`AttentionPanel`, `AiActivity`) shows with or without a KIS connection (`src/main.tsx:135`).
- `usePortfolio(tab===HOME)` polls the portfolio only while Home is the active tab (`src/main.tsx:57`).
- `LiveTrading` (both markets) and `ActivityReport` are keyed on `market.connectionId`, so they remount when the connection changes (`src/main.tsx:145,147,149`). Their draft keys are `kis:<connectionId>` and `us:<connectionId>`.
- `RuntimeSettings` is keyed on the tab name, so Journal, News and Engine settings never share an instance (`src/main.tsx:150`).
- A navigation request for the name `KIS account` is redirected to `Connections` (`src/main.tsx:59`).
- `RuntimePulse` (`src/WorkspaceUX.tsx:29`), an older status header with a four-step "journey" ("1 · Connect", "2 · Configure", "3 · Practice", "4 · Verify"), is defined but mounted nowhere (searched `<RuntimePulse` in `src/`: no match).
- `SavedConnections` (`src/SavedConnections.tsx`, "Automatic reconnection") is imported by `src/RuntimeSettings.tsx` but no `<SavedConnections` mount was found in `src/*.tsx`; its job is done by the rows in Connections (section 2, Connections).

Sidebar badges (`src/main.tsx:135`):
- Journal: `attention.counts.lessons`; tooltip "Optional learning feedback: nothing waits on it"; class `optional`.
- News: `attention.counts.news`; tooltip "Important disclosures today".
- Any other tab: `attention.counts.approvals[name]`; tooltip "Orders waiting for approval"; class `urgent`.
- The counts come from `useAttention()` (`src/Dashboard.tsx`), which calls `window.portfolio.getAttention` → channel `workspace:attention` (`electron/preload.cjs:18`; handler main.cjs `'workspace:attention'` → `attentionState()`). Details are under Home → AttentionPanel and under "Sidebar badges for Journal and News" in section 2.

## 1.5 Page history

`src/main.tsx:44-55`. Every page change calls `history.pushState({tab,symbol,index})`. Back and Forward work from the top-bar buttons, Alt+← / Alt+→, and mouse side buttons (button 3 = back, 4 = forward). Changing tab scrolls the window to the top (`src/main.tsx:70`). Opening a company from a holdings row is `show('Charts', symbol)` (`src/main.tsx:56`), so Back returns to the list.

## 1.6 Top bar (`src/Shell.tsx`)

`TopBar` (`src/Shell.tsx:42-59`) shows, left to right:

1. **Brand button** "◈ Portfolio" (aria-label "Home", title "Home"): goes to Home; marked active on Home (`src/Shell.tsx:46`).
2. **History buttons** "‹" (title "Back (Alt+←)") and "›" (title "Forward (Alt+→)"); each disabled when there is nowhere to go (`src/Shell.tsx:47`).
3. **Breadcrumb**: the group label, "›", and the tab name as the page `<h1>` with the tab description as its tooltip (`src/Shell.tsx:48`). Home has no group.
4. **Status chips** (`src/Shell.tsx:49-57`). A chip is a button with a coloured dot; clicking opens a small panel (`role="dialog"`) that closes on an outside click or Escape (`Chip`, `src/Shell.tsx:22-26`).

### Market feed chip (only when a KIS account is connected; `src/Shell.tsx:50-53`)

- **Label** (`feedLabel`, `src/Shell.tsx:12-14`), first match wins:

| Condition | Label | Tone (`feedTone`, :16) |
|---|---|---|
| no market state yet | "Connecting" | warning |
| `stream.status === 'reconnecting'` | "Reconnecting" | warning |
| `stream.status === 'unavailable'` (the KIS worker stopped) | "Unavailable" | warning |
| `market.status === 'error'` | "Request failed" | warning |
| status `stale` or any quote stale, and `marketsOpen === false` | "Closed" | muted |
| status `stale` or any quote stale, otherwise | "Stale" | warning |
| else | "Live" | success |

  The first quote's time (KST, HH:MM) follows the label. The comment at `src/Shell.tsx:7-11` records the rule: "Reconnecting" only when the stream is reconnecting; stream states `disconnected`, `idle`, `connecting`, `subscribing`, `streaming` are not faults because quotes also come by REST.
- **Panel**: "Market feed"; "WebSocket <status> · <n> symbols · REST fallback"; when Closed, "Markets closed; last quote HH:MM KST."; "Last trade HH:MM KST" (when `quote.timeBasis==='exchange'`) or "Last quote HH:MM KST"; "Account synced HH:MM KST"; and on an error the line from `failureLine` (`src/Shell.tsx:19-20`): "The last <quote poll | balance refresh | request> failed: <code> (KIS <brokerCode>) at HH:MM KST." Request names: `quotes` → "quote poll", `balance` → "balance refresh" (`src/Shell.tsx:17`). Without a failure record: "The last request failed (<error>)."
- **Data**: the `market` state held by `App`, from `getMarket` (channel `market:get`) and the `market:changed` broadcast (`src/main.tsx:86-94`). A state with a lower `revision` never replaces a higher one (`src/main.tsx:90`).

### Account chip (`src/Shell.tsx:54`)

- **Label** (`src/main.tsx:134`): "Paper · KRW" while the Paper trading tab is open; "KIS live" or "KIS mock" when connected (by `kis.snapshot.environment`); otherwise "Not connected".
- **Panel**: not connected → "No broker account connected." and the button "Connect" (opens Connections). Connected → the label in bold and the button "Connections".

### Engine chip: auto / manual (`EngineChip`, `src/Shell.tsx:27-41`)

- Hidden until the first runtime state arrives (`src/Shell.tsx:30`). State comes from `subscribeRuntime` (one shared 2-second poll of `getRuntime`, `src/runtimeFeed.ts`).
- **Label** (`src/Shell.tsx:33`), first match wins: "Emergency" (emergency active) → "Reviewing…" (`state.busy`) → "Review failed" (`state.lastError`) → "Auto · next HH:MM" (`launch.running`; the time is `state.nextReview`, omitted when there is none) → "Manual".
- **Tone** (`src/Shell.tsx:32`): danger (emergency or last error) → warning (`guardrails.trippedToday`) → accent (busy) → success (running) → muted.
- **Panel (the chip's menu)**: `state.scheduler.label` in bold; `state.scheduler.detail`; `state.execution.detail`; `state.lastErrorDetail` in red; a result note after an action.
- **Buttons** (`src/Shell.tsx:39`):
  - "Start auto trading" (primary) / "Stop auto trading" / "Cancel start" (while `launch.starting`) / "Starting…" (while the request runs). Disabled while a request runs, or while a review is busy and auto trading is neither running nor starting. Start calls `startAutoTrading(launch.token)` → `runtime:start` → `auto-launch.cjs start`; Stop and Cancel call `stopAutoTrading()` → `runtime:stop` → `auto-launch.cjs stop` (main.cjs `'runtime:start'`, `'runtime:stop'`). The token and the refusal and success messages are documented under Engine settings in section 2.
  - Result note: the reply's message or "Done."; on refusal the reply's error or "Could not start."; on an exception "Could not reach the engine." (`src/Shell.tsx:34`).
  - "Settings": opens Engine settings.
  - "Console": only with a last error; opens AI console.
- There is no typed confirmation for Start in the chip.

### Theme switch (`src/Shell.tsx:56`)

An icon button with `role="switch"`, aria-label "Dark mode"; "☾" in dark and "☀" in light; title "Switch to light" / "Switch to dark". `toggleTheme` (`src/main.tsx:115-122`) calls `setTheme` → channel `theme:set` (main.cjs `'theme:set'`) → `store.setTheme`, which saves the `settings` row with key `theme` (`electron/storage.cjs:14-15`) and broadcasts `theme:changed` to every window, so a pop-out chart follows at once. Failure text: "Could not save appearance settings."

## 1.7 Shell-level calls and channels

| `window.portfolio` method | Channel | Handler (main.cjs, search the channel) | Calls |
|---|---|---|---|
| `getTheme` / `setTheme` / `onTheme` | `theme:get` / `theme:set` / broadcast `theme:changed` | `'theme:get'`, `'theme:set'` | `store.getTheme`, `store.setTheme` (`electron/storage.cjs:14-15`) |
| `getMarket` / `onMarket` | `market:get` / broadcast `market:changed` | `'market:get'` | `marketState()`; broadcast by `broadcastMarket()` |
| `getKis` | `kis:get` | `'kis:get'` | returns `kisState` |
| `importKis` / `refreshKis` / `disconnectKis` | `kis:import` / `kis:refresh` / `kis:disconnect` | `'kis:import'` etc. | `connectKisFile`, `refreshKisBalance`, inline disconnect |
| `getEvents` / `onEvents` | `events:get` / broadcast `events:changed` | `'events:get'` | the `events` array (AI console) |
| `refreshPortfolio` | `portfolio:refresh` | `'portfolio:refresh'` | `refreshKisBalance`, `automation.refreshUS`, `portfolioState()` |
| `getRuntime` (through `subscribeRuntime`) | `runtime:get` | `'runtime:get'` | `runtimeState()` |
| `startAutoTrading` / `stopAutoTrading` | `runtime:start` / `runtime:stop` | `'runtime:start'`, `'runtime:stop'` | `auto-launch.cjs` `start` / `stop` |
| `getAttention` | `workspace:attention` | `'workspace:attention'` | `attentionState()` |

Every handler first calls `authorize(event)` (visible in each handler line, for example main.cjs `'theme:set'`).

`App` re-reads `getKis` every time `market.revision` changes (`src/main.tsx:101-106`).

## 1.8 Shell-level error texts (`src/main.tsx`)

All show in the single `role="alert"` notice (`src/main.tsx:135`): "Could not refresh portfolio." (58), "Could not load appearance settings." (82), "Could not load portfolio connection status." (92), "Could not load KIS connection status." (98), "KIS connection is available in the desktop app." (109), "KIS connection request failed." (112), "Could not save appearance settings." (121), "Could not load console events." (129).

## 1.9 Leftovers in the shell

`src/main.tsx:66-69` and `:132-133` keep `query`, `filter`, `scroll`, `end` and `shown`. `AiConsole` receives only `events` and does not use them (see AI console in section 2). `money` and `time` (`src/main.tsx:39-40`) are likewise unused in the shell's render (inferred from reading `App`).

---

# 2. Screens

Order: Home, Holdings, Charts, pop-out chart window, Performance, Activity, Korea and U.S. trading, Paper, Journal (with its shared loader), AI console, Discover, News, Macro, Connections (with App updates), Engine settings, Fees & taxes, Short & leverage.

## Home

- **Purpose**: The landing page. It shows the account value, cash, investment result, market sessions, an account-value chart, upcoming events, the "Needs you" list, AI activity and a compact holdings list with an allocation chart (src/main.tsx:135).
- **Component files**: mounted in `src/main.tsx:135` inside `<div className="home-page">` when `tab===HOME` (`HOME='Home'`, src/WorkspaceUX.ts:5). Order on the page (src/main.tsx:135): `EmergencyBanner` (above every tab, inside `<main>`), `HomeMetrics` (only if `isKis&&portfolio`), `MarketStatus compact` (if `isKis`), a row with `HomeTrend` and `HomeCalendar` (if `isKis`), a row with `AttentionPanel` and `AiActivity` (always), `HomeHoldings` (if `isKis&&portfolio`). `isKis` is `market?.source==='kis'` (src/main.tsx:95).
- **What it shows**: see the sub-components below. When KIS is not connected, Home (also Holdings and Charts) shows a section with heading "Connect your portfolio" (or "Connecting your portfolio…" while `kis.status==='connecting'`), text "Connect a KIS account to see holdings, company information and prices." (or "Restoring your saved KIS connection."), a primary button "Connect account" (hidden while connecting; goes to Connections) and a button "Open paper trading" (src/main.tsx:136). A page-level error shows as `role="alert"` text, e.g. "Could not refresh portfolio." (src/main.tsx:58, 135).
- **Controls**: see the sub-components.
- **Calls and channels**: see the sub-components.
- **Subscriptions**: `usePortfolio(tab===HOME)` polls `getPortfolio()` every 1000 ms only while the Home tab is active; overlapping requests are skipped (src/Home.tsx:18-22, src/main.tsx:57). `useAttention()` polls `getAttention()` every 5000 ms for the whole app life (src/Dashboard.tsx:11-15, src/main.tsx:42).
- **Saved state**: nothing is saved by the page itself; see sub-components.
- **Notes**: the page scrolls to the top on every tab change (src/main.tsx:70).

### EmergencyBanner

- **Purpose**: A banner shown on every page while an emergency (daily loss) review mode is active (src/Home.tsx:180-187).
- **Component files**: `EmergencyBanner` in `src/Home.tsx:181`; mounted at the top of `<main>` for every tab (src/main.tsx:135).
- **What it shows**: nothing unless `state.emergency.active` (src/Home.tsx:184). Then: bold "Paper emergency · loss-reduction reviews" or "KIS emergency · loss-reduction reviews" (by `e.scope==='paper'`), then "Daily loss ₩<loss> (<pct>%)" (the symbol is "$" when `e.currency==='USD'`), then an optional note: "Review done. See Journal." or "Review failed." (src/Home.tsx:184-186).
- **Controls**: button "Run emergency review" (label "Reviewing…" while busy); disabled while its own request runs or `state.busy`; calls `reviewRuntime()` (src/Home.tsx:186). No confirmation step.
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getRuntime()` (through `subscribeRuntime`) | `runtime:get` | main.cjs:722 | `runtimeState()` (main.cjs:722) |
| `reviewRuntime()` | `runtime:review` | main.cjs:731 | `automation.review()`; on failure the reply is `{ok:false,error:automation.lastError??'REVIEW_FAILED',message:...}` (main.cjs:731) |

- **Subscriptions**: `subscribeRuntime` (shared 2-second poll of `getRuntime`, src/runtimeFeed.ts:32-36; src/Home.tsx:183).
- **Saved state**: none (renderer-only `busy`/`note`, src/Home.tsx:182).
- **Notes**: none.

### HomeMetrics (Account value, Cash, Result tiles)

- **Purpose**: Three tiles: account value, cash and the investment result (src/Home.tsx:23-58).
- **Component files**: `HomeMetrics` (src/Home.tsx:24), internal `HomeResult` (src/Home.tsx:62), `LiveValue` and `TickDelta` (src/LiveValue.tsx:7,19), `SectionBoundary` (src/SectionBoundary.tsx:5), helpers `homeResult`, `resultSummary`, `periodNote` (src/home-result.mjs:17,28,49), `priceBasis`/`nextChange` (src/live-change.mjs:4,10), `pendingKRW` (src/pending.ts:4). Mounted in src/main.tsx:135.
- **What it shows**:
  - Tile 1 (aria-label "Combined equity", src/Home.tsx:46-52):
    - Title: "Korea only" (red, when the combined valuation does not cover both markets), "Estimated account value" (when the valuation is a material range), otherwise "Account value" (src/Home.tsx:36,46).
    - The value: the valuation's low bound (`state.valuation.combined.low`) when both markets are in scope, else the Korea total; with no valuation it is holdings + cash (+ pending U.S. settlement) computed in the renderer; "—" when unknown (src/Home.tsx:29-30,46). The value comes from `electron/valuation.cjs` per the code comment (src/Home.tsx:25).
    - The value is drawn by `LiveValue` in en-US KRW currency format; it flashes class `tick-up`/`tick-down` on a change, with tooltip "Change since previous update: …" or "Waiting for a changed value" (src/LiveValue.tsx:19-23; src/Home.tsx:13).
    - Foot line: `TickDelta` shows "No change yet" (tooltip "Shows the next change in this total as prices, fills or cash update") until the first change, then "Last change" with ▲/▼, the signed amount, a percent (or "<0.01%") and the time; tooltip "Last change at HH:MM:SS: … from prices, fills, fees or cash" (src/LiveValue.tsx:13-17). A change of price basis (a market loading, a holding switching price source) is not shown as a move (src/live-change.mjs:1-8; src/Home.tsx:42-44).
    - Next to it: "<Korea total compact KRW> · <U.S. total in USD>" (tooltip "Korea and U.S. account totals in their own currencies") or "U.S. not loaded" (src/Home.tsx:47).
    - If the range is material (spread ≥ 0.05% of the low value): a line "<low> – <high>" (aria-label "Value range") and one plain reason (src/Home.tsx:35,48-49). The four plain reasons: "Some U.S. trades are still being checked, …", "How some U.S. buys were paid is not known yet, …", "Some Korean balance figures were not reported, …", "Some figures are estimates, …", each ending "so the value is a range." or "so the value is an estimate." (src/Home.tsx:39-40).
    - If the value is an estimate: a "Details" disclosure with the plain reason (only when the range is immaterial), "Range <low> – <high>; the value shown is the low end." (when high > low) and the list of technical reasons (`v.reasons`) (src/Home.tsx:50).
    - If not both markets and a last complete record exists: "Last full value <KRW> at <date time>" (src/Home.tsx:51).
    - If `v.stale`: red "A balance is out of date" (src/Home.tsx:52).
  - Tile 2 "Cash" (src/Home.tsx:53-55): KRW cash plus USD cash at the rate (USD counted only when the U.S. account and a rate are loaded); "—" when both are null (src/Home.tsx:28,53). Foot: "<n>% of account value", or "Share of account value: not shown while the value is a range", or "Share of account value: not shown (cash is more than the account value)", or "—" (src/Home.tsx:55). Optional spans: "<KRW> for U.S. buys settling" with optional " (funding of <KRW> not yet known)" (tooltip "KRW committed to U.S. buys through integrated margin; KIS deducts it at settlement"); "incl. <USD>"; "<USD> pending settlement" (tooltip "Money from U.S. sales that has not settled yet: counted in total equity, spendable once it settles") (src/Home.tsx:55).
  - Tile 3 "Result" (src/Home.tsx:62-92), wrapped in `SectionBoundary label="Result"`; on a render error it shows "This section could not be shown." (src/Home.tsx:56; src/SectionBoundary.tsx:9).
    - Headline: the signed total gain in KRW ("—" when unknown), the time-weighted return in percent, and an optional tag "Return estimate", "Not verified" or "Provisional" (src/Home.tsx:73; src/home-result.mjs:67). Tooltip on the amount: "Investment P/L and time-weighted return: deposits, withdrawals and accounting corrections are not counted" (src/Home.tsx:73).
    - "since <day>, after deposits" (src/Home.tsx:74).
    - A reason line when the total is unknown or partly unavailable, e.g. "Starts after values are recorded on two days.", "The performance records could not be read.", "No result for the whole history yet.", "Not known for the whole history.", or the period note "Investment return unavailable: <reason> (<n> days affected)." (src/Home.tsx:65,75; src/home-result.mjs:19,51,62,66).
    - Line "Today": signed P/L of the latest recorded day, "Unavailable" or "—", the day's return in percent, and a "Provisional" tag (tooltip "A range or a settlement correction applies to this day; see More.") (src/Home.tsx:77).
    - Line "Unrealized": signed amount and percent; red "Korea only" when the U.S. is not loaded; reasons in the tooltip: "A holding has no average cost or price." or "The account value is not loaded yet." (src/Home.tsx:78; src/home-result.mjs:88).
    - Line "<KOSPI or S&P 500>": benchmark return "· you <your return>" (only when both exist) (src/Home.tsx:79; src/home-result.mjs:55,70).
    - "More" disclosure (src/Home.tsx:82-90): the tag's reason; "Total: account value now minus money paid in since <day>, as on the account value chart's "All"."; "Unrealized: holdings against their average cost, before selling fees and taxes" (+ "; Korea only until the U.S. account and an exchange rate load"); "Today is provisional: between <low> and <high>; the valuation range changed this day, so part of the change may be funding settling."; "Today includes a settlement correction of <amount>: bookkeeping, not investment P/L."; "U.S. unrealized: <USD> (<pct>), in dollars."; "Total and Unrealized come from different records and need not add up.".
- **Controls**: "Details" disclosure on tile 1 (src/Home.tsx:50); "More" disclosure on the Result tile (src/Home.tsx:82). No buttons.
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getPortfolio()` | `portfolio:get` | main.cjs:316 | `portfolioState()` (main.cjs:300): `combinePortfolio(kr, usSnapshot, automation.fx(), portfolioView.metadata(), {inFlight, funding})` plus `valuationSample`, `lastComplete` (from `performance.history`), `sessions`, `usError`, `brokerCode`, `httpStatus`, `warnings` |
| `getPerformance()` | `performance:get` | main.cjs:572 | `performanceAction(...)`: `recordValue()`, and `refreshBenchmarks()` if older than 6 h (main.cjs:572) |

- **Subscriptions**: the portfolio poll (1 s, parent); `HomeResult` polls `getPerformance()` every 60000 ms (src/Home.tsx:65).
- **Saved state**: none (renderer-only).
- **Notes**: KRW amounts on Home use en-US currency format (src/Home.tsx:13); percents under 1% show two decimals (src/Home.tsx:16-17). The cash share is hidden when it would mislead (src/Home.tsx:54-55). Total and Today come from `getPerformance().state.summaries` (`COMBINED` when it has points, else `KRW`) (src/home-result.mjs:28-31).

### MarketStatus (Markets strip)

- **Purpose**: Shows whether each market's regular session is open, the running extended session, the next open in Korean time and which sessions the app trades (src/MarketStatus.tsx:2-3).
- **Component files**: `MarketStatus` (src/MarketStatus.tsx:16); mounted on Home with `compact` (src/main.tsx:135). Props: `markets` (default both), `compact` (src/MarketStatus.tsx:16).
- **What it shows**: heading "Markets" and "Korean time · the app trades regular sessions" (src/MarketStatus.tsx:21). Per market ("Korea", "U.S.", src/MarketStatus.tsx:9): a dot and a headline: "Open · regular session until HH:MM KST" with sub-line "The app trades until HH:MM" (+ " (early close)") or "Past the app’s order cutoff"; or "Extended hours · opens … KST" / "Closed · opens … KST" (or "next: <label> <time>") with sub-line "Now: <session> (the app trades it), …" (+ ", not traded" when none is tradable by the app) or "Regular session closed" (src/MarketStatus.tsx:10-15). A disclosure "Sessions today" / "Sessions on <day>" (open by default unless `compact`) lists each session: "HH:MM–HH:MM", label (+ " (early close)") and a tag "App trades", "Not on mock", "Off" or "Not supported" (src/MarketStatus.tsx:26-29). Below: "Holidays: <source>, updated <time> · last refresh failed" for Korea, "Holidays: <source>" for the U.S. (src/MarketStatus.tsx:30). Renders nothing until the first reply (src/MarketStatus.tsx:19).
- **Controls**: the "Sessions …" disclosure per market (src/MarketStatus.tsx:26).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getMarketStatus()` | `market:status` | main.cjs:707 | `marketStatus` from `electron/market-sessions.cjs`, with `officialKrCalendar()` and `automation.closedDays` (main.cjs:707) |

- **Subscriptions**: polls every 60000 ms (src/MarketStatus.tsx:18).
- **Saved state**: none.
- **Notes**: times are formatted in `Asia/Seoul` (src/MarketStatus.tsx:7).

### HomeTrend (Account value chart)

- **Purpose**: Account value over a chosen period with the investment P/L, return, benchmark and a chart (src/Home.tsx:93).
- **Component files**: `HomeTrend` (src/Home.tsx:95), uses `ValueChart`, `shortDay` from `src/PerfCharts` (src/Home.tsx:10). Mounted in src/main.tsx:135 with `onOpen={()=>go('Performance')}`.
- **What it shows**: head "Account value" (src/Home.tsx:101,115). With fewer than two recorded points: "The chart starts after values are recorded on two days." or red "The performance records could not be read." (src/Home.tsx:101). Otherwise: the latest value in KRW; "Investment P/L <signed> (<pct>)" (same tooltip as the Result tile); an optional note from `periodNote` (red when a return is missing): "Investment return unavailable: …", "Return estimate: a deposit or withdrawal record could not be read.", "Return estimate: settlement not verified.", "Provisional: money changes awaiting you count as deposits or withdrawals." (src/Home.tsx:112,116; src/home-result.mjs:17-25); a small line "since <day>" or "over <period>" plus " · <KOSPI|S&P 500> <pct>" (src/Home.tsx:116). The chart (`ValueChart`, height 170) or "One recorded day in this period." (src/Home.tsx:117). Stats row: "Latest day" (amount, "Unavailable" or "—"; "Correction <amount>"; "Provisional: <low> to <high>" or the day's percent); "Period high" (value and day); "From return peak" ("Unavailable", "At peak" or "<n>%", plus "worst <n>%"); "Best / worst day" with "of <n> day(s) with a return" (src/Home.tsx:118-123).
- **Controls**: period buttons from "1W", "1M", "3M", "YTD", "1Y", "All"; only periods the history fully covers are shown, "All" always (src/Home.tsx:94,103,115). Link button "Performance →" opens the Performance tab (src/Home.tsx:101,115; src/main.tsx:135).
- **Calls and channels**: `getPerformance()` → `performance:get` → main.cjs:572 (see HomeMetrics table).
- **Subscriptions**: polls every 60000 ms (src/Home.tsx:97).
- **Saved state**: the selected period in the session draft key `home:trendPeriod`, default "1M" (src/Home.tsx:96). Drafts are in-memory only; a reload or exit discards them (src/useDraftState.ts:2-3).
- **Notes**: if the saved period is not available, "All" is used (src/Home.tsx:104).

### HomeCalendar (Coming up)

- **Purpose**: Known events in the next three weeks for the user's stocks and the market (src/Home.tsx:126).
- **Component files**: `HomeCalendar` (src/Home.tsx:146); mounted beside `HomeTrend` (src/main.tsx:135).
- **What it shows**: nothing when there are no events (src/Home.tsx:149). Otherwise the head "Coming up · next 3 weeks", then up to 10 items grouped by day; each day shows the date with "Today" or "Tomorrow" (Seoul date) (src/Home.tsx:150-153). Each item: a kind chip "Earnings", "Dividend", "Meeting", "Macro" or "Expiry" (src/Home.tsx:127,155), the label (company short name or the event title), tickers joined with " · ", and a sub-line: for earnings "After the U.S. close · <weekday> morning KST", "Before the U.S. open · <weekday> evening KST" or "Estimated date, not announced"; for dividends "Record date"; for macro/expiry "Korea" or "U.S." (src/Home.tsx:138-142,156). Share classes of one company on the same day are merged into one item (src/Home.tsx:132-139).
- **Controls**: none.
- **Calls and channels**: `getRuntime()` → `runtime:get` → main.cjs:722 → `runtimeState()`; the component reads `state.calendar` (src/Home.tsx:148).
- **Subscriptions**: its own poll every 60000 ms (src/Home.tsx:148).
- **Saved state**: none.
- **Notes**: none.

### AttentionPanel ("Needs you" list)

- **Purpose**: Lists what needs the user, each with one action button (src/Dashboard.tsx:27-33).
- **Component files**: `AttentionPanel`, `useAttention`, types `AttentionItem`, `Attention` (src/Dashboard.tsx:8-33). Mounted in src/main.tsx:135 with `onNavigate={go}`. The same `attention.counts` feed the sidebar badges (src/main.tsx:135 "nav-badge").
- **What it shows**: heading "Needs you" and a count pill with the number of items (src/Dashboard.tsx:29). "Checking…" before the first reply; "All clear" when the list is empty (src/Dashboard.tsx:30). Each row: an icon by tone ("●" action, "▲" warning, "○" info, src/Dashboard.tsx:26), the title, the action button, and "Dismiss" when `dismissible`. The item's `detail` is the row tooltip (src/Dashboard.tsx:31).
- **Controls**: the action button (primary style when tone is "action"). On click: if `item.run==='review'` it calls `reviewRuntime()` and does not navigate; else, if `item.view` is set and the tab is Journal, it sets draft `journal:view`; if `item.draft` is set it sets that draft; then it navigates to `item.tab` (src/Dashboard.tsx:31). "Dismiss" (aria-label "Dismiss: <title>") calls `dismissAttention(id)` (src/Dashboard.tsx:31). No confirmations.
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getAttention()` | `workspace:attention` | main.cjs:630 | `attentionState()` (main.cjs:602-629) |
| `dismissAttention(id)` | `workspace:dismiss` | main.cjs:635 | sets `restartNoticeDismissed=true` only when `id==='restart-notice'`; any other id changes nothing; returns `attentionState()` |
| `reviewRuntime()` | `runtime:review` | main.cjs:731 | `automation.review()` |

- **Subscriptions**: `useAttention` poll every 5000 ms (src/Dashboard.tsx:13). After "Dismiss" the reply is not applied to the list; the row goes at the next poll (src/Dashboard.tsx:31, the returned value is discarded).
- **Saved state**: `restartNoticeDismissed` is a main-process variable (main.cjs:7), not written to disk; it resets when the app restarts (inferred from the plain `let` at main.cjs:7).
- **Notes**: every item kind built by `attentionState()` (main.cjs:602-629), in the order they are added:

| # | id | Tone | Title (exact) | Detail (tooltip) | Created when | Button label → where |
|---|---|---|---|---|---|---|
| 1 | `cash-check-both` | info | "Korean cash up/down ₩N and U.S. cash up/down $N, seen <time> · checking; may be an exchange" (+ " · U.S. balance not compared yet", " · held 2 h: <reason>") | "The app is checking whether this is money moving between your Korean and U.S. accounts. Until then neither change is counted as a return." | the flow detector holds a Korean and a U.S. cash change with opposite signs (main.cjs:606; electron/cash-checks.cjs:17-19) | "Open Performance" → Performance |
| 2 | `cash-check-KR` / `cash-check-US` (open order) | info | "<Korean|U.S.> cash up/down <amount>, seen <time> · checking; an open order may explain it" | "An open order in this account could explain this change when its fill is counted. The app waits for the order before deciding." | a held cash change flagged `couldBeFill` (electron/cash-checks.cjs:22) | "Open Performance" → Performance |
| 3 | `cash-check-KR` / `cash-check-US` | info | "<Korean|U.S.> cash up/down <amount>, seen <time> · checking; not a return yet" (or "not a loss yet" for a decrease) + the same extras | "The app is checking whether a trade, a settlement or an exchange explains it. Until then it is not counted as a return. If it is your deposit or withdrawal, record it." | any other held cash change (electron/cash-checks.cjs:13,20-24) | "Record it" → Performance, with draft `performance:flow` = `{day, market, direction:'deposit'|'withdrawal', amount, note:''}` |
| 4 | `connect` | info | "Connect your KIS account" | "Holdings, prices and broker trading appear after you import your KIS credentials." | no KIS snapshot (main.cjs:607) | "Open Connections" → Connections |
| 5 | `approve-KIS trading` / `approve-U.S. stocks` | action | "N Korea order(s) waiting for your approval" / "N U.S. order(s) waiting for your approval" | up to three "<side> <qty> <symbol>" joined by " · ", then " · expires HH:MM:SS KST" | the live or U.S. engine has orders with `status==='Ready'` and not expired; also sets `counts.approvals[tab]` (main.cjs:608) | "Review orders" → KIS trading or U.S. stocks |
| 6 | `lessons` | info | "Optional: N learning note(s) to look at" | "Learning feedback from completed trades. Nothing is waiting on it: no order and no money depends on this." | `automation.memory.summary().pending>0`; sets `counts.lessons` (main.cjs:609) | "Open Journal" → Journal |
| 7 | `guardrail` | warning | "A guardrail stopped auto trading today" | "Check the guardrail event before starting again." | `automation.guardrails.state(config).trippedToday` (main.cjs:610) | "View guardrails" → Engine settings |
| 8 | `emergency` | warning | "Daily loss limit reached" | "Emergency loss-reduction reviews are active." | `automation.emergencyState().active` (main.cjs:611) | "Open engine" → Engine settings |
| 9 | `loss-unavailable` | warning | "Daily loss check unavailable: new buys restricted" | "<Korea / U.S. / Korea and U.S.>: the data the check needs could not be read. Sales and covers are not held back." | `emergency.unavailableMarkets` not empty (main.cjs:612) | "Open engine" → Engine settings |
| 10 | `loss-late` | warning | "Automatic new buys restricted for today" | "<markets>: today's opening value could not be read, so an earlier loss cannot be ruled out. The loss since the value was read is still checked. Sales and covers are not held back." | `emergency.lateMarkets` not empty (main.cjs:613) | "Open engine" → Engine settings |
| 11 | `review-backoff` | warning | "Automatic reviews paused after repeated failures" | "Until HH:MM KST. <last rule> Your own reviews still run; order tracking continues." | `automation.reviewBackoffState()` is set (main.cjs:614) | "See details" → AI console |
| 12 | `provider-wait-<vendor>` | warning | "<Name>: credit or spend limit used up" (kind `quota`) or "<Name>: automatic AI calls waiting" | "<summary> Your own reviews still run; stops and loss limits continue. Code <code>, request <id>." | one per entry of `automation.providerWaitState()` (main.cjs:616) | "See details" → AI console |
| 13 | `review-error` | warning | "The last AI review failed" | the error code in lower case with spaces | `automation.lastError` set and not busy (main.cjs:617) | "See details" → AI console |
| 14 | `credit-<first 30 chars of the warning>` | warning | "Margin or short position needs attention" | the warning text from `exposure.creditRisk(...)` (see Short & leverage, Notes) | one per credit-risk warning for the connected account (main.cjs:618) | "Open" → Short & leverage |
| 15 | `news` | info | "N important disclosure(s) about your stocks today" | the first two titles joined by " · " | news events with `importance==='high'`, with symbols, first seen in the last 24 h; sets `counts.news` (main.cjs:619) | "Read" → News |
| 16 | `stop-unreadable-<order id>` | warning | "Stop order for <symbol> cannot read its purchase" | "It stays armed and keeps trying; it sells nothing until the purchase can be read." | a desk conditional order with `linkedBuy` unreadable for more than 5 minutes (main.cjs:620) | "Orders and triggers" → Journal, view "Orders and triggers" |
| 17 | `claude-first-review` | action | "First review on Claude Opus 5.5 not run yet" | "Automatic reviews wait until it completes. Armed stops keep running." | `automation.claudeFirstReview()?.state==='pending'` and the trading model's vendor is Anthropic (main.cjs:622) | "Run first review" → runs `reviewRuntime()`; no navigation (`run:'review'`; the item's `tab` is 'Dashboard' but is not used, src/Dashboard.tsx:31) |
| 18 | `plan-stop-<id>` | warning | "No stop order for the purchase of <symbol>" | "<qty> <symbol>: <reason>" | one per `automation.desk.planStopFailures(scope)` (main.cjs:623) | "Orders and triggers" → Journal, view "Orders and triggers" |
| 19 | `plan-trail-<order id>` | warning | "Stop for <symbol> has no trailing" | "A fixed stop at <level> protects <qty> <symbol>; its plan gave a trail. " + "The trail is added when the purchase fills. " (while it waits for its purchase) + "Why: <reason>" | one per armed plan stop whose plan gave a trail it could not use (`automation.desk.plannedTrailsMissing(scope)`, main.cjs:625) | "Orders and triggers" → Journal, view "Orders and triggers" |
| 20 | `restart-notice` | warning | "Auto trading paused after a restart", "Paused: N stop order(s) not watched" or "Paused: stop orders not watched" (electron/start-notice.cjs:38) | the full message: how the app stopped, "The app started and auto trading is paused." + stop details + "Open the app and press Start auto trading." (electron/start-notice.cjs:36) | `restartNotice` was built at start (main.cjs:342), it is not dismissed, and auto trading is not running (main.cjs:626) | "Orders and triggers" → Journal, view "Orders and triggers"; has "Dismiss" (`dismissible:true`) |
| 21 | `update` | info | "Version <x> is ready to install" | "Install from Connections when no trading is active." | `updates.view().status==='downloaded'` (main.cjs:627) | "Install" → Connections |

  Each block is wrapped in try/catch, so a failing source drops its item silently (main.cjs:606-624). `counts` drive sidebar badges: `approvals` on "KIS trading" and "U.S. stocks" (title "Orders waiting for approval"), `lessons` on Journal ("Optional learning feedback: nothing waits on it"), `news` on News ("Important disclosures today") (src/main.tsx:135).

### AiActivity (AI activity card)

- **Purpose**: Shows the review scheduler status, the last three decisions, the last error, and offers Start/Stop auto trading, Run review and Dry run (src/Dashboard.tsx:56-90).
- **Component files**: `AiActivity` (src/Dashboard.tsx:56); helpers `notSentNote`, `batchNote`, `answerRuleText`, `refusalText`, `Measurement`, `Refusal`, `dryRunText` (src/Dashboard.tsx:19-55). Mounted in src/main.tsx:135 with `onNavigate={go}`.
- **What it shows**:
  - Heading "AI activity" and a small line "<status> · <provider>" (src/Dashboard.tsx:80). Status: "Reviewing…"; "Next review in M:SS" (under one hour, when the scheduler label is "Monitoring"); "Next review at <time>" or "Markets closed · next review at <time>"; otherwise the scheduler label or "Checking…" (src/Dashboard.tsx:70). Provider: "Claude" when the provider is `openai` and the model id starts with `claude-`; else "OpenAI", "Local rules", "External agent" or "—" (src/Dashboard.tsx:34,80).
  - A red automation status line (aria-label "Automation status") with the first blocker and " (+N more)"; the others are in the tooltip. Blockers: provider-wait summaries; "Daily loss limit reached: new buys are blocked."; "Daily loss check unavailable: new buys are restricted until it can be checked."; "Automatic reviews paused until HH:MM after repeated response-format failures. Your own reviews still run." (src/Dashboard.tsx:76,82).
  - Background AI line (aria-label "Background AI"), shown when any background job is enabled: "Background AI: <list>" or "Trading is stopped, but background AI still runs: <list>", plus " · paused for this session" (src/Dashboard.tsx:83).
  - The last three reviews: a tag (the action or the batch action), text (batch counts, "Buy withheld: incomplete plan", "No trade" or "<symbol> ×<qty>"), an optional "+N more"/"N orders" note, an optional "Not sent" / "Rejected by KIS" note (tooltip: the execution note), and the age ("just now", "N min ago", "N h ago" or a date) (src/Dashboard.tsx:19-25,84). The row tooltip is the decision's explanation (src/Dashboard.tsx:84). Empty state: "No decisions yet." (src/Dashboard.tsx:84).
  - Last error (aria-label "Last review error"): "Last review failed at HH:MM (N in a row): <detail> " followed by one of "Automatic AI calls wait until <time>.", "Automatic reviews are paused for now.", "The next scheduled review tries again.", "Auto trading is stopped, so nothing retries automatically."; a "Details" disclosure with the full detail, the back-off rule and provider-wait details, and a link "Console →" (src/Dashboard.tsx:78,85).
  - A transient note for 8 seconds: "Review finished.", "Review failed. See Console.", "Could not reach the engine.", the start/stop reply message, or "Could not start." (src/Dashboard.tsx:59,66-67).
  - "Dry run" disclosure: "Checks a review without acting on it: nothing is proposed, submitted or changed." (src/Dashboard.tsx:87). After "Dry-run review…": "Estimated cost: about $X (up to $Y), N–M AI requests, from <basis>." or "Estimated cost: unknown…"; for Claude with no estimate: "No Claude Opus 5.5 review or dry run has completed yet, so there is no cost estimate." / "No Claude Opus 5.5 review or dry run has run yet, so there is no cost estimate."; then "Today: N of M calls, $X of $Y. <note>" (src/Dashboard.tsx:87). With Claude selected: "This sends your holdings and values to Anthropic." and "The first request reserves about $X (from <basis>); up to N requests can reserve up to $Y." plus, when blocked, " Your Anthropic spending limit is $Z, below the first request: raise it in Connections before running." (src/Dashboard.tsx:87). Result line: "Holdings: … · open orders: N (unconfirmed) · conditional orders: N (inactive while paused)|off · return since start: …." and for a review " Would decide: <action> <qty> <symbol> (N AI requests, $X); nothing was applied." (src/Dashboard.tsx:53-55), or "Dry run failed (<code>)." (src/Dashboard.tsx:65). A refused request shows "Anthropic refused the request (<status> <type>): <message> $0.00, refused: the reservation was released." or "The request was refused, and the answer was not an Anthropic error (…)", with "Request id <id> · <content type>" (src/Dashboard.tsx:51-52). An unaccepted answer shows "Claude’s answer was not accepted: <rule> (stop: <reason>)." or "The answer was not accepted: …" (src/Dashboard.tsx:50,87). A "Measured: N request(s) · $X (reserved $Y) · cache read N, write N tokens" disclosure (open) with table columns "#", "Kind", "Model", "Stop", "In / out", "Cache read / write", "Tier", "Cost", "Request" (src/Dashboard.tsx:41-43). An "Assembled inputs · <time>" disclosure with the summary as JSON (src/Dashboard.tsx:87).
- **Controls**:
  - "Start auto trading" (primary) / "Stop auto trading" / "Cancel start" / "Starting…": shown only when `state.launch` exists; tooltip `launch.label`; disabled while busy, or while a review runs when not running and not starting. Start passes `launch.token`. No typed confirmation in this component (src/Dashboard.tsx:67,81).
  - "Run review" ("Reviewing…" while `state.busy`): disabled while busy (src/Dashboard.tsx:66,81).
  - "Pause background AI" / "Resume background AI" link (src/Dashboard.tsx:79,83).
  - "Details" disclosure and "Console →" (opens AI console) on the error (src/Dashboard.tsx:85).
  - "Dry run" disclosure: "Check inputs" (runs `dryRun('inputs')`), "Dry-run review…" (asks for an estimate first), then "Run dry-run review" (primary; disabled while busy or when the Claude reservation is blocked) and "Cancel" (src/Dashboard.tsx:87).
  - Select "Run on" (aria-label "Dry-run model"), shown only when `state.providerStatus.anthropicConnected`: "Current model (<model id>)" or "Claude Opus 5.5 · medium effort"; changing it asks for a new estimate (src/Dashboard.tsx:87).
  - "All decisions →" opens Journal (src/Dashboard.tsx:88).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getRuntime()` via `subscribeRuntime` | `runtime:get` | main.cjs:722 | `runtimeState()` |
| `startAutoTrading(token)` | `runtime:start` | main.cjs:720 | `require('./auto-launch.cjs').start(automation,token)` |
| `stopAutoTrading()` | `runtime:stop` | main.cjs:721 | `require('./auto-launch.cjs').stop(automation)` |
| `reviewRuntime()` | `runtime:review` | main.cjs:731 | `automation.review()` |
| `setBackgroundAi(paused)` | `runtime:background-ai` | main.cjs:730 | `automation.setBackgroundPaused(paused)` |
| `dryRunEstimate(model)` | `runtime:dry-run-estimate` | main.cjs:728 | `automation.dryRunEstimate({model})`; only `'claude-opus-5-5'` is passed through, else null (also filtered in electron/preload.cjs:30) |
| `dryRun(mode, options)` | `runtime:dry-run` | main.cjs:729 | `automation.dryRun(mode,{model})`; on failure `{ok:false,error:<CODE or 'DRY_RUN_FAILED'>,failure:automation.dryRunFailure(started)}` |

- **Subscriptions**: `subscribeRuntime` (2-second shared poll); a 3-second timer that only refreshes the countdown clock (src/Dashboard.tsx:58).
- **Saved state**: none in the renderer (`dryModel`, `estimate`, notes are component state, src/Dashboard.tsx:57-63). "Pause background AI" is described on screen as "paused for this session" (src/Dashboard.tsx:83); where the engine keeps it: not determined.
- **Notes**: the dry run on Claude sends `{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}` (src/Dashboard.tsx:65).

### HomeHoldings (Holdings list and Allocation)

- **Purpose**: Every position, largest first, one line each, plus an allocation chart; the full table is on Holdings (src/Home.tsx:161-162).
- **Component files**: `HomeHoldings` (src/Home.tsx:163), `AllocationChart` (src/AllocationChart.tsx:5). Mounted in src/main.tsx:135.
- **What it shows**: section "Holdings": per row the company name (a link), the price in its own currency, the gain or loss against average cost in percent ("—" when cost is unknown or the move is under 0.005%; tooltip "Gain or loss against your average cost"), and the share of total equity in whole percent (tooltip "Share of total equity") (src/Home.tsx:172-175). Empty state: "No positions yet." (src/Home.tsx:175). Section "Allocation": the `AllocationChart` with one bucket per group plus "Cash" (colour `#7e858c`), or "Waiting for balances." (src/Home.tsx:171,177). For `AllocationChart` details see Holdings below.
- **Controls**: "Refresh" link ("Refreshing…" and disabled while busy) calls `refreshPortfolio()` (src/Home.tsx:174; src/main.tsx:58). "All <n> →" opens Holdings (src/Home.tsx:174; src/main.tsx:135). A company name opens Charts for that symbol (src/Home.tsx:175; src/main.tsx:56). Select "Allocation grouping": "Company", "Sector", "Region", "Market", "Currency" (src/Home.tsx:177). The chart's own controls: see `AllocationChart`.
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `refreshPortfolio()` | `portfolio:refresh` | main.cjs:318 | `refreshKisBalance()`, then `automation.refreshUS()` if connected (a failure sets `usLive.refreshError` through `publicUSCode`), returns `portfolioState()` |

- **Subscriptions**: the parent's 1-second portfolio poll (src/main.tsx:57).
- **Saved state**: the grouping in session draft key `portfolio:group` (default "Company"), shared with the Holdings tab (src/Home.tsx:167; src/UnifiedPortfolio.tsx:18). In-memory only (src/useDraftState.ts:2).
- **Notes**: equity here is computed in the renderer as holdings + cash + pending U.S. settlement (src/Home.tsx:164-165), not the valuation used by the Account value tile.

## Holdings

- **Purpose**: The full holdings view: portfolio risk exposure, the holdings table with editable classifications, and per-holding movement cards (src/main.tsx:137).
- **Component files**: `ExposurePanel` (src/Exposure.tsx:6), then `UnifiedPortfolio mode="holdings"` (src/UnifiedPortfolio.tsx:16), which ends with `HoldingMovement` inside `SectionBoundary label="Movement"` (src/UnifiedPortfolio.tsx:35). Both are mounted at src/main.tsx:137, only when `isKis`. When not connected the "Connect your portfolio" section shows instead (src/main.tsx:136).
- **What it shows / Controls / Calls**: see the sub-components.
- **Subscriptions**: see the sub-components.
- **Saved state**: see the sub-components.
- **Notes**: `UnifiedPortfolio` also has an `overview` mode (three equity tiles with `PortfolioProfit`, `LiveValue`, `TickDelta`, and a "Portfolio allocation" section with `AllocationChart`) (src/UnifiedPortfolio.tsx:34). In the mounts I read, only `mode="holdings"` is used (src/main.tsx:137); whether the overview mode is mounted anywhere else: not determined. In holdings mode the allocation chart and `PortfolioProfit` are not drawn on this tab (src/UnifiedPortfolio.tsx:34 `mode==='overview'&&`).

### ExposurePanel (Exposure)

- **Purpose**: Where the portfolio's risk sits: sectors, concentration, beta and holdings that move together; the code comment says the agents read the same view (src/Exposure.tsx:4).
- **Component files**: `ExposurePanel`, type `ExposureState` (src/Exposure.tsx:5-6); mounted at src/main.tsx:137.
- **What it shows**: nothing when there is no exposure or no holdings (src/Exposure.tsx:9). Heading "Exposure" with "Shares of total equity, including cash" (src/Exposure.tsx:12). Six figures: "Invested" (n%), "Cash" (n%), "Largest holding" ("<name> n%" or "—"), "Top 3" (n%), "Effective holdings" (number or "—"), "Portfolio beta" (number or "Needs history") (src/Exposure.tsx:13). "By sector": one bar per sector with its percent (src/Exposure.tsx:14). A warning line "Move together: <A + B> (n% combined) · …" (src/Exposure.tsx:15). A note "How this is measured": "Effective holdings is how many equal-sized positions the portfolio behaves like (1 ÷ sum of squared weights). Beta is weighted over holdings with price history; it measures sensitivity to KOSPI or the S&P 500. Holdings that move together have daily-return correlation of 0.7 or more over about 60 days, so they act like one bet." (src/Exposure.tsx:16).
- **Controls**: the "How this is measured" disclosure (src/Exposure.tsx:16; src/Note.tsx:3-5).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getRuntime()` | `runtime:get` | main.cjs:722 | `runtimeState()`; the panel reads its `exposure` field (src/Exposure.tsx:8). The field `movesTogether` is produced in `electron/portfolio-risk.cjs` (file found by search; the function that fills `state.exposure` was not read: not determined) |

- **Subscriptions**: its own poll every 30000 ms (src/Exposure.tsx:8).
- **Saved state**: none.
- **Notes**: this panel does NOT use the `exposure:get` channel. `exposure:get` (main.cjs:323) serves the Short & leverage tab (src/ShortLeverage.tsx:58).

### UnifiedPortfolio (Portfolio header and Holdings table)

- **Purpose**: The combined Korea and U.S. holdings table with a market filter, refresh, and sector/region classification editing (src/UnifiedPortfolio.tsx:16-35).
- **Component files**: `UnifiedPortfolio`, types `PortfolioRow`, `Valuation`, `PortfolioState` (src/UnifiedPortfolio.tsx:11-16). Uses `usErrorMessage` from `src/usErrors` (src/UnifiedPortfolio.tsx:8), `toast` from `src/Toast` (src/UnifiedPortfolio.tsx:2).
- **What it shows**:
  - Before the first reply: "Loading portfolio…" (src/UnifiedPortfolio.tsx:22).
  - Section "Portfolio · Korea & U.S." with a summary line: "Korea trading Active|Off", "U.S. trading Active|Off" (tooltip "Whether trading is activated for this account (see Korea / U.S.), not exchange hours"), and "USD/KRW <rate> · <source>" (src/UnifiedPortfolio.tsx:33). An error line (`role="status"`): "Could not read portfolio.", "Could not refresh portfolio." or the U.S. error text from `usErrorMessage`, with " · HTTP <status>" and " · Broker <code>" (src/UnifiedPortfolio.tsx:20-21,33). "Some U.S. prices may be stale." when there are warnings; "Refresh to load both accounts." when not loaded (src/UnifiedPortfolio.tsx:33).
  - Section "Holdings" with "KRW cash <amount> · USD cash <amount>" (src/UnifiedPortfolio.tsx:35). Table columns: "Company", "Shares", "Price", "Market value", "Value (KRW)", "Unrealized P&L" (src/UnifiedPortfolio.tsx:35). The Company cell shows the name (a link), "<symbol> · <sector>", the region, and an "Edit" button. P&L is `(price − cost) × quantity` in the holding's currency, green when price ≥ cost (src/UnifiedPortfolio.tsx:35). Empty state: "No holdings available for this market." (src/UnifiedPortfolio.tsx:35).
  - A disclosure "Valuation and classifications": "P/L is unrealized price gain/loss before selling fees and taxes; the percentage excludes cash. Combined values use the displayed indicative exchange rate. Unrealized KRW conversion is not a historical FX gain calculation. Unclassified sectors are not guessed. Region defaults describe listing location; edit exposure labels for foreign-sector funds or other classifications. Data coverage currently includes supported Korean and U.S. cash equities." (src/UnifiedPortfolio.tsx:35).
- **Controls**:
  - Select "Portfolio market filter": "All markets", "Korea", "U.S." (src/UnifiedPortfolio.tsx:33).
  - Button "Refresh portfolio" ("Refreshing…", disabled while busy) (src/UnifiedPortfolio.tsx:21,33).
  - Company name button (aria-label "View <name> charts") opens Charts for the symbol (src/UnifiedPortfolio.tsx:35; src/main.tsx:56).
  - "Edit" (aria-label "Edit classification for <name>") opens an editor under the table: heading = the symbol; inputs "Sector" (max 100 characters, placeholder "Unclassified") and "Region / exposure label" (max 100, placeholder "Your exposure classification"); buttons "Save classification" (primary, disabled while busy) and "Cancel" (src/UnifiedPortfolio.tsx:35). On save: toast "Classification saved"; on failure the message "Could not save classification." and toast "Not saved: could not save classification" (src/UnifiedPortfolio.tsx:35). No confirmation step.
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getPortfolio()` | `portfolio:get` | main.cjs:316 | `portfolioState()` (main.cjs:300) → `combinePortfolio` (electron/portfolio-view.cjs:4) |
| `refreshPortfolio()` | `portfolio:refresh` | main.cjs:318 | `refreshKisBalance()`, `automation.refreshUS()`, then `portfolioState()` |
| `setInstrumentMetadata(symbol,{sector,region})` | `portfolio:metadata` | main.cjs:317 | `portfolioView.save(symbol,value)` (electron/portfolio-view.cjs:24), then `portfolioState()` |

- **Subscriptions**: polls `getPortfolio()` every 1000 ms; overlapping requests are skipped (src/UnifiedPortfolio.tsx:20).
- **Saved state**: classification is saved in SQLite table `instrument_metadata` (symbol → `{sector, region}`), trimmed (electron/portfolio-view.cjs:22-24). Session drafts (in-memory, src/useDraftState.ts:2): `portfolio:market` (default "all"), `portfolio:group` (default "Company"), `portfolio:metadata:symbol`, `portfolio:metadata:sector`, `portfolio:metadata:region` (src/UnifiedPortfolio.tsx:18-19).
- **Notes**: `portfolioView.save` throws `INVALID_METADATA` unless the symbol is a six-digit code or `NASD|NYSE|AMEX:TICKER`, the value has exactly the keys `region` and `sector`, and each text is at most 100 characters with no control characters (electron/portfolio-view.cjs:24). The handler does not catch it, so the renderer shows the failure message (main.cjs:317; src/UnifiedPortfolio.tsx:35). Defaults when no classification is saved: sector "Unclassified"; region "South Korea (listing)" or "United States (listing)" (electron/portfolio-view.cjs:6). Row colours cycle through six fixed colours (electron/portfolio-view.cjs:1,6). The holdings table is inside a scroll region (`holdings-table-scroll`, `tabIndex=0`, aria-label "Holdings table") (src/UnifiedPortfolio.tsx:35). The U.S. error code-to-text table is in `src/usErrors` (not read here).

### AllocationChart

- **Purpose**: An allocation donut or ranked bars with a legend list (src/AllocationChart.tsx:5-10).
- **Component files**: `AllocationChart` (src/AllocationChart.tsx:5). Used by `HomeHoldings` (src/Home.tsx:177) and by `UnifiedPortfolio` in overview mode (src/UnifiedPortfolio.tsx:34).
- **What it shows**: a donut (aria-label "Portfolio allocation donut") whose centre reads "Total equity" (or "Invested assets" when cash is excluded), the total, and "<n> allocation groups"; with a group selected it reads the group label, its percent and value (src/AllocationChart.tsx:9). A tooltip for the selected group: label, "<pct>% · <value>", "Share of total portfolio" or "Share of invested assets", up to five member holdings and "+N more holdings" (src/AllocationChart.tsx:10). A legend list: one button per group with a colour dot, label, percent, a bar and the value (src/AllocationChart.tsx:10). Footer: "Weights include available cash." or "Cash excluded; percentages are relative to invested assets." followed by "Select a group to inspect its value."; then "Largest group <label> · <pct>%" and "Cash buffer <pct>% of equity" (src/AllocationChart.tsx:10). Empty state: "No positive allocations available." (src/AllocationChart.tsx:8).
- **Controls**: chart style buttons "Donut" / "Ranked bars"; checkbox "Include cash"; select "Sort allocation": "Largest first" / "Alphabetical" (src/AllocationChart.tsx:8). Hover, focus or click on a ring segment or a legend row selects a group; Escape clears it (src/AllocationChart.tsx:9-10).
- **Calls and channels**: none (props only).
- **Subscriptions**: none.
- **Saved state**: session drafts `src/AllocationChart.tsx:mode` (default "ring"), `src/AllocationChart.tsx:cash` (default true), `src/AllocationChart.tsx:sort` (default "value") (src/AllocationChart.tsx:6). In-memory only (src/useDraftState.ts:2).
- **Notes**: only groups with a positive value are drawn; percents are re-based on the included groups (src/AllocationChart.tsx:7). Values use ko-KR KRW format (src/AllocationChart.tsx:4).

### HoldingMovement (Movement)

- **Purpose**: One card per open holding, largest first, with a price line and a P/L line for a chosen period (src/HoldingMovement.tsx:1-3).
- **Component files**: `HoldingMovement` (src/HoldingMovement.tsx:54), internal `Line`, `MovementMore` (src/HoldingMovement.tsx:20,35); figures from `src/holding-movement.mjs` (`movementCards`, `recordedDays`, `seoulDay`, `PERIODS`; src/HoldingMovement.tsx:7). Mounted by `UnifiedPortfolio` in holdings mode with the filtered rows and the gross equity (src/UnifiedPortfolio.tsx:35).
- **What it shows**: heading "Movement" (src/HoldingMovement.tsx:75). States: "Loading the daily records…"; "Connect your KIS account to see how your holdings moved."; "No open holdings for this market." (src/HoldingMovement.tsx:77). A warning "Daily records could not be read." with "Retry" (src/HoldingMovement.tsx:76). Each card (aria-label "Movement <name>"): the company name (a link), "<n> share(s) · <p>% of equity" (src/HoldingMovement.tsx:84). Row "Price": the end price, the change "<pct> in <period>" / "since purchase" / "since first recorded <day>", a line chart with a purchase marker, and the first and last day (src/HoldingMovement.tsx:80-89); or a reason: "Loading prices…", "Daily prices are not loaded yet.", "Not enough daily prices for this period.", "Prices could not be read: KIS asked the app to slow down.", "Prices could not be read: KIS is not connected.", "Prices could not be read (<code>)." (src/HoldingMovement.tsx:17,70,86; src/holding-movement.mjs:77,85). Row "P/L": the end P/L, "<pct> since buy" / "since first recorded <day>", a line with a zero line, the first and last day, and "P/L from <day>, the first recorded day"; or a reason: "No recorded day in this period." or "P/L history unavailable: the daily records could not be read." (src/HoldingMovement.tsx:73,90-95; src/holding-movement.mjs:104). "More" disclosure per card: "Prices: KIS daily closes, read <time KST> (could not be refreshed; the last read is shown). The price line ends on the live price from the holdings table."; "P/L: the app's daily records, value minus average cost at each day's last reading. The line ends on today's last recorded reading, so its end can differ from the live price."; "U.S. prices are dated by the New York day; P/L by the Seoul day."; "Bought <day> (the app's order)."; "The purchase is not in the app's orders: P/L starts at the first recorded day, <day>."; "The daily records start <day>, after the purchase."; "<n> recorded day(s) could not be read and is/are left out."; then two tables: "Daily prices" (columns "Day", "Close"; the live row is marked " (live)") and "Daily P/L" (columns "Day", "P/L", "%"; a missing day reads "Not recorded") (src/HoldingMovement.tsx:37-51). On a render error the section reads "This section could not be shown." (src/SectionBoundary.tsx:9).
- **Controls**: period tabs "1W", "1M", "3M", "Since purchase" (src/holding-movement.mjs:6; src/HoldingMovement.tsx:75). "Retry" for the daily records (src/HoldingMovement.tsx:76). "Retry" per card when prices failed; it calls `getMovementCloses(symbol,true)` (src/HoldingMovement.tsx:66,86). Company name opens Charts (src/HoldingMovement.tsx:84). "More" disclosure (src/HoldingMovement.tsx:37).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getMovementRecords()` | `movement:records` | main.cjs:577-581 | `require('./movement-records.cjs').movementRecords({read, orders})`: reads `nav_history` for the account for the last 200 days and `automation.engineOrders()`; returns `{connected:false}` without an account |
| `getMovementCloses(symbol, refresh)` | `movement:closes` | main.cjs:582-587 | validates the symbol (`INVALID_REQUEST`), requires the symbol to be held (`NOT_HELD`), returns `research.cached(symbol,'daily')` when younger than 6 h and not a refresh, else `research.source(symbol,'daily',refresh)`; on failure returns the cached value with `stale:true` or `{error}` |

- **Subscriptions**: none. Records are read once on mount; prices are read once per symbol per session, one symbol after another, never polled (src/HoldingMovement.tsx:3,60-65).
- **Saved state**: session draft `portfolio:movementPeriod` (default "1M") (src/HoldingMovement.tsx:55). A module-level `closesCache` keeps prices for the session (src/HoldingMovement.tsx:12). The main process writes only the research cache (comment at main.cjs:574-576).
- **Notes**: error codes handled in text: `RATE_LIMITED`, `KIS_NOT_CONNECTED`/`NOT_CONNECTED`, any other code in brackets; `REQUEST_FAILED` and `UNAVAILABLE` are the renderer's own fallbacks (src/HoldingMovement.tsx:17,59,64).

### PortfolioProfit

- **Purpose**: A small "Unrealized P/L" figure for a set of rows (src/PortfolioProfit.tsx:3-9).
- **Component files**: `PortfolioProfit` (src/PortfolioProfit.tsx:3); logic in `portfolioProfit` (src/portfolio-profit.mjs). Used only in `UnifiedPortfolio` overview mode (src/UnifiedPortfolio.tsx:34).
- **What it shows**: label "Unrealized P/L", the signed amount ("—" when unknown) and a signed percent with two decimals; tone class `gain`/`loss`/`neutral`; tooltip "Unrealized price gain/loss against holding acquisition cost, before selling fees and taxes. Percentage uses invested cost, excluding cash. Combined KRW uses current indicative FX; historical currency gains are not included." (src/PortfolioProfit.tsx:9).
- **Controls**: none.
- **Calls and channels**: none.
- **Subscriptions**: none.
- **Saved state**: none.
- **Notes**: the result is unknown (null) when not loaded, or when any row with a non-zero quantity has no positive cost or a negative or missing price (src/portfolio-profit.mjs, function `portfolioProfit`).

## Charts tab

- **Purpose**: Shows one company (Korean six-digit code or U.S. `EXCHANGE:TICKER`): live price, valuation tiles, a candle/line chart, a technical summary, research tabs and an offline "paper replay" test (src/CompanyView.tsx:73).
- **Component files**: `src/CompanyView.tsx` exports `CompanyView` (src/CompanyView.tsx:8). Mounted at src/main.tsx:138 as `<CompanyView initialSymbol={chartSymbol}/>`, only when `tab==='Charts' && isKis`. Other screens open it through `openCompany(symbol)` = `show('Charts',symbol)` (src/main.tsx:56). When KIS is not connected the Charts tab shows the shared empty section "Connect your portfolio" / "Connecting your portfolio…" with buttons "Connect account" and "Open paper trading" (src/main.tsx:136). Children, in order (Charts tab): header + price + About + stat tiles, `CandleChart`, `TechnicalSummary`, `ResearchPanel`, `PaperReplay` (src/CompanyView.tsx:73).

### CompanyView (header, price, About, tiles)

- **Purpose**: Symbol search, title, live quote, ranges, "About" text and valuation tiles (src/CompanyView.tsx:42-57).
- **Component files**: src/CompanyView.tsx:8 `CompanyView`; props `initialSymbol`, `standalone`, `autoRefreshMs`, `onSymbolChange`.
- **What it shows**:
  - Title: company name as `<h2>`; name falls back profile name → portfolio row name → overview name → the symbol (src/CompanyView.tsx:33, :43). Under it a code chip with the symbol, the sector name if known, and the instrument type in upper case when it is not `stock` (src/CompanyView.tsx:43).
  - Market badge: "U.S. · USD" or "KOREA · KRW" (src/CompanyView.tsx:43). A symbol containing ":" is treated as U.S. (src/CompanyView.tsx:37).
  - Quote: last price in bold; change line with "▲"/"▼", signed amount and "(±x.xx%)"; tone class `positive`/`negative`, none when |change| < 0.005% (src/CompanyView.tsx:38-39, :46). Change comes from the live tick against the previous daily close, else research overview `changePct`, else KIS price against the previous daily close (src/CompanyView.tsx:38).
  - Time note: with a live tick, a dot and "Live · HH:MM:SS", or "Live · KIS daytime session · HH:MM:SS" when the tick session is `us-daytime`; otherwise "as of HH:MM" from `company.retrievedAt` (src/CompanyView.tsx:46).
  - Range bars "Day" and "52 weeks": low, a track with a marker, high; hidden when low/high are not numbers or high ≤ low (src/CompanyView.tsx:44-47). aria-label "`<label>` range `<low>` to `<high>`, now at N%" (src/CompanyView.tsx:45).
  - About block (aria-label "About the company"): heading "About", an industry badge (title "SEC industry classification"), the first paragraph of the annual-report overview (all paragraphs when opened), and a source line "From `<kind>` filed `<date>` · `<section>` · opening paragraphs" (parts shown only when present) (src/CompanyView.tsx:60-66).
  - Tiles (label / value / sub-line): "PER" ("price / earnings"), "PBR" ("price / book"), "EPS" ("per share"), "BPS" ("per share"), "ROE" (sub-line = statement period; tooltip "No financial statements for this listing" when absent), "Consensus target" (sub-line "+x.x% · N brokers"; tooltip "No analyst coverage in the last 180 days" when absent), "Market cap" (only when known; formatted "₩…T" or "₩…억"), "Foreign ownership" (only when a number) (src/CompanyView.tsx:41, :51-56). A missing value shows "—" (src/CompanyView.tsx:48).
  - Loading state: "Loading `<name>`", "Price, valuation and price history from KIS", a progress bar and 10 skeleton tiles (src/CompanyView.tsx:67).
  - Errors (role alert): the `error` string returned by `company:get`, or "Company data could not load. Please retry." when the call rejects (src/CompanyView.tsx:13, :67). Pop-out failure: "The chart window could not open." (src/CompanyView.tsx:31, :42).
- **Controls**:
  - Text input, aria-label "Company stock code", placeholder "Code or ticker · 005930, NASD:AAPL" (src/CompanyView.tsx:42).
  - Button "View" (primary, form submit): trims and upper-cases the draft, selects it and forces a reload; disabled while loading (src/CompanyView.tsx:42).
  - Button "Refresh": reloads company data, About and the profile; disabled while loading (src/CompanyView.tsx:42, :13, :26-27).
  - Button "Pop out ↗" (title "Open this chart in its own window"): opens the pop-out window; hidden in the pop-out window (`standalone`) (src/CompanyView.tsx:42, :31).
  - Link button "More" / "Less" in About: shown when there is more than one paragraph or the first exceeds 260 characters (src/CompanyView.tsx:64).
  - Disclosure "Data coverage": "Prices and valuation from KIS, possibly delayed. ROE is from the latest financial statements and the target is the median of analyst targets over 180 days (Research below has the detail)." (src/CompanyView.tsx:57).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getPortfolio()` (src/CompanyView.tsx:12) | `portfolio:get` (electron/preload.cjs:6) | not determined (outside this fragment) | supplies `rows` (symbol, name) for the instrument select |
| `getCompany(symbol)` (src/CompanyView.tsx:13, :30) | `company:get` (electron/preload.cjs:12) | main.cjs:313 | three `kisService.request('company-chart',{request:{symbol,dataset}})` calls for datasets `company`, `daily_technicals`, `minute_technicals` (main.cjs:314); the worker runs `kis-evidence.cjs` `fetchEvidence` (electron/kis-worker.cjs:27). Result cached 30 s per connection+symbol; cache cleared above 30 entries (main.cjs:313-314) |
| `getResearch(symbol,['about'])` and `getResearch(symbol,['overview','analysts','financials'])` (src/CompanyView.tsx:26-27) | `research:company` (electron/preload.cjs:13) | main.cjs:446 | `research.profile(symbol,{sections,refresh})` (electron/research-service.cjs:213); at most 12 section names are passed (main.cjs:446) |
| `watchChart(symbol)` / `watchChart(null)` (src/CompanyView.tsx:19) | `chart:watch` (electron/preload.cjs:16) | main.cjs:305 | records the window's symbol in `chartWatch`, then `syncChartStream()` → `kisService.request('chart-stream',{symbols})` for up to 5 Korean symbols (main.cjs:29, :305-308) |
| `onChartTick(cb)` (src/CompanyView.tsx:20) | broadcast `chart:tick` (electron/preload.cjs:16) | sender `sendChartTick` main.cjs:28 | sent only to windows watching that symbol (main.cjs:28) |
| `openChartWindow(symbol)` (src/CompanyView.tsx:31) | `chart:pop-out` (electron/preload.cjs:16) | main.cjs:302 | `openChartWindow(symbol)` (main.cjs:215) |

  - `company:get` error strings (returned as `{error}`, shown as the alert): "Enter a six-digit Korean code or exchange:ticker, such as NASD:AAPL."; "Connect your KIS account first."; "Another company request is loading. Please retry." (only one company request runs at a time); "Account changed. Refresh the company view." (main.cjs:313-314). A dataset that fails becomes `{status:'unavailable'}` without an error (main.cjs:314).
  - Symbol pattern accepted by all chart/research handlers: six digits, or `NASD|NYSE|AMEX` + ":" + ticker of up to 15 characters (main.cjs:302, :306, :309, :313, :446). `chart:pop-out`, `chart:watch` and `research:company` throw `INVALID_REQUEST` on a bad symbol (main.cjs:302, :306, :446).
- **Subscriptions**:
  - `onChartTick`: a tick for the shown symbol updates the latest daily bar, the latest minute bar, the header price and, when present, day high/low (src/CompanyView.tsx:20-21, :34). Live state resets whenever a new `company:get` value arrives (src/CompanyView.tsx:18).
  - Tick sources on the main side: the KIS stream (`kisService.onQuote`, `source:'stream'`, with `dayVolume` and per-trade `volume`) (main.cjs:34-37); a poll at most every 10 s, run from `publishMarket`, for U.S. symbols while a U.S. session is open and for Korean symbols while the stream is not connected and the Korean session is open (`source:'poll'`) (main.cjs:30-33, :237). Ticks do not feed the portfolio or reviews (main.cjs:23-25).
  - `autoRefreshMs` timer: `0` in the Charts tab (no timer); 60000 ms in the pop-out window (src/CompanyView.tsx:29-30; src/ChartWindow.tsx:9). A timed refresh replaces the data only when it has no error and the symbol still matches (src/CompanyView.tsx:30).
- **Saved state**: Renderer session memory only (`useDraftState`: kept across tab changes, lost on reload/exit, src/useDraftState.ts:2): `company:symbol` (default `initialSymbol` or "005930") and `company:query` (the input text) (src/CompanyView.tsx:10). `interval` ("1d" default), About open/closed and live bars are plain component state (src/CompanyView.tsx:10, :16, :25). Nothing is written to the main process.
- **Notes**:
  - "5m" bars are built in the renderer by grouping one-minute bars into 300000 ms buckets (src/CompanyView.tsx:35).
  - Prices print with 2 decimals for U.S. symbols and 0 for Korean ones; a non-number prints "Unavailable" (src/CompanyView.tsx:34).
  - `applyTick` (src/live-bars.mjs:13): ignores ticks with no positive price, a non-finite timestamp, or `session==='us-daytime'` (those move no bars; the header still shows them, labelled) (src/live-bars.mjs:14-16). Period `'day'` merges into the last bar of the same exchange-local day or appends a new bar stamped 00:00 KST (Korea) / 12:00 UTC (U.S.) (src/live-bars.mjs:6, :22-25); a numeric period uses clock-aligned buckets (src/live-bars.mjs:27-29); `'last'` only updates the latest bar (weekly/monthly) (src/live-bars.mjs:21). Day volume takes the larger of the bar's volume and the tick's `dayVolume` (src/live-bars.mjs:19).
  - Narrow window: at ≤1000 px the quote becomes one column and tiles two columns (src/themes.css:158); at ≤900 px the OHLC list loses its left margin (src/themes.css:146).

### CandleChart ("Price history")

- **Purpose**: Candle or line chart with volume for the selected symbol and interval (src/CandleChart.tsx:14).
- **Component files**: `src/CandleChart.tsx` exports `CandleChart` and type `Candle` (src/CandleChart.tsx:3, :14). Mounted by `CompanyView` with `source="kis"` (src/CompanyView.tsx:68).
- **What it shows**:
  - Heading "Price history" (src/CandleChart.tsx:21).
  - Caption: "KIS adjusted daily OHLC and volume" (1d) or "KIS intraday OHLC and volume" (1m/5m) (or "Synthetic OHLC and volume" for a non-KIS source) + " · `<interval>` bars · " + "New York time · USD" or "Seoul time · KRW" (src/CandleChart.tsx:21).
  - Statistics row: "Visible period ±x.xx%", "Period high", "Period low", "Bars shown" (src/CandleChart.tsx:23).
  - Readout for the hovered (or latest) bar: date, a "Latest" tag, close in bold, change from the previous bar "▲/▼ ±amount (±x.xx%)", then "O", "H", "L", "C", "Range" (high/low − 1, %) and "Vol" (compact: B/M/K; tooltip full count + " shares") (src/CandleChart.tsx:6-12).
  - SVG chart (viewBox 900×350): 5 grid lines with price labels, candles (up = accent colour, down = #d96c6c), optional volume bars, optional gold 20-bar average line, a dashed crosshair and dot on hover, first and last dates under the axis (src/CandleChart.tsx:25-29). aria-label "KIS candlestick and volume chart" / "KIS price line and volume chart" (src/CandleChart.tsx:25).
  - Loading: skeleton bars and "Loading daily prices for `<name>`…" / "Loading intraday prices for `<name>`…" (src/CandleChart.tsx:24).
  - Empty: "No price history" and "KIS returned no `<interval>` bars for `<name>`. Try Refresh, or another interval." (src/CandleChart.tsx:24).
  - Dates use the exchange's time zone (America/New_York or Asia/Seoul); daily bars show the date only (src/CandleChart.tsx:16, :19).
- **Controls**:
  - Select, aria-label "Chart instrument": the portfolio rows by name, plus the current symbol when it is not a holding (src/CandleChart.tsx:21; src/CompanyView.tsx:34). Changing it selects that symbol.
  - Select, aria-label "Candle interval": "1m", "5m", "1d" (src/CandleChart.tsx:21).
  - Segmented buttons "Candles" / "Price line" (src/CandleChart.tsx:22).
  - Segmented buttons (aria-label "Visible chart range"): "20 bars", "50 bars", "100 bars", "All bars" (src/CandleChart.tsx:22).
  - Checkbox "20-bar average" (default off) and checkbox "Volume" (default on) (src/CandleChart.tsx:15, :22).
  - Slider "Inspect a bar" (aria-label "Inspect chart bar"), shown with more than one bar; hovering a bar does the same (src/CandleChart.tsx:27, :30).
  - Disclosure "Chart details": "Hover or use the slider to inspect prices." + (when the average is on) "Gold line: 20-bar simple moving average, available after 20 source bars." + for 1d "Up to about 200 adjusted daily bars." or for intraday "Latest minute bars from today, refreshed every 30 seconds. Five-minute bars are aggregated locally; edge bars can be partial. Current-bar volume is provisional." (src/CandleChart.tsx:30).
- **Calls and channels**: none of its own; data comes from `CompanyView` props (src/CandleChart.tsx:14).
- **Subscriptions**: none (src/CandleChart.tsx:14-15).
- **Saved state**: Renderer session memory (`useDraftState`): `src/CandleChart.tsx:view` ("candles"), `src/CandleChart.tsx:range` (100), `src/CandleChart.tsx:average` (false), `src/CandleChart.tsx:volume` (true) (src/CandleChart.tsx:15). Not persisted across restarts (src/useDraftState.ts:2).
- **Notes**: The text "refreshed every 30 seconds" matches the 30 s `company:get` cache (main.cjs:313) (inferred); the Charts tab itself has no refresh timer (src/CompanyView.tsx:29, src/main.tsx:138). The 20-bar average is computed from the full candle list, so it can start before the visible range (src/CandleChart.tsx:20).

### TechnicalSummary

- **Purpose**: A buy/sell rating per timeframe, then moving averages, indicators and pivot points for the selected timeframe. Display only; reviews do not receive these readings (src/TechnicalSummary.tsx:8-9).
- **Component files**: `src/TechnicalSummary.tsx` exports `TechnicalSummary` (src/TechnicalSummary.tsx:10); calculation in `src/technical-summary.mjs` (`TIMEFRAMES`, `RATINGS`, `SIGNALS`, `summarize`, `aggregate`, src/TechnicalSummary.tsx:4). Mounted by `CompanyView` with the daily bars (src/CompanyView.tsx:70).
- **What it shows**:
  - Heading "Technical summary"; "Loading bars" with a spinner while loading (src/TechnicalSummary.tsx:28).
  - Timeframe tabs (aria-label "Timeframe"): "5 min", "15 min", "30 min", "Hourly", "Daily", "Weekly", "Monthly", each with its rating pill (src/technical-summary.mjs:5; src/TechnicalSummary.tsx:29-30).
  - Rating pill texts: "Strong buy", "Buy", "Neutral", "Sell", "Strong sell" (src/technical-summary.mjs:7); "Not enough data" when there is none (src/TechnicalSummary.tsx:24).
  - Signal pill texts: "Buy", "Sell", "Neutral", "Overbought", "Oversold", "High volatility", "Low volatility" (src/technical-summary.mjs:8).
  - Overall row: "`<Timeframe>` summary", "Moving averages", "Indicators", each with a pill and (for the last two) "Buy N · Neutral N · Sell N"; then "N bars · last `<date>`" (src/TechnicalSummary.tsx:25, :32-33).
  - Card "Moving averages": table columns "Period", "Simple", "Exponential"; rows "MA`<period>`" with value and signal pill (src/TechnicalSummary.tsx:35).
  - Card "Indicators": columns "Name", "Value", "Reading" (src/TechnicalSummary.tsx:36).
  - Card "Pivot points": columns "Level", "Classic", "Fibonacci"; rows "R3", "R2", "R1", "Pivot", "S1", "S2", "S3"; or "Needs a completed bar." (src/TechnicalSummary.tsx:37).
  - No summary for the timeframe: "Loading bars…", or "`<Timeframe>` bars could not load (`<CODE>`).", or "Not enough `<timeframe>` bars yet." with, for Korean intraday frames, ": Korean intraday readings use today’s bars only." (src/TechnicalSummary.tsx:31).
- **Controls**:
  - Timeframe tab buttons (above) select the frame (src/TechnicalSummary.tsx:29).
  - Button "Retry": shown only when the bars request returned an error (src/TechnicalSummary.tsx:28).
  - Disclosure "How these are read" with the rules text; its last sentence is "U.S. intraday bars include earlier sessions." or "Korean intraday bars are today’s from the open; weekly and monthly bars come from KIS." (src/TechnicalSummary.tsx:39).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getChartBars(symbol)` (src/TechnicalSummary.tsx:12) | `chart:bars` (electron/preload.cjs:16) | main.cjs:309 | `kisService.request('chart-bars',{request:{symbol}})` (main.cjs:311) → worker `kis-evidence.cjs` `fetchBars` (electron/kis-worker.cjs:26). Cached 60 s per connection+symbol; cache cleared above 20 entries (main.cjs:310-311) |
| `onChartTick(cb)` (src/TechnicalSummary.tsx:15) | broadcast `chart:tick` | main.cjs:28 | — |

  - `chart:bars` error replies (`{error}`): `INVALID_REQUEST`, `KIS_NOT_CONNECTED`, `ACCOUNT_CHANGED`, or `kisErrorCode(error)` (main.cjs:309-312). A rejected call becomes `REQUEST_FAILED` in the renderer (src/TechnicalSummary.tsx:12).
- **Subscriptions**: `onChartTick` moves the latest bar of each fetched timeframe (`'last'` for weekly/monthly) (src/TechnicalSummary.tsx:15-17). Refetches on symbol change or Retry (src/TechnicalSummary.tsx:12).
- **Saved state**: Renderer session memory: `technical:frame` (default "1d") (src/TechnicalSummary.tsx:11).
- **Notes**: Korean intraday frames are aggregated in the renderer from today's one-minute bars; U.S. frames come ready from KIS (src/TechnicalSummary.tsx:18-20). Narrow window: at ≤1100 px the three cards stack in one column and the timeframe tabs wrap to four per row (src/technical.css:26).

### ResearchPanel ("Research")

- **Purpose**: The same research the AI agents read, one tab per section, each loaded when first opened (src/ResearchPanel.tsx:5, :177).
- **Component files**: `src/ResearchPanel.tsx` exports `ResearchPanel`, `Spark`, types `ResearchSection`, `ResearchProfile` (src/ResearchPanel.tsx:3-4, :104, :164). Mounted by `CompanyView` (src/CompanyView.tsx:72-73).
- **What it shows**:
  - Heading "Research" with "Loading…" or "Updated `<ago>`" (+ " · showing saved data" when stale); ago texts "just now", "N min ago", "N h ago" or a date (src/ResearchPanel.tsx:16, :174).
  - Tabs (aria-label "Research sections"): "Overview", "Analysts", "Estimates", "Financials", "Dividends", "Events", "Flows", "Risk", "Valuation", "Peers", "Fund", "Holdings", "Factors", "Fair value" (src/ResearchPanel.tsx:8). U.S. symbols show only Overview, Financials, Dividends, Events, Risk (src/ResearchPanel.tsx:6, :169). ETFs/ETNs show only Overview, Fund, Holdings, Dividends, Flows, Risk (src/ResearchPanel.tsx:7, :169). Other Korean stocks show all except Fund and Holdings (src/ResearchPanel.tsx:169).
  - Loading skeleton "Loading `<tab>` research…" (src/ResearchPanel.tsx:176). Unavailable section: the reason sentence (table in Notes) (src/ResearchPanel.tsx:176).
  - Footer: "KIS and SEC EDGAR data." (U.S.) or "KIS and OpenDART data." + " The AI agents read the same research." (src/ResearchPanel.tsx:177).
  - Overview: stat grid "Price", "Day change", "Market cap", "PER", "PBR", "EPS", "BPS", "52-week low", "52-week high", (Korea only) "Foreign ownership", "Turnover", then "Sector" (src/ResearchPanel.tsx:23).
  - Analysts: line "N brokerages in 180 days · N Buy · N Hold · N Sell"; stats "Median target", "Upside to median", "High target", "Low target"; line "Last N days: N raised, N cut, N kept their target"; a trend line; table (aria "Latest analyst notes") columns "Date", "Brokerage", "Rating", "Target" (src/ResearchPanel.tsx:28-32).
  - Estimates: "No consensus estimates for this stock." or a table (aria "Consensus estimates") with "Metric" + one column per year; rows "Revenue", "Operating profit", "Net income", "EPS", "PER", "ROE", "Debt ratio"; note "Years ending in E are forecasts." + optional " Latest report: `<opinion>` (`<date>`)." (src/ResearchPanel.tsx:35-40).
  - Financials: table (aria "Financial statements") "Item" + up to 5 period columns. Korean rows: "Revenue", "Operating profit", "Net income", "Operating margin", "Net margin", "ROE", "ROA", "Revenue growth", "Op. profit growth", "EPS", "BPS", "Total assets", "Equity", "Debt ratio", "Current ratio", "EBITDA", "EV/EBITDA" (src/ResearchPanel.tsx:42). U.S. rows: "Revenue", "Operating income", "Net income", "Operating margin", "Net margin", "ROE", "Revenue growth", "EPS (diluted)", "EPS growth", "Operating cash flow", "Free cash flow", "Dividends per share", "Payout ratio", "Total assets", "Equity", "Long-term debt", "Debt / equity", "Cash" (src/ResearchPanel.tsx:43). Rows with no value in any period are left out (src/ResearchPanel.tsx:47). Notes: "Fiscal years from SEC 10-K filings." or "Periods not ending in December are year to date." (src/ResearchPanel.tsx:48). Fallback table (aria "Annual ratios"): "Period", "Revenue growth", "ROE", "EPS", "Debt ratio"; or "No financial data available." (src/ResearchPanel.tsx:46).
  - Trend lines (Analysts, Estimates): "Revision tracking started `<date>`; changes show after a month." or "`<label>` ±x.x% since `<date>`" joined by " · " for 1m and 3m (src/ResearchPanel.tsx:50-53).
  - Dividends: stats "Last 12 months" (Korea), "Trailing yield", "Frequency" (Korea; "No dividends" when none); a yield-basis note; table (aria "Annual report dividends") "Fiscal year", "Per share", "Payout ratio", "Yield"; "Payout ratios: `<reason>`" when unavailable; table (aria "Dividend payments") "Record date", "Kind", "Per share" ("Not set yet" when null), "Paid" (src/ResearchPanel.tsx:71-77). Kind labels: 결산→"Year-end", 분기→"Quarterly", 중간→"Interim" (src/ResearchPanel.tsx:18).
  - Events: sub-heading "Coming up" with dated items and a kind tag, or "Nothing scheduled that we know of."; note "Last earnings release `<date>`" (U.S.) / "Last preliminary earnings filed `<date>`" (Korea) + "; next expected around `<date>` (estimated)"; sub-heading "Filings, last 12 months" with a table of date, kind tag and a title link, or "No material filings in the last 12 months.", or the reason sentence (src/ResearchPanel.tsx:83-87). Kind tags: "Earnings", "IR", "Dividend", "Buyback", "Capital", "Report", "Corporate", "Contract", "Legal", "Ownership", "Material", "Other", "Meeting" (src/ResearchPanel.tsx:19).
  - Flows: table (aria "Investor net buying") columns "Net buying", "5 days", "20 days", "Streak"; rows "Foreigners", "Institutions", "Individuals"; streak text "N day(s) of net buying/selling"; note "Through `<date>`."; stats "Short selling (latest)", "Short selling (20-day avg)", "Margin loans / shares", "Margin change", "Program trading (5 days)", "Program trading (20 days)"; note "Short selling is the share of daily volume sold short. Margin is loans outstanding as a share of listed shares." (src/ResearchPanel.tsx:90-101).
  - Risk: a sparkline of closes; stats "Volatility (annualized)", "Beta to `<index>`", "Correlation", "1-month return", "3-month return", "1 month vs `<index>`", (Korea) "1 month vs sector", "Max drawdown", "From high", "vs 20-day average", "vs 60-day average", "Avg daily value (20 days)"; note "From N daily closes through `<date>`; drawdown and high cover that window." (src/ResearchPanel.tsx:109-113). Then "Technical indicators · daily": "RSI (14)", "Stochastic RSI (14)", "MACD histogram" (↑/↓), "ATR (14)", "ADX (14)" ("· up trend"/"· down trend"), "CCI (14)", "Ultimate oscillator", "20-day range position"; note "Values, not buy or sell calls. RSI above 70 or below 30 is stretched; ADX above about 25 is a strong trend; ATR is the typical daily move, useful for stop distances." (src/ResearchPanel.tsx:117-121).
  - Valuation: stats "PER now", "PER range", "vs median PER", "PBR now", "PBR range", "vs median PBR", "1-year return", "3-year return", "5-year return"; table (aria "Valuation history") "Year", "Year-end close", "EPS", "PER", "BPS", "PBR"; note "Year-end multiples use the December close with EPS and BPS for the same year." (src/ResearchPanel.tsx:58-60).
  - Peers: line "`<sector>` · PER ±x% and PBR ±x% versus the peer median"; table (aria "Peers") "Company", "Market cap", "PER", "PBR", "Day" with a "Peer median" row; note "The largest listed stocks in the same KRX index sector." (src/ResearchPanel.tsx:65-67).
  - Factors: bars (aria "Factor scores") for "Value", "Momentum", "Quality", "Growth", "Low volatility" labelled "Top N%", "Bottom N%" or "Nth percentile"; table (aria "Factor peers") "Company" + the five factors; a note from the data (src/ResearchPanel.tsx:123-129).
  - Fair value: stats "Fair value (middle)", "vs price", "Range", "Uncertainty" ("`<level>` (N% spread)"); a range bar (aria "Fair value range"); key "price · middle of the methods"; table (aria "Fair value methods") "Method", "Value", "vs price", "Basis"; a note from the data (src/ResearchPanel.tsx:135-139).
  - Fund: warning line for leveraged/inverse funds "`<Leveraged|Inverse>` N× daily · resets every day, so returns over weeks drift from the multiple; estimated drag about N% a year at current volatility."; stats "Underlying", "Issuer", "Type" ("Tracks its index 1:1" / "Leveraged N×" / "Inverse N×"), "Net assets", "NAV", "Premium / discount", "Avg |premium| (20 days)", "Tracking error", "Holdings", "Distributions" ("every N months"), "Listed", "Maturity"; note "A premium means the price is above the value of the holdings. Tracking error is how far returns stray from the index." (src/ResearchPanel.tsx:142-149).
  - Holdings: stats "Holdings", "Top 5", "Top 10"; "By sector" bars (up to 8); "Largest holdings" bars (up to 15); a note from the data; when empty the note + " The fund reports N holdings." (src/ResearchPanel.tsx:153-160).
- **Controls**:
  - Button "Refresh": reloads the open tab with `refresh=true`; disabled while that tab loads (src/ResearchPanel.tsx:174).
  - Tab buttons (above) (src/ResearchPanel.tsx:175).
  - Events: checkbox "Show ownership reports", shown only when a filing of kind `ownership` exists; ownership filings are hidden until ticked (src/ResearchPanel.tsx:81, :86).
  - Events: each filing title is a link button that opens the filing in the system browser (src/ResearchPanel.tsx:87).
  - Fund: disclosure "Price vs NAV, last N days" with a table "Date", "Close", "NAV", "Premium" (src/ResearchPanel.tsx:148).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getResearch(symbol,[section],refresh)` (src/ResearchPanel.tsx:166) | `research:company` (electron/preload.cjs:13) | main.cjs:446 | `research.profile(symbol,{sections,refresh})` (electron/research-service.cjs:213) |
| `openFiling(url)` (src/ResearchPanel.tsx:87) | `research:open-filing` (electron/preload.cjs:14) | main.cjs:445 | `shell.openExternal(url)` only for `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=<14 digits>` or `https://www.sec.gov/Archives/edgar/data/<id>/<18 digits>/<file>`; any other URL is ignored silently (main.cjs:445) |

- **Subscriptions**: none; a section loads when its tab is first opened or after a symbol change clears the data (src/ResearchPanel.tsx:167-168).
- **Saved state**: Renderer-only component state (open tab, loaded sections, ownership checkbox); the open tab resets to "overview" when the component remounts (src/ResearchPanel.tsx:165, :81). The research cache itself is in the main process table `research_cache` (electron/research-service.cjs:41).
- **Notes**: Reason-code table `REASONS` (src/ResearchPanel.tsx:9), 15 codes; any other code shows "Not available right now." (src/ResearchPanel.tsx:10):

| Code | Text |
|---|---|
| `KIS_NOT_CONNECTED` | "Connect your KIS account to load research." |
| `DART_KEY_MISSING` | "Add an OpenDART key to your providers file." |
| `KOREAN_LISTINGS_ONLY` | "Available for Korean stocks." |
| `INSUFFICIENT_HISTORY` | "Not enough price history yet." |
| `NO_PEERS` | "No sector peers for this listing." |
| `NOT_FOR_FUNDS` | "Not available for ETFs and ETNs." |
| `NOT_ENOUGH_INPUTS` | "Not enough data for a fair value range." |
| `FUNDS_ONLY` | "Only for ETFs and ETNs." |
| `NOT_AN_ETF` | "Only for ETFs and ETNs." |
| `RATE_LIMITED` | "KIS is rate limiting. Try again shortly." |
| `NOT_IN_DART` | "This listing has no DART filings." |
| `DART_RATE_LIMITED` | "OpenDART is rate limiting. Try again later." |
| `SEC_CONTACT_MISSING` | "Add a contact email under Connections → SEC EDGAR to load SEC filings. SEC asks every app for one." |
| `NOT_IN_SEC` | "SEC has no filings for this ticker." |
| `SEC_RATE_LIMITED` | "SEC refused the request. Try again later." |

  A section missing from the reply gets reason `UNKNOWN_SECTION`, which shows "Not available right now." (src/ResearchPanel.tsx:166, :10). Missing numbers print "—" (src/ResearchPanel.tsx:11-14).

### PaperReplay ("Paper replay")

- **Purpose**: An offline comparison of buy-and-hold against exiting after a closing-price loss threshold, on the chart's completed daily bars (src/PaperReplay.tsx:7).
- **Component files**: `src/PaperReplay.tsx` exports `PaperReplay` (src/PaperReplay.tsx:5); calculation `replay` in `src/paper-replay.mjs:2`. Mounted by `CompanyView` in the Charts tab only (not in the pop-out window), keyed by symbol, with daily candles dated before today in the exchange's time zone (src/CompanyView.tsx:36, :72-73).
- **What it shows**: A closed disclosure "Paper replay · test a loss-reduction hypothesis". Inside: "Compare buy-and-hold with exiting after a closing-price loss threshold. Signals execute at the next bar’s open; the position then stays in cash."; after a run, a line "`<symbol>` · N completed daily bars · N% threshold · N% commission · N% sale levy" and a table with columns "Sample", "Hold return", "Candidate return", "Hold / candidate drawdown"; rows "Earlier sample" and "Later holdout" with their date ranges (src/PaperReplay.tsx:7; src/paper-replay.mjs:18). Errors show as an alert with the message text (src/PaperReplay.tsx:7).
- **Controls**:
  - Number input "Loss threshold (%)": min 0.1, max 100, step 0.1, default 10 (src/PaperReplay.tsx:6-7).
  - Number input "Commission each side (%)": min 0, max 10, step 0.01, default 0 (src/PaperReplay.tsx:6-7).
  - Number input "Sale levy (%)": min 0, max 10, step 0.01, default 0 (src/PaperReplay.tsx:6-7).
  - Button "Run offline replay" (src/PaperReplay.tsx:7).
  - Note disclosure, summary "An offline illustration. See what it leaves out.", text beginning "Offline illustration with fractional shares and full fills." (src/PaperReplay.tsx:7).
- **Calls and channels**: none; the calculation runs in the renderer (src/PaperReplay.tsx:4, :7).
- **Subscriptions**: none (src/PaperReplay.tsx:6).
- **Saved state**: Renderer-only component state; reset when the symbol changes (`key={symbol}`) (src/PaperReplay.tsx:6; src/CompanyView.tsx:73). It "never promotes a lesson or changes trading" (src/PaperReplay.tsx:7).
- **Notes**: Error messages thrown by `replay`: "Invalid scenario" (threshold not in (0,100] or a cost not in [0,10]) and "At least 20 chronological completed bars are required" (src/paper-replay.mjs:3-4). The series is split into two halves, each run independently from an index of 100 (src/paper-replay.mjs:7, :17-18).

## Pop-out chart window

- **Purpose**: A chart-only window for one symbol, opened from Charts; it follows the app theme and refreshes quietly every minute (src/ChartWindow.tsx:3).
- **Component files**: `src/ChartWindow.tsx` exports `ChartWindow` (src/ChartWindow.tsx:4). Rendered instead of `App` when the page hash starts with `#chart:` (src/main.tsx:155-156). It renders `<CompanyView initialSymbol={symbol} standalone autoRefreshMs={60000} …/>` inside `<main className="chart-window" aria-label="Chart window">` (src/ChartWindow.tsx:9).
- **What it shows**: The same `CompanyView` in `standalone` order: header + price + About, then the chart, then the stat tiles in their own section, then Technical summary, then Research. No Paper replay (src/CompanyView.tsx:71-72). The header shows "Refreshes every minute" instead of the Pop out button (src/CompanyView.tsx:42). While loading or on error only the header and the status show (src/CompanyView.tsx:72). The window title is "`<symbol>` · Chart", updated when the symbol changes (src/ChartWindow.tsx:9; main.cjs:217).
- **Controls**: As in Charts, without "Pop out ↗" (src/CompanyView.tsx:42). The user can type another symbol in the window; the title follows, but the main process still files the window under the symbol it was opened with (main.cjs:216, :219) (inferred consequence: popping out that original symbol again focuses this window).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getTheme()` (src/ChartWindow.tsx:7) | `theme:get` (electron/preload.cjs:89) | main.cjs:783 | `store.getTheme()` |
| `onTheme(cb)` (src/ChartWindow.tsx:7) | broadcast `theme:changed` (electron/preload.cjs:91-95) | sent at main.cjs:787 | sets `document.documentElement.dataset.theme` (src/ChartWindow.tsx:6) |
| all `CompanyView` calls | see Charts tab | | |

- **Subscriptions**: `onTheme`; `onChartTick`; a 60000 ms timer that re-reads `company:get` (src/ChartWindow.tsx:7, :9; src/CompanyView.tsx:29-30).
- **Saved state**: None persisted. Each window is a separate page, so its `useDraftState` memory is its own (inferred from src/useDraftState.ts:3 being module state).
- **Notes**:
  - Window options (`openChartWindow`, main.cjs:215-220): one window per symbol (an existing one is restored and focused, main.cjs:216); width 1040, height 780, minWidth 560, minHeight 480; background "#f3f6fa" (light theme) or "#181818"; title "`<symbol>` · Chart"; `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, same preload (main.cjs:217). The menu is removed, new windows are denied and navigation is blocked (main.cjs:218). It loads the same page with hash `chart:<encoded symbol>` (main.cjs:220). Pop-out windows close when the main window closes (main.cjs:210-211).
  - Narrow window: `main.chart-window` is centred with max-width 1180 px and padding 20px 24px; at ≤700 px the padding is 12px 16px with no margin (src/themes.css:111-112).
  - `market:history` (main.cjs:769) is exposed as `getHistory` (electron/preload.cjs:99) but none of the Charts files call it; the Charts bars come from `company:get` and `chart:bars` (src/CompanyView.tsx:13; src/TechnicalSummary.tsx:12). The handler serves `1d`/`1m`/`5m` bars for held symbols through `kisService.request('history',…)` with a 60 s (1d) or 30 s bucket cache, throwing "Unsupported instrument or interval" or "Connection changed" (main.cjs:769-781). Its renderer caller: not determined (outside the assigned files).

## Performance tab

- **Purpose**: Shows the account's recorded daily value, time-weighted investment return against a benchmark, period statistics, deposits and withdrawals, and below it the KIS realized-profit report (src/main.tsx:144-145).
- **Component files**: `src/AccountPerformance.tsx` exports `AccountPerformance` (src/AccountPerformance.tsx:42), mounted at src/main.tsx:144. It is followed by `ActivityReport` with `mode="profit"` (src/main.tsx:145; documented under "ActivityReport, profit mode" below). Charts are in `src/PerfCharts.tsx` (`ValueChart`, `ReturnChart`, `PnlChart`, `DrawdownChart`, src/PerfCharts.tsx:53, :77, :96, :114). `src/SettlementEffects.tsx` exports `SettlementEffects` (src/SettlementEffects.tsx:6). `src/Scoreboard.tsx` exports `Scoreboard`; it is NOT mounted on the Performance tab: its only mount is the Journal's "Scoreboard" view (src/JournalView.tsx:59). It is documented here as asked.

### AccountPerformance ("Account value & investment performance")

- **Purpose**: Value, return, P/L, period statistics, four charts, period table, settlement notes and the deposits/withdrawals record (src/AccountPerformance.tsx:60-93).
- **Component files**: src/AccountPerformance.tsx:42 `AccountPerformance`; section aria-label "Account performance" (src/AccountPerformance.tsx:60).
- **What it shows**:
  - Not connected: heading "Account value & returns" and "Connect KIS to start tracking account value." (src/AccountPerformance.tsx:51).
  - Records unreadable: heading "Account value & returns" and the warning "The performance records could not be read." (src/AccountPerformance.tsx:53).
  - Heading "Account value & investment performance" with "Recorded daily since `<date>`" or "No values recorded yet" (src/AccountPerformance.tsx:60).
  - Three headline tiles (src/AccountPerformance.tsx:61): "Latest value · `<series label>`" (value and day); "Investment return (time-weighted) · since `<start>`" (the All-period return, or "Unavailable", with "`<benchmark>` ±x.xx%" and an "Estimate" tag when settlement-affected); "Investment P/L (after deposits, withdrawals and accounting corrections)" (gain or "Unavailable"/"—", with "Net recorded flows `<amount>`" and " · corrections `<amount>`"). With no points: "No values for this market yet." (src/AccountPerformance.tsx:61).
  - "Estimate" tag tooltip: "Return estimate, settlement not verified: includes `<list>` day(s)", where the list joins "N with U.S. buys awaiting settlement evidence", "N without a return", "N with accounting corrections" (src/AccountPerformance.tsx:38, :41).
  - Warning (aria "Unreadable money movements"): "Return estimate: a deposit or withdrawal record could not be read." + " It is left out of the returns, so a deposit or withdrawal may be counted as gain or loss." (src/AccountPerformance.tsx:62).
  - Warning "Provisional performance": "N money change(s) awaiting you count(s) as a deposit / a withdrawal / deposits or withdrawals (`<day ±amount>` [" (checking)"], …). If it was / they were income or no money moved: return `<x>`, P/L `<y>`." + "Not counted: `<item>`, `<reason or 'being checked'>`; …." + "Confirm or remove it/them below." (src/AccountPerformance.tsx:63-65).
  - Period tabs (aria "History period"): labels from the summary, "All" shown as "All · since `<start>`"; partial periods other than All are hidden, as are periods that start on the same day as All; note "Longer periods appear once the history covers them." (src/AccountPerformance.tsx:56, :67). Period labels produced by the engine: "1W", "1M", "3M", "YTD", "1Y", "All" (electron/performance.cjs:5).
  - Period statistics (aria "Period statistics", src/AccountPerformance.tsx:71): "Return" (sub-line "`<benchmark>` ±x%" or "no single return on N day(s)"), "Gain" ("after deposits and withdrawals" or "after deposits, withdrawals and corrections"), "Highest value" (day), "Lowest value" (day), "Max drawdown" ("worst fall in returns"), "Below return peak" ("now"), "Volatility" ("annualized, from N day(s) with a return (N without)" or "needs 5+ days with a return; N so far"), "Unrealized P/L". A value is "Unavailable" when the return chain is broken (src/AccountPerformance.tsx:69-71).
  - "More statistics" (src/AccountPerformance.tsx:72-73): "Intraday high" and "Intraday low" (" (partly estimated)" when estimated; day), "Best day", "Worst day", "Up days", "Cash share"; note "Highest and lowest values include deposits and withdrawals; drawdowns use time-weighted returns, so they do not. Day statistics use only the days with a return."
  - Chart tabs (aria "Chart"): "Value", "Return vs benchmark", "Daily P/L", "Drawdown" (src/AccountPerformance.tsx:28, :74). Messages: "Daily P/L appears from the second recorded day." (src/AccountPerformance.tsx:77); "Drawdown is unavailable from `<day>`: a day without a single return breaks the time-weighted chain." (src/AccountPerformance.tsx:78).
  - "By holding" table (aria "Holding contribution"): columns "Holding", "At start", "Now", "Change"; a holding is tagged "bought in period" or "sold in period"; note "Unrealized P/L only; gains locked in by sales show under Profit below." (src/AccountPerformance.tsx:79).
  - Without analytics for the period but with rows: the return chart and a data table (aria "Cumulative return data") with columns "Day", "Value", "Recorded flow", "Portfolio", "`<benchmark>`" (src/AccountPerformance.tsx:81). With one point: "The chart appears after values are recorded on at least two days." (src/AccountPerformance.tsx:81).
  - Table "Period returns": columns "Period", "From", "Your return", "Gain", "`<benchmark>`", "Difference" ("x.xx pts"); a cell shows "Unavailable" when the period has no return, with up to three reasons in its tooltip, and an "Estimate" tag (src/AccountPerformance.tsx:82).
  - Legend (aria "Return labels"): "Unavailable: a day in the period has no return, so the period has none (never a zero). Estimate: a return is shown, but some of its days are not verified yet (a U.S. buy still awaiting settlement, at most 3 business days, or accounting corrections)." + " Provisional: money changes awaiting you count as deposits or withdrawals." (src/AccountPerformance.tsx:83).
  - Card "Accounting corrections & days without a return" (hint "`<series>`: kept apart from investment performance.", label "Settlement effects"), shown when any point has a correction, an unavailable day or a pending settlement (src/AccountPerformance.tsx:84). See SettlementEffects.
  - Small print: "History starts `<date>`; longer periods are listed once it covers them. Returns are time-weighted from daily values this app records while it runs, so deposits and withdrawals you record below are not counted as gains. Korean cash is valued at settled (D+2) cash. The all-markets series includes exchange-rate effects. Benchmark: `<name>`, updated `<time>` · last refresh failed." (src/AccountPerformance.tsx:85).
  - "Deposits & withdrawals · N" section with the intro "Record deposits and withdrawals so they don’t count as gains or losses. The app also detects cash changes no trade explains and lists them here to confirm or remove." and a table (aria "Recorded flows") with columns "Date", "Account" ("U.S." / "Korea"), "Amount", "Note" (tags "Detected", "Transfer"; "—" when empty) and actions (src/AccountPerformance.tsx:86-90).
  - Notices: success "Recorded. It replaces the detected change of `<amount>`, so the money is counted once."; errors "Enter a past or current date and a non-zero amount." (`INVALID_FLOW`), "Connect KIS first." (`KIS_NOT_CONNECTED`), "The request could not be completed." (any other), "Could not reach the engine." (call rejected) (src/AccountPerformance.tsx:50, :92).
- **Controls**:
  - Select, aria-label "Performance series": "All markets (KRW)" (`COMBINED`), "Korea (KRW)" (`KRW`), "U.S. (USD)" (`USD`) (src/AccountPerformance.tsx:23, :60).
  - Period tab buttons and chart tab buttons (above) (src/AccountPerformance.tsx:67, :74).
  - Disclosures "More statistics" and "By holding · change in unrealized P/L since `<date>`" (src/AccountPerformance.tsx:73, :79).
  - Link button "Show data table" / "Hide data table" (fallback view only) (src/AccountPerformance.tsx:81).
  - Link button "Refresh benchmarks": disabled while busy or while a refresh runs (src/AccountPerformance.tsx:85).
  - Disclosure "Deposits & withdrawals · N": open when flows exist or an amount is typed (src/AccountPerformance.tsx:86).
  - Form (src/AccountPerformance.tsx:88): "Date" (date input, aria "Flow date", max today in Seoul); "Account" select (aria "Flow account"): "Korea (KRW)" / "U.S. (USD)"; "Type" select (aria "Flow type"): "Deposit" / "Withdrawal"; "Amount" (`MoneyField`, aria "Flow amount", currency follows the account, with quick buttons); "Note" (aria "Flow note", max 200 characters).
  - Amount quick buttons: KRW "+10만", "+100만", "+1,000만"; USD "+$100", "+$1,000", "+$10,000" (src/money.ts:69-70; src/MoneyField.tsx:60-61). The read-back line under the field adds "over 10× this account — check the amount" when the amount is far beyond the account's latest value (src/MoneyField.tsx:51; src/money.ts:73).
  - Button "Record deposit" / "Record withdrawal" (primary): disabled while busy or when the amount is not above 0; a withdrawal is sent as a negative amount; on success the amount and note are cleared (src/AccountPerformance.tsx:89).
  - Per flow row (src/AccountPerformance.tsx:90): "Confirm" (detected flows only); "Dividend" (detected, not a transfer, amount > 0; title "A dividend or interest payment: recorded as income, not a deposit"); "Remove" (every row). All disabled while busy. No confirmation dialog on any of them.
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getPerformance()` (src/AccountPerformance.tsx:45-46) | `performance:get` (electron/preload.cjs:42) | main.cjs:572 | `recordValue()` → `performance.record(account,portfolioState(),…)` (main.cjs:530-533); starts `refreshBenchmarks()` when the benchmarks are older than 6 h; replies `performanceState()` (main.cjs:560-562) = `performance.movements`, `performance.summary` for COMBINED/KRW/USD, `performance.closes` for KOSPI and SPX |
| `addCashFlow({day,market,amount,note})` (src/AccountPerformance.tsx:89) | `performance:add-flow` (electron/preload.cjs:44) | main.cjs:588 | `performance.addFlow(accountKey,value)` (electron/performance.cjs:68); throws `KIS_NOT_CONNECTED` when not connected; returns `{replaced:{amount,currency}}` when a detected flow was replaced |
| `confirmCashFlow(id)` (src/AccountPerformance.tsx:90) | `performance:confirm-flow` (electron/preload.cjs:46) | main.cjs:589 | `performance.confirmFlow` (electron/performance.cjs:96) |
| `flowIsIncome(id)` (src/AccountPerformance.tsx:90) | `performance:flow-is-income` (electron/preload.cjs:47) | main.cjs:592-593 | `costs.addIncome({symbol:'UNSPECIFIED',category:'dividend',…,source:'detected-flow'})` then `performance.removeFlow`; throws `INVALID_FLOW` unless the flow is detected, not a transfer and positive |
| `removeCashFlow(id)` (src/AccountPerformance.tsx:90) | `performance:remove-flow` (electron/preload.cjs:45) | main.cjs:590 | `performance.removeFlow` (electron/performance.cjs:94) |
| `refreshBenchmarks()` (src/AccountPerformance.tsx:85) | `performance:refresh-benchmarks` (electron/preload.cjs:48) | main.cjs:594 | `refreshBenchmarks()` (main.cjs:555-557): `kisService.request('index-history',…)` for every index in `INDEXES`, then `performance.saveCloses` |

  - All replies use the wrapper `performanceAction` (main.cjs:571): `{ok:true,state,result?}` or `{ok:false,error,state}`, where `error` is `PERFORMANCE_UNREADABLE` (state unreadable), the thrown code when it matches `[A-Z_]{3,40}`, else `PERFORMANCE_FAILED`.
- **Subscriptions**: A 30000 ms timer re-reads `performance:get` (src/AccountPerformance.tsx:46). Main side: `recordValue` every 60 s (main.cjs:534); benchmark refresh check every 10 min, run when older than 6 h or after a market close (main.cjs:558-559).
- **Saved state**:
  - Deposits/withdrawals: table `cash_flows` (id, account, JSON payload) in the app database (electron/performance.cjs:85, :94, :96). A recorded flow stores `id`, `day`, `market`, `currency`, rounded `amount` (KRW whole, USD cents), trimmed `note`, `createdAt` (electron/performance.cjs:73). Confirming removes the `detected` flag and adds `confirmedAt` (electron/performance.cjs:96-97). "Dividend" writes an income record through `costs.addIncome` and deletes the flow (main.cjs:593).
  - A hand-recorded flow replaces a matching detected flow: same market and sign, amount within ₩10,000 or $10, date within the detected change's span (electron/performance.cjs:79-84).
  - Benchmark closes: table `benchmark_closes` (electron/performance.cjs:115-116). Daily values: table `nav_history` (electron/performance.cjs:66).
  - Renderer session memory (`useDraftState`): `performance:series` ("COMBINED"), `performance:period` ("3M"), `performance:chart` ("value"), `performance:flow` (the unsent form) (src/AccountPerformance.tsx:43-44). The data-table toggle is component state (src/AccountPerformance.tsx:43).
- **Notes**:
  - `addFlow` validation (`INVALID_FLOW`): day must be a valid date not after today (Seoul); market `KR` or `US`; amount finite, non-zero, |amount| ≤ 1e12; note a string of at most 200 characters (electron/performance.cjs:70).
  - Returns print as percent with sign; null prints "—" (src/AccountPerformance.tsx:26-27). Money uses ko-KR KRW with 0 decimals or en-US USD with 2 (src/AccountPerformance.tsx:25).
  - The return chart's portfolio line stops at the first day without a return; it is never carried across (src/AccountPerformance.tsx:30-35).
  - The benchmark name shown is "KOSPI" or "S&P 500" (src/AccountPerformance.tsx:24); the all-markets series uses KOSPI (main.cjs:561).
  - The texts of "unavailable" reasons (tooltips, "Days without a return") come from the engine (`performance.cjs`), not from these files: not determined here.

### PerfCharts (Value, Return vs benchmark, Daily P/L, Drawdown)

- **Purpose**: Four SVG charts drawn at the container's real width, sharing one frame with date ticks, round value ticks and a hover readout (src/PerfCharts.tsx:2-3).
- **Component files**: `src/PerfCharts.tsx` exports `ValueChart`, `ReturnChart`, `PnlChart`, `DrawdownChart`, `niceTicks`, `shortDay`, `axisMoney` (src/PerfCharts.tsx:9, :21, :25, :53, :77, :96, :114). Used by `AccountPerformance` (src/AccountPerformance.tsx:3).
- **What it shows**:
  - Value chart: value line with a soft area, the day's high–low band, a reference line at the first day's value, "High `<amount>`" and "Low `<amount>`" marks (not when they fall on the first or last day), and the last value labelled at the right (src/PerfCharts.tsx:57-70). aria-label "Account value from `<day>` to `<day>`: `<a>` to `<b>`" (src/PerfCharts.tsx:60). Hover card: date, value, "Account value change ±`<amount>` since `<first day>`", "Net deposits ±`<amount>`", "Accounting corrections ±`<amount>` (not investment P/L)", "Investment P/L ±`<amount>`" or "Investment P/L unavailable: N day(s) without a P/L", "Day range `<low>` – `<high>`" (+ " (partly estimated)") (src/PerfCharts.tsx:61-62).
  - Return chart: portfolio and benchmark lines from zero; legend "Portfolio (time-weighted)", the benchmark name, and "Portfolio return unavailable from `<day>`: a day without a return" (src/PerfCharts.tsx:84). Hover: "Portfolio ±x.xx%" (or "unavailable"), "`<benchmark>` ±x.xx%", "Ahead by x.xx pts" / "Behind by x.xx pts" (src/PerfCharts.tsx:82, :85). aria-label "Cumulative return since `<day>`: portfolio `<x>`, `<benchmark>` `<y>`" (src/PerfCharts.tsx:83).
  - Daily P/L chart: bars from zero (up/down), a small grey mark for a day without a P/L, the best and worst bars labelled (src/PerfCharts.tsx:101-110). Legend "N up days", "N down days", "N without a P/L", "Net ±`<amount>`" (+ " (days with a P/L)") (src/PerfCharts.tsx:106). Hover: the day's P/L or "No P/L for this day", the first unavailable reason, "Accounting correction ±`<amount>` (not investment P/L)", "Provisional: `<low>` to `<high>` (the valuation range changed)", "±x.xx% on the day" (src/PerfCharts.tsx:107).
  - Drawdown chart: filled area below zero, a mark "Worst x.xx% · `<day>`", end label "x.xx%" or "Peak" (src/PerfCharts.tsx:120-123). Hover: "x.xx% below the peak" or "At a new peak" (src/PerfCharts.tsx:119).
- **Controls**: Pointer hover only (crosshair and readout) (src/PerfCharts.tsx:30-32, :36).
- **Calls and channels**: none (src/PerfCharts.tsx:1).
- **Subscriptions**: A `ResizeObserver` on the chart container sets the drawing width (src/PerfCharts.tsx:6-8).
- **Saved state**: none; renderer-only hover state (src/PerfCharts.tsx:30).
- **Notes**: Narrow-window behaviour: the width follows the container with a floor of 320 px (src/PerfCharts.tsx:7); the number of date labels is `floor((width−144)/90)` limited to 2–6 (src/PerfCharts.tsx:23); the hover card flips to the left of the cursor past 62% of the width (src/PerfCharts.tsx:35). Axis money is compact: KRW ≥ 1e6 as "₩x.xM", USD ≥ 1e4 as "$x.xK" (src/PerfCharts.tsx:25-28).

### SettlementEffects

- **Purpose**: Lists the selected series' accounting corrections, days without a return and returns not yet verified, apart from the returns (src/SettlementEffects.tsx:3-4).
- **Component files**: `src/SettlementEffects.tsx` exports `SettlementEffects` (src/SettlementEffects.tsx:6); mounted inside the card at src/AccountPerformance.tsx:84.
- **What it shows**:
  - Row "Accounting corrections", hint "Settlement bookkeeping, not investment return. Kept out of returns and P/L.", value "N day(s)" (src/SettlementEffects.tsx:9).
  - Note "Corrections by day · N" with a table (aria "Accounting corrections"): columns "Day", "Correction", "What" (the distinct correction kinds, or "settlement change") (src/SettlementEffects.tsx:10).
  - Row "Days without a return", hint "Unknown, not zero: returns, drawdowns and gains spanning them are unavailable.", tag "N day(s)" (src/SettlementEffects.tsx:11).
  - Note "Why · N": list of day + first reason + " (+N more)" (src/SettlementEffects.tsx:12).
  - Row "Returns not yet verified", hint "A U.S. buy of these days is still awaiting settlement; the return is an estimate until it settles, by KIS evidence or after 3 business days.", tag "N day(s)" (src/SettlementEffects.tsx:13).
  - Renders nothing when all three lists are empty (src/SettlementEffects.tsx:8).
- **Controls**: The two `Note` disclosures (src/SettlementEffects.tsx:10, :12).
- **Calls and channels**: none (src/SettlementEffects.tsx:6).
- **Subscriptions**: none.
- **Saved state**: none.
- **Notes**: Read-only; data are the points of the selected series (src/SettlementEffects.tsx:7).

### Scoreboard ("Learning scoreboard", mounted in Journal)

- **Purpose**: Scores the AI's Buy/Sell recommendations against a benchmark after 1, 5 and 20 trading days, and compares results with and without approved lessons (src/Scoreboard.tsx:47-63; electron/scoreboard.cjs:4).
- **Component files**: `src/Scoreboard.tsx` exports `Scoreboard`, types `ScoreboardState`, `ScoreboardReply` (src/Scoreboard.tsx:8-9, :37). Mounted only at src/JournalView.tsx:59 when the Journal view is "Scoreboard". Not mounted on the Performance tab (src/main.tsx:144-145).
- **What it shows**:
  - Loading: heading "Learning scoreboard" and "Loading…" (src/Scoreboard.tsx:44).
  - Heading "Learning scoreboard" with "N broker Buy/Sell recommendations · N holds not scored" (src/Scoreboard.tsx:47).
  - Three tiles (src/Scoreboard.tsx:49-51): "Beat the benchmark · N trading days" (hit rate; "N scored decisions" or "No scored decisions yet"); "Average excess return · N days" (mean; "Median x%"); "Lesson conflicts" (count; "Approved lessons disagree" or "None among approved lessons"). N is the primary horizon, 5 (electron/scoreboard.cjs:4).
  - Notice "Fewer than N scored decisions. Treat these numbers as anecdotes, not evidence." when the count is between 1 and the minimum sample − 1 (minimum sample 5) (src/Scoreboard.tsx:53; electron/scoreboard.cjs:4).
  - Bar chart of excess return for the last up to 40 scored decisions at the primary horizon (needs at least 2); aria-label "Excess return N trading days after each of the last N scored decisions"; hover card "`<Buy|Sell>` `<symbol>` · `<day>`", "Stock x% · `<benchmark>` y%", "Ahead of / Behind the benchmark by z%"; legend "Decision beat the benchmark", "Decision trailed the benchmark" (src/Scoreboard.tsx:17-32).
  - Table (aria "Decision scores by horizon"): first column "Recommendations", then "1 day", "5 days", "20 days" (src/Scoreboard.tsx:55; electron/scoreboard.cjs:4). Rows: "All", "Buy", "Sell", "High confidence", "Medium confidence", "Low confidence" (only those with data), "With approved lessons", "Without lessons", and, when there is more than one group, "Local rules", "External agent" or the group key (src/Scoreboard.tsx:56-58). Each cell: mean excess "· hit rate of count", or "No data" (src/Scoreboard.tsx:35).
  - Small print: "Each cell: average excess return versus KOSPI (Korean stocks) or S&P 500 (U.S. stocks) · share of decisions that beat it · count. A Buy scores when the stock beats the benchmark afterwards; a Sell scores when it trails. Measured close to close from the decision day, whether or not an order was placed." + "N decisions are still waiting for later closes." + "Prices updated `<time>`" / "Prices not fetched yet" + " · last refresh failed" (src/Scoreboard.tsx:60).
  - "Approved lessons": table (aria "Lesson impact") with columns "Lesson" (symbol or "Paper", and the first 80 characters of the note), "With lesson", "Without", "Difference" ("x.xx pts"), "Result", "Rule trials" ("N done · rule ±x.xx vs hold" or "—"); or "Approve a lesson to compare decisions made with and without it." (src/Scoreboard.tsx:61-62). "Result" texts from the engine: "Not scored (paper lesson)", "Too few decisions", "Higher with lesson", "Lower with lesson", "No difference" (electron/scoreboard.cjs:69).
  - Small print: "Compares N-day excess returns of recommendations on the lesson's symbol when the lesson was supplied to the AI versus when it was not. Results need at least N decisions on each side and are not a significance test; markets change, so a difference does not prove the lesson caused it." (src/Scoreboard.tsx:63).
  - "Possible conflicts": a list of "`<symbol>` · `<reason>`" with the two lesson texts quoted (100 characters each); note "These lessons point in opposite directions. Retire or edit one." (src/Scoreboard.tsx:64).
  - "Completed trades vs benchmark": table (aria "Realized trades versus benchmark") with columns "Sold", "Symbol", "Held" ("N d"), "Net return", "Benchmark", "Excess"; note "Net return after recorded fees. The entry is the latest earlier buy of the same symbol in this app, not tax-lot matching." (src/Scoreboard.tsx:65).
  - Decision table (aria "Scored decisions"): columns "Day", "Decision" ("`<action>` `<symbol>`" + " · ordered"), "Base close", then "1d excess", "5d excess", "20d excess"; cell texts: a percent, "Waiting", "No benchmark" or "No price" (src/Scoreboard.tsx:66).
  - Errors: "Connect KIS first." (`KIS_NOT_CONNECTED`), "Price history could not be refreshed." (other failures), "Could not reach the engine." (call rejected) (src/Scoreboard.tsx:43, :67).
- **Controls**:
  - Button "Refresh prices" (shows "Refreshing…" and is disabled while busy or while the main process is refreshing) (src/Scoreboard.tsx:47).
  - Link button "Show decision table" / "Hide decision table" (src/Scoreboard.tsx:66).
  - Hover on the bars (src/Scoreboard.tsx:28).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getScoreboard()` (src/Scoreboard.tsx:41) | `scoreboard:get` (electron/preload.cjs:49) | main.cjs:680 | starts `refreshDecisionCloses()` and `refreshBenchmarks()` when older than 6 h; replies `scoreboardState()` = `automation.scoreboard.build()` plus `pricesUpdatedAt`, `pricesError`, `refreshing`, `benchmarkUpdatedAt` (main.cjs:678; electron/scoreboard.cjs:94) |
| `refreshScoreboard()` (src/Scoreboard.tsx:43) | `scoreboard:refresh` (electron/preload.cjs:50) | main.cjs:681 | awaits `refreshBenchmarks()` then `refreshDecisionCloses()`; the latter fetches daily bars (`company-chart`, `daily_technicals`) for up to 14 pending symbols and calls `automation.scoreboard.saveCloses` (main.cjs:673-676) |

  - Reply wrapper `scoreboardAction`: `{ok:true,state}` or `{ok:false,error}` with the thrown code or `SCOREBOARD_FAILED` (main.cjs:679). A failed price fetch is kept as `pricesError` (code or `PRICE_HISTORY_FAILED`) and shows only as " · last refresh failed" (main.cjs:676; src/Scoreboard.tsx:60).
- **Subscriptions**: A timer re-reads `scoreboard:get` every 30000 ms, or every 2000 ms while `state.refreshing` is true (src/Scoreboard.tsx:41). Main side: a 10-minute check refreshes decision closes when older than 6 h (main.cjs:677).
- **Saved state**: None from the screen. The refresh stores closes through `automation.scoreboard.saveCloses` (main.cjs:675). The decision-table toggle is component state (src/Scoreboard.tsx:38).
- **Notes**: Horizons `[1,5,20]`, primary 5, minimum sample 5 (electron/scoreboard.cjs:4). Excess prints with sign and two decimals; a value within ±0.00005 has no tone (src/Scoreboard.tsx:11-13).

### ActivityReport, profit mode ("Realized performance")

- **Purpose**: The KIS realized profit-and-loss report for a date range, under the Performance tab (src/main.tsx:145; src/ActivityReport.tsx:92).
- **Component files**: `src/ActivityReport.tsx` exports `ActivityReport` (src/ActivityReport.tsx:41). Mounted at src/main.tsx:145 with `mode="profit"`, keyed `Performance:<market source>:<connectionId>`, so it remounts per tab and connection.
- **What it shows**:
  - Heading "Realized performance" with badge "READ ONLY" (src/ActivityReport.tsx:92).
  - Period line (aria "Report period"): "KIS `<ENVIRONMENT>` · `<start>` through `<end>` · Updated `<time>` KST" + " · another period than the dates above" when the rows are of another range (src/ActivityReport.tsx:92).
  - One-line description "Realized profit as KIS reports it, not total return." (src/ActivityReport.tsx:93).
  - Tiles: "KIS realized P&L" ("Broker-reported period total"); "KIS fees / taxes" ("Not deducted again"); "KIS reported return" (x.xx% or "Unavailable"; "Broker trade-report basis") (src/ActivityReport.tsx:102).
  - Section "Daily reported realized P&L": a bar chart (aria "Daily realized profit and loss") with one bar per trading date, first and last dates under it; or "No realized-P&L records in this period."; note "Bars sum returned report rows by trading date. Days without records are omitted. Full portfolio returns require equity and external cash-flow history." (src/ActivityReport.tsx:102).
  - Table columns: "Trade date (KST)", "Company" (name and symbol), "Realized P&L", "Fees", "Taxes" (src/ActivityReport.tsx:102). All amounts print in KRW; a null prints "Unavailable" (src/ActivityReport.tsx:9, :102).
  - Not connected: "Connect KIS to see order history." (src/ActivityReport.tsx:92).
- **Controls**: Date inputs "From" (aria "Report start date") and "Through" (aria "Report end date"), button "Refresh" / "Refreshing…", disclosure "More" (profit text: "Broker-reported realized profit and loss, not total portfolio return. Fees and taxes are shown separately and not subtracted again. Deposits, withdrawals, dividends and unrealized changes are not in this report." and "It opens with the last report read and refreshes by itself when it is older than five minutes.") (src/ActivityReport.tsx:92-100). Behaviour is the same as in orders mode; see the Activity tab.
- **Calls and channels**: `getActivity('profit',…)` → `kis:activity` and `getActivityCached('profit')` → `kis:activity-cached`; see the Activity tab table. For `profit` the handler calls `kisService.request('profit',{startDate,endDate})` → worker `client.getActivity('profit',…)` (main.cjs:811; electron/kis-worker.cjs:72-73).
- **Subscriptions**: none of its own in profit mode (the Today strip is orders-only, src/ActivityReport.tsx:101).
- **Saved state**: Renderer session memory `report:profit:start`, `report:profit:end` (plus unused `report:profit:query`, `:side`, `:status`) (src/ActivityReport.tsx:42-51). Main side: the last report in table `activity_last`, row `profit` (electron/activity-cache.cjs:9, :14-15).
- **Notes**: The error table is shared with orders mode (see Activity tab). `FEATURE_UNAVAILABLE` reads "This version supports realized-P&L reports for live accounts only." (src/ActivityReport.tsx:19).

## Activity tab

- **Purpose**: Read-only order history of both markets for a date range as KIS reports it, with totals, where each order came from, orders the app did not send, and a "Today" strip from the app's own records (src/ActivityReport.tsx:92-101).
- **Component files**: `src/ActivityReport.tsx` exports `ActivityReport` and `TodayStrip` (src/ActivityReport.tsx:30, :41); helpers `executionSummary`, `dailyRealized`, `seoulDate` in `src/activity.mjs` (src/activity.mjs:6, :16, :22). Mounted at src/main.tsx:145 with `mode="orders"`, `connected={isKis}`, keyed `Activity:<market source>:<connectionId>`; `loadReport` wraps `window.portfolio.getActivity` (fallback `{ok:false,error:'NOT_CONNECTED'}`) and `loadCached` wraps `getActivityCached` (src/main.tsx:145).

### ActivityReport, orders mode ("Orders and execution summaries")

- **Purpose**: The period list and its totals (src/ActivityReport.tsx:92, :101).
- **Component files**: src/ActivityReport.tsx:41 `ActivityReport`.
- **What it shows**:
  - Heading "Orders and execution summaries" with badge "READ ONLY" (src/ActivityReport.tsx:92).
  - Not connected: "Connect KIS to see order history." (src/ActivityReport.tsx:92).
  - Error alert (only when nothing is on screen) and a status line (aria "Refresh status") when rows stay on screen: "Not refreshed: `<why>`. Showing the list read at HH:MM." or, with nothing loaded yet, "Not loaded yet: `<why>`. Use Refresh in a moment." (src/ActivityReport.tsx:59, :64-66, :92).
  - Period line (aria "Report period"): "KIS `<ENVIRONMENT>` · `<start>` through `<end>` · Updated `<time>` KST" + " · another period than the dates above" (src/ActivityReport.tsx:92).
  - One-line description (aria "About this report"): "Orders in both markets, newest first. Totals are what KIS reports." (src/ActivityReport.tsx:93).
  - Today strip (when connected): see TodayStrip (src/ActivityReport.tsx:101).
  - Three tiles (src/ActivityReport.tsx:101): "Gross purchases" ("Reported execution amounts"), "Gross sales" ("Reported execution amounts"), "Sales minus purchases" ("Gross trading cash flow · not profit"). With U.S. orders each shows "`<KRW>` · `<USD>`"; currencies are never added (src/ActivityReport.tsx:10-11, :16). A side with an executed row whose amount KIS did not report shows "Not reported for N order(s)" (src/ActivityReport.tsx:15; src/activity.mjs:11-12).
  - Line (aria "Corrected orders"): "Includes N corrected order(s)." and/or "N corrected order(s) not included: KIS reports more filled shares than the order had." (src/ActivityReport.tsx:101).
  - Table (class `activity-orders`) columns: "Order / company", "Order time (KST)", "Side / status", "From", "Ordered / executed", "Remaining", "Average execution", "Executed amount" (src/ActivityReport.tsx:101). Cell contents: name in bold with "U.S. · " (U.S. rows), symbol, " · #`<order number>`", " · Original #`<number>`"; time in Seoul time; side with status and " · `<reason>`"; origin label with detail under it (tooltip = detail), "—" when none; "quantity / filled"; remaining; average price or "—" when nothing filled; executed amount in the order's currency (src/ActivityReport.tsx:101). Not-sent rows are greyed (class `muted not-sent`) (src/ActivityReport.tsx:101).
  - Empty: "No matching order records in this period." (src/ActivityReport.tsx:101).
  - Notice "U.S. orders could not be loaded (`<CODE>`); Korean orders are shown." when the U.S. part failed (src/ActivityReport.tsx:101; main.cjs:813-814).
- **Controls**:
  - Date input "From" (aria "Report start date"): min = 60 days ago (Seoul), max = the end date; disabled while busy (src/ActivityReport.tsx:92).
  - Date input "Through" (aria "Report end date"): min = the start date, max = today (Seoul); disabled while busy (src/ActivityReport.tsx:92).
  - Changing either date loads the new period at once as an automatic read, if start ≤ end (src/ActivityReport.tsx:79-83).
  - Button "Refresh" (primary; "Refreshing…" while busy): a manual read; disabled while busy, when not connected, or when a date is empty (src/ActivityReport.tsx:92).
  - Disclosure "More" (aria "About this report: more") with four paragraphs: what a row is and how corrected orders count; the "From" labels ("AI review (sent automatically or approved by you, for orders made with 1.5.69 or later), Stop or Take profit, You in the app (your order ticket), Changed outside the app (an app order revised elsewhere), Outside the app (no app record), or The app (an older app order with no record of how it was made)"); "Not sent: orders the app decided but that never reached KIS, with the reason. They are greyed and never in the totals. Today lists the app's own orders from its records, before KIS answers."; and the automatic refresh rule (src/ActivityReport.tsx:94-98).
  - Toggle buttons "Orders (N)" and "Execution totals (N)": the second shows only rows with a filled quantity (src/ActivityReport.tsx:89, :101).
  - Search input (aria "Search orders", placeholder "Company, symbol, or order number"): filters by name, symbol or order number, case-insensitive (src/ActivityReport.tsx:89, :101).
  - Select (aria "Order side"): "All", "Buy", "Sell" (src/ActivityReport.tsx:101).
  - Select (aria "Order status"): "All" plus every status present in the loaded rows (src/ActivityReport.tsx:101).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | What it calls |
|---|---|---|---|
| `getActivityCached(kind)` (src/main.tsx:145; src/ActivityReport.tsx:71) | `kis:activity-cached` (electron/preload.cjs:85) | main.cjs:799 | `activityCache.get(kind,accountKey)` (electron/activity-cache.cjs:11); `{ok:true,data}` or `{ok:false}` |
| `getActivity(kind,start,end,options)` (src/main.tsx:145; src/ActivityReport.tsx:61) | `kis:activity` (electron/preload.cjs:84) | main.cjs:800-825 | `validateRange` (electron/kis-activity.cjs:8); `kisService.request(kind,{startDate,endDate})` → worker `client.getActivity` (electron/kis-worker.cjs:72-73); for `orders` also `kisService.request('us-order-history',…)` → `us.orderHistory` (electron/kis-worker.cjs:35), then `activity-chains.cjs` `markChains` and `activity-origin.cjs` `labelRows` (main.cjs:813-820); `activityCache.put` (main.cjs:822) |
| `getActivityToday()` (src/ActivityReport.tsx:32) | `activity:today` (electron/preload.cjs:86) | main.cjs:795-798 | `activity-today.cjs` `today({intents,reviews,conditionals})` (electron/activity-today.cjs:52) with `order-origin.cjs` `reviewIdRows` and `conditionalRows` (electron/order-origin.cjs:30, :40); no KIS request (main.cjs:793) |

  - `kis:activity` replies (main.cjs:802-824): `{ok:false,error:'NOT_CONNECTED'}`; for an automatic read `{ok:false,error:'SKIPPED',skipped:'order'|'review'|'account'}` (order being sent, review running, account request running; electron/activity-cache.cjs:20); `BUSY`; `INVALID_REQUEST` (kind not `orders`/`profit`); `CONNECTION_CHANGED`; otherwise `kisErrorCode(error)`, one of `INVALID_CREDENTIAL_FILE`, `INVALID_RESPONSE`, `AUTH_FAILED`, `RATE_LIMITED`, `REQUEST_FAILED`, `BROKER_REJECTED`, `INCOMPLETE_BALANCE`, `BROKER_UNAVAILABLE`, `BUSY`, `INCOMPLETE_HISTORY`, `INVALID_DATE_RANGE`, `FEATURE_UNAVAILABLE` (main.cjs:68-71).
  - Date-range rule (`INVALID_DATE_RANGE`): both dates `YYYY-MM-DD`, start ≤ end, end ≤ today (Seoul), start no more than 60 days before today (electron/kis-activity.cjs:8-16).
- **Subscriptions**: On mount (once per tab and connection): read the cached report, show it, then an automatic refresh when there is no cache, it is older than 5 minutes (`FRESH_MS`), or it is of another period (src/ActivityReport.tsx:23, :69-78). A request counter drops replies that arrive after a newer request or after unmount (src/ActivityReport.tsx:53, :58, :62, :75). No repeating timer in the report itself.
- **Saved state**: Renderer session memory (`useDraftState`): `report:orders:start` (default 29 days ago, Seoul), `report:orders:end` (today), `report:orders:query`, `report:orders:side` ("All"), `report:orders:status` ("All") (src/ActivityReport.tsx:42-51). "Execution totals" toggle is component state (src/ActivityReport.tsx:52). Main side: the last successful report per kind is kept in memory and in table `activity_last` (one row per kind, with the account) and survives restarts; a read for another account clears it (electron/activity-cache.cjs:1-16).
- **Notes**:
  - Error-code table `errors` (src/ActivityReport.tsx:19); any other code shows "The report request failed. Retry or reconnect." (src/ActivityReport.tsx:65-66):

| Code | Text |
|---|---|
| `NOT_CONNECTED` | "Connect your KIS account first." |
| `BUSY` | "An account request is running. Try again shortly." |
| `INVALID_DATE_RANGE` | "Choose valid dates within the last 60 days, ending today or earlier." |
| `FEATURE_UNAVAILABLE` | "This version supports realized-P&L reports for live accounts only." |
| `INCOMPLETE_HISTORY` | "The complete report could not be retrieved. Narrow the date range and retry; no partial report is shown." |
| `BROKER_REJECTED` | "KIS rejected the report request. Check account permissions." |
| `RATE_LIMITED` | "KIS rate limit reached. Wait before retrying." |
| `AUTH_FAILED` | "KIS authentication failed. Reconnect your account." |
| `CONNECTION_CHANGED` | "Your connection changed. Load the report again." |
| `INVALID_RESPONSE` | "KIS returned an unexpected report format." |

  - Skip-reason table `SKIPPED` (src/ActivityReport.tsx:21; the same texts as `SKIP_TEXT`, electron/activity-cache.cjs:21): `order` → "an order is being sent"; `review` → "an AI review is running"; `account` → "another account request is running"; unknown → "the account is busy" (src/ActivityReport.tsx:64).
  - When rows are on screen, an error is folded into the status line: the sentence loses its final period and its first letter is lower-cased when followed by a lower-case letter (so "KIS …" stays) (src/ActivityReport.tsx:65).
  - Totals (`executionSummary`, src/activity.mjs:6-15): every row with a filled quantity is summed, including corrected rows; rows marked `chainOverfill` are left out and counted once per chain; not-sent rows are removed before totals (src/ActivityReport.tsx:86-88).
  - "From" labels (electron/order-origin.cjs:14-24; electron/activity-origin.cjs:20-21):

| Mark on the app's order | Label |
|---|---|
| `madeBy==='ticket'` | "You, in the app" |
| `madeBy==='review'` | "AI review", plus " · sent automatically" (`sentBy==='auto'`) or " · approved by you" (`sentBy==='you'`) |
| `madeBy==='conditional'` | "Stop" (`purpose` `stop_loss`), "Take profit" (`take_profit`), else "Conditional order" |
| no `madeBy`, matched to a review record | "AI review" |
| no `madeBy`, matched to a conditional order | "Stop" / "Take profit" / "Conditional order" |
| no mark, or no id | "The app" |
| KIS row that revises an app order but was not created by the app | "Changed outside the app", detail "a revision of the app's order (`<label>`)" |
| KIS row with no app record | "Outside the app", detail "KIS channel: `<channel>`" when KIS gives one |

  - Not-sent rows added to the list (electron/activity-origin.cjs:23-25): app orders with no broker order id, created inside the period, whose state is `notSent`; they carry status "Not sent", filled 0, the reason in words and their origin label.
  - Order rows from Korea are tagged `market:'KR'`, `currency:'KRW'`; the merged list is sorted newest first (main.cjs:814; electron/activity-origin.cjs:26).

### TodayStrip ("Today")

- **Purpose**: Today's app orders by what happened to them, and the latest five, from the app's own records, shown before KIS answers (electron/activity-today.cjs:1-4).
- **Component files**: `TodayStrip` in src/ActivityReport.tsx:30; rendered in orders mode when connected (src/ActivityReport.tsx:101).
- **What it shows**:
  - Heading "Today" with "The app's orders · from its records" (src/ActivityReport.tsx:37).
  - Counts line (aria "Today counts"): "N order(s): N filled, N partly filled, N open, N waiting for you, N not sent, N rejected, N canceled." (only non-zero parts), or "No orders from the app today." (src/ActivityReport.tsx:36, :38).
  - List (aria "Latest orders") of up to five rows: time (HH:MM Seoul), "`<side>` `<quantity>` `<symbol>`", "`<label>` · `<reason>`", and the origin label; a not-sent row is greyed (src/ActivityReport.tsx:39; electron/activity-today.cjs:56).
  - Renders nothing until a reply with counts arrives (src/ActivityReport.tsx:35).
- **Controls**: none (src/ActivityReport.tsx:37-39).
- **Calls and channels**: `getActivityToday()` → `activity:today` (see the table above). On failure the handler returns `{ok:false}` and the strip keeps what it shows (main.cjs:798; src/ActivityReport.tsx:32).
- **Subscriptions**: `subscribeRuntime` (the shared 2-second `getRuntime` poll, src/runtimeFeed.ts:14-17); the strip re-reads at most every 10 seconds (src/ActivityReport.tsx:32-33).
- **Saved state**: none; read-only.
- **Notes**:
  - State labels (`stateOf`, electron/activity-today.cjs:41-50): "Filled"; "Rejected by KIS" (status Rejected with reason `BROKER_REJECTED`); "Not sent" + reason (other Rejected, or a Ready order past its expiry); "Partly filled (N of M)"; "Partly filled (N of M), open"; "Open" (status Accepted) or the raw status for other open states (`Submitting`, `Uncertain`, `Partially filled`, `Cancellation uncertain`, electron/activity-today.cjs:6); "Waiting for your approval" (Ready, not expired); "Canceled"; otherwise the raw status or "Unknown".
  - Today is the Seoul calendar day of the order's `createdAt` (electron/activity-today.cjs:39, :53). `sent` counts orders with a broker order id; it is not displayed (electron/activity-today.cjs:55; src/ActivityReport.tsx:36).
  - Reason-code table `NOT_SENT` (electron/activity-today.cjs:8-36): about 73 codes (not machine-counted; every key read is listed below). An unknown code is shown as the code in lower case with spaces (electron/activity-today.cjs:38, :45). For reason `ORDER_NOT_SENT` the text comes from `notSentCause`, else "it could not be sent" (electron/activity-today.cjs:45). Full table:

| Code | Text |
|---|---|
| `ticket-expired`, `TICKET_EXPIRED` | "the check with KIS expired before it was sent" |
| `rate-limit`, `RATE_LIMITED` | "the KIS request limit was reached" |
| `SESSION_CLOSED` | "the market was closed" |
| `CREDIT_PATH_UNVERIFIED` | "its credit path is not verified" |
| `INTEGRATED_MARGIN_AUTOMATION_BLOCKED` | "automatic U.S. purchases were off then (integrated margin not verified)" (old records only; no longer thrown since 1.5.69) |
| `APPROVAL_REQUIRED` | "it needed your approval" |
| `SUPERSEDED` | "a newer order replaced it" |
| `EXPIRED` | "it expired unapproved" |
| `PRODUCT_APPROVAL_REQUIRED` | "this product needs your approval" |
| `EXTENDED_APPROVAL_REQUIRED` | "an extended-session order needs your approval" |
| `EXTENDED_SIZE_LIMIT` | "it is above the extended-session size limit" |
| `BROKER_ORDER_MISMATCH` | "KIS reported a different order" |
| `BROKER_REJECTED` | "KIS rejected it" |
| `CONCENTRATION_LIMIT` | "it would go over the per-company limit" |
| `DAILY_TURNOVER_LIMIT` | "the day's turnover limit is reached" |
| `DAILY_LOSS_RESTRICTED` | "the daily loss limit restricts new purchases" |
| `EXCEEDS_LOT` | "it is more than the shares free in its lot" |
| `NO_SUCH_LOT` | "its lot was not found" |
| `FEATURE_UNAVAILABLE` | "this account does not offer it" |
| `INSTRUMENT_NOT_ALLOWED` | "this stock is not allowed for automatic orders" |
| `INSUFFICIENT_CAPACITY` | "there was not enough buying power" |
| `INVALID_INSTRUMENT` | "the stock code was not valid" |
| `INVALID_ORDER` | "the order was not valid" |
| `KIS_ORDER_BUSY` | "another order was being sent" |
| `LEVERAGED_EXPOSURE_LIMIT` | "it would go over the leveraged-product limit" |
| `LEVERAGED_NOT_ENABLED` | "leveraged and inverse products are off" |
| `LIMIT_CHANGED` | "its limits changed while it was being sent" |
| `MARGIN_LIMIT` | "it would go over the margin limit" |
| `MARGIN_NOT_ENABLED` | "margin trading is off" |
| `SHORT_LIMIT` | "it would go over the short-selling limit" |
| `SHORT_NOT_ENABLED` | "short selling is off" |
| `OPEN_BROKER_ORDERS` | "another order for it is open at KIS" |
| `ORDER_NOT_SENT` | "it could not be sent" |
| `ORDER_SIZE_LIMIT` | "it is above the order size limit" |
| `ORDER_UNCERTAIN` | "KIS's reply was unclear, so it is not confirmed" |
| `PRICE_MOVED` | "the price moved past its limit" |
| `RECONCILIATION_REQUIRED` | "open orders must be confirmed with KIS first" |
| `FX_STALE` | "the exchange rate was too old" |
| `FUNDING_BALANCE_STALE` | "the cash reading was too old to check its funding" |
| `STALE_DECISION` | "the account or saved settings changed during the review" |
| `AUTO_TRADING_STOPPED` | "automatic trading was stopped" |
| `SEVERAL_OPEN_OFF` | "several open orders was turned off" |
| `BATCH_LIMIT` | "the batch limit (5 minutes from the decision) passed" |
| `ACCOUNT_CHANGED` | "another KIS account was connected" |
| `ACTIVATION_REQUIRED` | "trading for this market is not switched on" |
| `AUTH_FAILED` | "KIS sign-in failed" |
| `AUTO_KIS_DISABLED` | "automatic orders are off for this market" |
| `BROKER_UNAVAILABLE` | "the KIS connection stopped" |
| `DAILY_SESSION_SETUP_REQUIRED` | "today's trading session is not set up yet (switch the market's trading on again)" |
| `DISABLED_OR_EXPIRED` | "trading was switched off or the order expired (2 minutes after it was made)" |
| `FUNDING_OVERCOMMITTED` | "KIS reported more shares filled than the app held funds for, so new buys stop until that is reviewed" |
| `INCOMPLETE_BALANCE` | "KIS returned an incomplete balance" |
| `US_BALANCE_INVALID_RESPONSE` | "KIS returned a U.S. balance the app cannot read" |
| `INVALID_RESPONSE` | "KIS returned a reply the app cannot read" |
| `REQUEST_FAILED` | "a KIS request failed" |
| `INVALID_CREDENTIAL_FILE` | "the KIS key file could not be read" |
| `INVALID_LIMITS` | "the saved limits are not valid" |
| `INVALID_SETTINGS` | "the saved settings are not valid" |
| `KIS_NOT_CONNECTED` | "KIS is not connected" |
| `KIS_TRADING_DISABLED` | "trading for this market is switched off" |
| `NO_FUNDED_BALANCE` | "the account has no cash or holdings" |
| `RISK_DATA_UNAVAILABLE` | "the risk data could not be read" |
| `INCOMPLETE_HISTORY` | "KIS returned an incomplete order history" |
| `INVALID_DATE_RANGE` | "the date range is not valid" |
| `INVALID_RELEASE` | "a funding release was not valid" |
| `INVALID_REQUEST` | "the request was not valid" |
| `ORDER_NOT_OPEN` | "the order is no longer open" |
| `ORDER_TAKEN_OVER` | "the order was changed outside the app" |
| `TRACKING_STOPPED` | "its tracking was stopped" |
| `UNKNOWN_ORDER` | "the order was not found" |
| `UNKNOWN_PROPOSAL` | "the proposal was not found" |

  The same table is exported as `reasonText` for other screens (electron/activity-today.cjs:38, :59) and is used for the not-sent rows of the period list through `stateOf` (electron/activity-origin.cjs:9, :23).

## KIS trading ("Korea") and U.S. stocks ("U.S.")

One component serves both tabs. The U.S. tab passes `market="US"`; everything below applies to both unless marked "KR only" or "US only".

- **Purpose**: Activate a trading session for the connected KIS account (per app run), set the stock list, optional caps and the emergency loss trigger, turn automatic order submission on or off, place a manual limit-order ticket, approve "Ready" orders, and watch/repair order status. The U.S. tab also shows the U.S. account balance and holdings (LT:37-43).

- **Component files**:
  - `src/LiveTrading.tsx`, export `LiveTrading({draftKey='kis',market='KR'})` (LT:14). Also exports types `LivePolicy`, `LiveState`, `LiveReply` (LT:11-13).
  - Mounted at `src/main.tsx:149` for tab 'KIS trading' with `key={market?.connectionId??'disconnected'}` and `draftKey="kis:<connectionId>"`; at `src/main.tsx:147` for tab 'U.S. stocks' with `key={'us:'+connectionId}`, `market="US"`, `draftKey="us:<connectionId>"`. A change of connection remounts the component and switches the draft namespace (inferred from the `key`).
  - Children: `MarketStatus` (LT:44, `markets={[market]}`; documented elsewhere), `SymbolField` and `OrderQuote` (`src/SymbolField.tsx:4`, `:19`), `MoneyField` (`src/MoneyField.tsx:11`), `TickDelta` (`src/LiveValue.tsx:7`), `Note` (`src/Note.tsx:3`), `SaleCosts` from `src/TradingCosts` (LT:8, LT:80; not read here), `toast` (`src/Toast.tsx:5`).

- **What it shows**:
  - Before the first reply: "Loading trading controls…" (LT:30).
  - **Card "U.S. account"** (US only, LT:37-43):
    - Heading "U.S. account" (LT:37).
    - If `state.portfolio` exists: a summary strip with "Total equity" (label becomes "Last known equity" when `state.refreshError` is set) showing `$` + `reportedTotal` with 2 decimals and a `TickDelta` (LT:38); "Cash" (`$` cash) (LT:38); "Pending settlement" only when `pendingSaleProceeds>0`, with tooltip "Money from sales that has not settled yet. It counts in total equity; it can be spent once it settles." (LT:38); "Updated" with the snapshot's local time (LT:38).
    - Table with columns "Stock", "Shares", "Price", "Value" (one row per holding; price and value to 2 decimals) (LT:39).
    - Empty state: "Connect KIS, then refresh to load U.S. balances." (LT:39).
    - Error line (role status, class error): `usErrorMessage(state.refreshError)` plus " · HTTP <status>" and " · Broker reference <code>" when present (LT:40).
    - "Some quotes are unavailable." when `state.warnings` is non-empty (LT:40).
    - Note, summary "NASDAQ, NYSE and AMEX · whole-share limit orders"; body "Home combines Korean and U.S. holdings using the displayed exchange rate. Both sessions can be active together. Regular-session, whole-share limit orders at $1 or above. Prices are broker snapshots and may be delayed by your data entitlement." (LT:41).
    - While fills settle: "<n> fill(s) settling (up to 3 business days)" (aria-label "Fills settling") (LT:43).
  - `TickDelta` (`src/LiveValue.tsx:7-18`): shows "No change yet" (tooltip "Shows the next change in this total as prices, fills or cash update") until the value changes; then "Last change", an arrow ▲/▼, the signed amount, the percent (or "<0.01%"), and the time; tooltip "Last change at <time>: <amount> (<pct>), from prices, fills, fees or cash". It stays until the next change (`src/LiveValue.tsx:5-6` comment).
  - **Market status strip**: `<MarketStatus markets={[market]}/>` (LT:44).
  - **Card "Trading session"** (LT:45-60):
    - Heading "Trading session", sub-line "The AI follows your guidelines in Engine settings." (LT:45).
    - State pill: "Off" when not enabled; "Auto · live" / "Auto · mock" when automatic is on; "On · live" / "On · mock" otherwise (LT:33, LT:45). `environment` is "LIVE" when `state.environment==='live'`, else "MOCK" (LT:31).
    - Fields: see Controls.
    - Loss lines: "Daily loss check unavailable: its data could not be read. New buys are restricted until it can be checked." when `state.loss.unavailable` (tooltip = reasons) (LT:52). "Today's loss is measured from later in the day: the opening value could not be read, so a loss before then is not included." plus, when `restrictedForDay`, " Automatic new buys stay restricted for the rest of the day; sales are not affected." (aria-label "Late daily-loss basis") (LT:53). "Today <sign><loss> (<pct>%) · trigger <sign><limit>" plus " · emergency mode" when breached (error style when breached) (LT:54). `sign` is "₩" or "$" (LT:15).
    - When automatic is on: "Automatic orders are on" (LT:57).
    - Status message line (role status) with the last action's result: "Completed." or the failure text (LT:21, LT:58).
    - Note, summary "How sessions work"; body "Trading follows your saved guidelines while the app is open; new sessions need activation and daily baselines update automatically. Automatic submission must also be on in Engine settings. Reviews can run after hours with closing data; orders need fresh broker checks during market hours. A blank stock list lets the AI consider your holdings and watchlist. Keys stay in the private broker process." (LT:59).
  - **Card "New order"** (LT:61-74): heading "New order"; the ticket (see Controls); an `OrderQuote` line; "Activate the session to create orders." when the session is off (LT:72); for a KR credit order type, a Note with summary "Needs a live account with a KIS credit agreement." and body "Credit orders need a live account with a KIS credit agreement and must be allowed under Settings → Short & leverage. Repayment orders use the loan date shown in your balance." (LT:73).
    - `OrderQuote` (`src/SymbolField.tsx:19-26`): for a valid symbol it shows the company name in bold, " · <price> <±change%> · " a link button "Use as limit price", and " · about <price×qty> for <n> share(s)"; or " · no price right now" when no price. Renders nothing until the quote loads or when the symbol is not valid (`src/SymbolField.tsx:21-23`).
  - **Card "Orders"** (LT:75-86): heading "Orders" with the count; empty state "No orders yet." (LT:76). It is a list (`ul.order-list`), not a table. Each row (LT:77-84):
    - Side tag ("Buy"/"Sell"), symbol in bold, "<quantity> @ <sign><limitPrice>" (LT:77).
    - Credit badge: "margin", "margin repay", "short sale", "short cover" (map `creditName`, LT:35, LT:77).
    - Status text, plus " · <filled>/<quantity>" on a partial fill (LT:77). Row tone by status: Ready=action, Filled=done, Accepted / Partially filled / Submitting=live, Uncertain=warn, Rejected=bad, Canceled / Expired=muted (LT:34).
    - "Waiting for your approval" when `requiresApproval` and status is Ready (LT:79).
    - A `SaleCosts` block for `resultCosts ?? costEstimate` (LT:80).
    - "Broker #<brokerOrderId>" and the order's `reason` text (LT:81).
    - For Accepted / Partially filled (aria-label "Order tracking"): "Taken over by you in KIS; the app no longer moves it" | "Tracking paused: <reason>" | "Cancelling" | "Following the best bid" (Sell) / "Following the best ask" (Buy); then optional " · now <sign><currentPrice>", " · revised <n>×", " · floor <bound>" (Sell) / " · cap <bound>" (Buy), " · cancels <time>" (LT:82).
    - `closedReason` with its first letter capitalised (LT:83), e.g. "Expired at the session end" (LE:453).
    - For Uncertain / Submitting: the link form (see Controls) (LT:84).
  - There is no separate "proposals" table: a proposal is an order row with status "Ready" (LE:130 `status:'Ready'`; LT:78).

- **Controls**:
  - "Refresh U.S. account" button (US only): calls `refresh`; disabled while busy (LT:37).
  - "Stocks the AI may trade" text input (aria-label "Allowed stock codes"); placeholder "Blank = holdings · 005930, 000660" (KR) or "Blank = holdings · NASD:AAPL, NYSE:IBM" (US) (LT:47). Comma-separated. Client check: at most 20 codes, each six digits (KR) or `NASD:|NYSE:|AMEX:` + ticker (US); error text "Use up to 20 six-digit stock codes, or leave blank for your holdings." / "Use NASD:AAPL, NYSE:IBM or AMEX:SPY (up to 20), or leave blank for holdings." (LT:23-24).
  - "Emergency loss trigger" select: "Off", "KRW amount" / "USD amount", "Percent" (LT:48).
  - "Trigger at (%)" number input (aria-label "Loss tolerance", min 0.01) or "Trigger at (KRW|USD)" `MoneyField` (label "Loss tolerance"); shown only when the trigger is not Off (LT:49).
  - Disclosure "Caps · optional" (LT:51) with: "Maximum order (KRW|USD)" (MoneyField, placeholder "No cap"), "Daily turnover (KRW|USD)" (MoneyField, placeholder "No cap"), "Maximum company allocation (%)" (number input, min 1, placeholder "No cap").
    - Client validation (LT:25): blank cap = no cap; percent fields "Enter a percentage above 0 and up to 100."; amount fields "Enter a whole KRW|USD amount from 1 to 1,000,000,000." On any error: message "Check the highlighted fields." and nothing is sent (LT:26).
  - Switch "Enable trading for this LIVE|MOCK account" (the consent switch) (LT:55).
  - Button "Activate for this session" (primary): disabled while busy, when there is no `state.environment` (no connection), or when the consent switch is off (LT:56). It sends `configure` with `{symbols, maxOrderKRW, maxDailyTurnoverKRW, maxCompanyPct, lossLimit}` and the phrase `ENABLE LIVE` or `ENABLE MOCK` (LT:28). The phrase is NOT typed by the user: the renderer builds it from the environment once the switch is on; the engine compares it to the connection's environment (LE:33). Toast on result: "Trading session settings saved" or "Not saved: <failure>"; on a thrown call "Not saved: could not reach the engine" (LT:21).
  - Button "Stop new orders": calls `stop`; disabled while busy or when the session is not enabled (LT:56). This is the session's emergency stop: the engine sets `enabled=false` and `autoEnabled=false` (LE:65). It does not cancel orders already at KIS (inferred: `stop()` only clears the two flags, LE:65).
  - Button "Refresh order status": calls `reconcile`; disabled while busy or with no connection (LT:56).
  - Automatic execution row, shown only while the session is enabled (LT:57):
    - Off state: switch "Allow automatic LIVE|MOCK orders" and button "Enable automatic execution" (disabled while busy or until the switch is on). Sends `auto` with the phrase `ENABLE AUTO LIVE` / `ENABLE AUTO MOCK` (built by the renderer; checked at LE:66).
    - On state: text "Automatic orders are on" and button "Stop automatic execution" → `auto-off` (main:712 sets `live.autoEnabled=false`).
    - **U.S. tab only** (since 1.5.69, the U.S. buy block removed): the switch reads "Allow automatic LIVE|MOCK orders: buys and sales the AI decides are sent without asking you", and the on state "Automatic orders are on: buys and sales". Below it, while the session is enabled: "U.S. buys are counted against your won cash. Limits: maximum order …, daily turnover …, per company …, daily loss …" (each "$x", "x%" or "not set"/"off", from the saved U.S. policy, `usLimits`), with More: the two checks (KIS buying power capped at real cash; Korean won cash at the rate plus 2% with open Korean buys), that dollar cash adds no room under the won rule, and that pre- and after-market buys still wait for approval.
  - New order ticket (LT:62-70):
    - "Stock": `SymbolField` (aria-label "KIS order symbol"), a combobox; placeholder "Code or name (005930, 삼성전자)" (KR) / "Ticker or name (NASD:AAPL)" (US). Typing searches after 180 ms and lists up to 8 matches (name, "<symbol> · <TYPE>"); arrow keys, Enter, Escape, click to choose; a fully typed valid code is accepted at once (`src/SymbolField.tsx:7-15`).
    - "Order type" select (KR only, aria-label "KIS order type"): "Cash", "Margin buy (신용매수)", "Sell margin shares (신용상환)", "Short sell (대주매도)", "Cover short (대주상환)". Choosing a credit type forces the side: Buy for margin-buy and cover, Sell otherwise (LT:64).
    - "Side" select: "Buy" / "Sell"; disabled on KR when the order type is not Cash (LT:65).
    - "Loan date" date input (aria-label "KIS loan date"): KR only, for "margin-sell" and "cover" (LT:66).
    - "Shares" number input, min 1 (LT:67).
    - "Limit price (KRW|USD)" `MoneyField` (label "Limit price") (LT:68).
    - "Create proposal" (primary): disabled while busy, when the session is off (tooltip "Activate the session first"), or when a KR repay/cover order has no loan date (LT:69). Sends `propose` with `{symbol, side, quantity, limitPrice}` plus `credit:{kind, loanDate?}` for KR credit orders (LT:69).
    - Link button "Use as limit price" in the quote line: copies the current price into the limit price (`src/SymbolField.tsx:25`, LT:71).
  - Per order row:
    - "Approve LIVE order" / "Approve MOCK order" (primary), only for status Ready; disabled while busy or when the session is off. Sends `submit` with the order id and the phrase `PLACE LIVE ORDER` / `PLACE MOCK ORDER` (LT:78; checked at LE:144). No confirm dialog and no typed phrase.
    - For Uncertain / Submitting rows: input "Verified broker order number" and button "Link verified order" (disabled while busy or when the input is empty). Sends `link` with the order id, the broker number and the phrase `LINK BROKER ORDER` (LT:84; checked at LE:576). One shared input value serves all such rows (`brokerId` draft, LT:19).
  - `MoneyField` behaviour (`src/MoneyField.tsx:1-5`, `src/money.ts`): text input grouped with commas while typing; KRW whole won, USD two decimals; a read-back line under it ("₩3,000,000 · 300만 원", "$1,234.50"); pastes like "₩3,000,000" or "3000000원" are read; refused input shows "Whole won only", "Two decimals at most", "Too large" or "Couldn’t read “…”: numbers only" (`src/money.ts:60-61`); at most 15 integer digits (`src/money.ts:6`); Ctrl+Z / Ctrl+Y undo and redo (`src/MoneyField.tsx:43`); ArrowUp/ArrowDown do nothing (`src/MoneyField.tsx:46`). The quick-amount buttons (`quick` prop) are not used on these screens (LT:49, 51, 68 pass no `quick`).

- **Calls and channels** (`call(name,...)` picks `usAction` for US, `liveAction` for KR, LT:15):

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method |
|---|---|---|---|
| `liveAction('get')` | `live:get` | main:708 | `live.getState()` (LE:67) |
| `liveAction('configure', value, phrase)` | `live:configure` | main:709 | `live.configure(value, phrase)` (LE:30) |
| `liveAction('stop')` | `live:stop` | main:710 | `live.stop()` (LE:65) |
| `liveAction('auto', phrase)` | `live:auto` | main:711 | `live.enableAuto(phrase)` (LE:66) |
| `liveAction('auto-off')` | `live:auto-off` | main:712 | sets `live.autoEnabled=false`, returns `getState()` |
| `liveAction('propose', command)` | `live:propose` | main:714 | `live.propose(command)` (LE:110), then `live.annotate(id,{madeBy:'ticket'})` (LE:501) |
| `liveAction('submit', id, phrase)` | `live:submit` | main:715 | `live.submit(id, phrase)` → `send(..., {automatic:false})` (LE:135-136) |
| `liveAction('reconcile')` | `live:reconcile` | main:716 | `live.reconcile()` (LE:446) |
| `liveAction('link', id, brokerId, phrase)` | `live:link` | main:717 | `live.linkUncertain(...)` (LE:575) |
| `usAction(name, ...)` for get, refresh, configure, stop, auto, auto-off, propose, submit, reconcile, link | `us:<name>` | main:336 (one loop registers all ten) | `get`: state only; `refresh`: `automation.refreshUS()` (throws `KIS_NOT_CONNECTED` with no KIS snapshot); `auto-off`: `usLive.autoEnabled=false`; `auto`: `usLive.enableAuto`; `link`: `usLive.linkUncertain`; others: `usLive[name](...)`; `propose` is also annotated `madeBy:'ticket'` (main:336) |
| `searchSecurities(q, market)` (SymbolField) | `discovery:search` | main:685 | see Discover |
| `getResearch(symbol,['overview'])` (OrderQuote) | `research:company` | main:446 | not traced here |

  - The preload only forwards the listed names; any other name rejects with `INVALID_REQUEST` (`electron/preload.cjs:10-11`). `liveAction` has no `refresh` (`electron/preload.cjs:11`).
  - Reply shape: `{ok, data, state}` or `{ok:false, error, state}` (main:707, main:336). The KR wrapper passes only codes in its allow-list and replaces others by `KIS_ORDER_FAILED` (main:707). The US wrapper passes its own allow-list, else `publicUSCode(error.message)` which yields `US_REQUEST_FAILED` for unknown codes (main:336, `electron/us-errors.cjs:7`).
  - `usLive` is a second `LiveEngine` built with `{market:'US'}` (main:266); `live` is the Korean one (main:249).

- **Subscriptions**:
  - A 2000 ms `setInterval` polling `get`, with an in-flight guard; cleared on unmount (LT:20).
  - US only: one `refresh` call on mount; a failure sets the message to `usErrorMessage(error)` (LT:20).
  - `SymbolField`: 180 ms debounce timer per keystroke (`src/SymbolField.tsx:8`); `OrderQuote` fetches once per symbol change (`src/SymbolField.tsx:21-22`).
  - No `onMarket` / `onEvents` / `subscribeRuntime` use in this file (LT:1-88).

- **Saved state**:
  - Main side: `configure` writes the policy to SQLite table `live_policy`, one row per `accountKey` (LE:20, LE:49); the U.S. account key is the KIS key + `:US` (main:266). Orders are rows of `live_intents` (LE:20, LE:29).
  - `enabled` and `autoEnabled` are engine memory only and start false on each app run (LE:14); so activation and automatic execution are per session ("new sessions need activation", LT:59).
  - Renderer: all form fields use `useDraftState` keys `<draftKey>:lossMode`, `:symbols`, `:limits`, `:consent`, `:autoConsent`, `:command`, `:brokerId`, `:credit` (LT:17-19). These live in an in-memory Map: kept across tab changes, lost on reload or exit (`src/useDraftState.ts:2`).
  - The form is not pre-filled from the saved policy: the drafts start blank/"off" (LT:17) and nothing copies `state.policy` into them (LT:14-88). Activating with blank fields therefore saves a policy with no caps, an empty list and the loss trigger off (LT:27-28; LE:45).

- **Notes**:
  - **Engine checks on `configure`** (LE:30-48): refuses while busy (`KIS_ORDER_BUSY`); phrase must match the environment (`ACTIVATION_REQUIRED`); the account must be funded (`NO_FUNDED_BALANCE`; a U.S. account with nothing can count KRW through integrated funding, LE:54, LE:63-64); only the keys symbols, maxOrderKRW, maxDailyTurnoverKRW, maxCompanyPct, maxDailyLossKRW, lossLimit are accepted, symbols ≤ 20 and valid (`INVALID_LIMITS`, LE:35); caps validated by `optionalCaps` (`electron/optional-caps.cjs:1`); loss by `validateLoss` (`electron/loss-policy.cjs:1`). `anyStock` is set true when the list is empty (LE:45). A percent loss trigger is converted to an amount from the day's baseline (LE:45). The same day's loss baseline is kept when limits are edited (LE:38-44).
  - **Engine checks on `propose`** (LE:110-131): exact keys `limitPrice, quantity, side, symbol`; side Buy/Sell; quantity a whole number 1–10,000; price ≥ 1 (KR whole won; US whole cents, LE:13); valid symbol; else `INVALID_ORDER` (LE:115). Session off → `KIS_TRADING_DISABLED`; symbol outside the list (when not `anyStock`) → `INSTRUMENT_NOT_ALLOWED` (LE:116); over the order cap → `ORDER_SIZE_LIMIT` (LE:117). Credit orders are KR only and live only (`FEATURE_UNAVAILABLE`, LE:113-114); unverified credit path → `CREDIT_PATH_UNVERIFIED` (LE:125). A proposal expires 120 s after creation (`expiresAt: Date.now()+120000`, LE:130).
  - **Engine checks on `submit`** (LE:136-204, partial read): busy → `KIS_ORDER_BUSY`; unknown id → `UNKNOWN_ORDER`; wrong phrase → `APPROVAL_REQUIRED` (LE:144); session off or proposal older than its expiry → `DISABLED_OR_EXPIRED` (LE:145); another order open/uncertain → `RECONCILIATION_REQUIRED` (LE:146-147); list or order cap changed → `LIMIT_CHANGED` (LE:148); day's turnover cap → `DAILY_TURNOVER_LIMIT` (LE:150); also `ACCOUNT_CHANGED` (LE:166), `EXTENDED_SIZE_LIMIT` (LE:182, default 5% of the account in extended sessions), `DAILY_SESSION_SETUP_REQUIRED` when the policy's day is not today (LE:189), `CONCENTRATION_LIMIT` (LE:198), `INSUFFICIENT_CAPACITY` (LE:204).
  - **`reconcile`** (LE:446-455): reads KIS's order list for each day that has an open app order (Submitting, Uncertain, Accepted, Partially filled), applies it, and closes a previous day's still-open order as Canceled with `closedReason` "expired at the session end".
  - **`linkUncertain`** (LE:575-580): needs the phrase `LINK BROKER ORDER`; the order must be Uncertain or Submitting (`UNKNOWN_ORDER`); the KIS order with that number must match symbol, side, quantity and price, else `BROKER_ORDER_MISMATCH`; then the order becomes Accepted and `reconcile()` runs.
  - **Confirmation phrases** (none is typed by the user; each is sent by the button after a switch or directly): `ENABLE LIVE` / `ENABLE MOCK` (LE:33), `ENABLE AUTO LIVE` / `ENABLE AUTO MOCK` (LE:66), `PLACE LIVE ORDER` / `PLACE MOCK ORDER` (LE:144), `LINK BROKER ORDER` (LE:576).
  - **Code-to-text table in LiveTrading.tsx** (`errors`, LT:21; 21 codes, all listed):

| Code | Text |
|---|---|
| NO_FUNDED_BALANCE | KR: "No funded balance is available. Refresh your KIS account." US: "No USD cash or holdings are available. Refresh and check overseas account funding in KIS." |
| ACTIVATION_REQUIRED | "Confirm that you want to enable this account." |
| SESSION_CLOSED | "Market closed. Reviews remain available; submit a fresh order during market hours." |
| BROKER_REJECTED | "KIS rejected this request. Check mock account support and broker permissions." |
| INSUFFICIENT_CAPACITY | "Insufficient available cash or shares." |
| PRICE_MOVED | "The price moved more than 2% from your limit. Check the price and create the order again." |
| OPEN_BROKER_ORDERS | "Another order open at KIS blocks this one. Wait for it to fill, or cancel it." |
| ORDER_UNCERTAIN | "KIS's reply was unclear, so the order is not confirmed. The app checks it against KIS's order list." |
| INVALID_ORDER | "The order is not valid: check the quantity and price." |
| FEATURE_UNAVAILABLE | "KIS offers credit orders (margin, short selling) only on live accounts." |
| CREDIT_ACCOUNT_REQUIRED | "This account has no KIS credit-trading agreement (신용거래 약정). Sign one with KIS to use margin or short orders." |
| LEVERAGED_NOT_ENABLED | "Leveraged and inverse ETFs are off. Allow them under Settings → Short & leverage." |
| LEVERAGED_EXPOSURE_LIMIT | "This order would exceed your leveraged-product cap." |
| MARGIN_NOT_ENABLED | "Margin buying is off. Allow it under Settings → Short & leverage." |
| MARGIN_LIMIT | "This order would exceed your margin-loan cap." |
| SHORT_NOT_ENABLED | "Short selling is off. Allow it under Settings → Short & leverage." |
| SHORT_LIMIT | "This order would exceed your short-position cap." |
| LIMIT_CHANGED | "Your limits changed; create the proposal again." |
| INVALID_LIMITS | "Check the optional caps and refresh the account balance." |
| KIS_NOT_CONNECTED | "Connect your KIS account first." |
| EXTENDED_SIZE_LIMIT | "This order is larger than the extended-session limit in Engine settings → Trading → Extended hours." |

    (21 codes; NO_FUNDED_BALANCE has two texts.) Fallback: on US, `usErrorMessage(code)`; on KR, the raw code; then "Request failed." (LT:21). Success text is "Completed." (LT:21).
  - **Codes with no text here**: the KR allow-list (main:707, 32 codes) also passes INVALID_LOSS_LIMIT, APPROVAL_REQUIRED, KIS_TRADING_DISABLED, INSTRUMENT_NOT_ALLOWED, ORDER_SIZE_LIMIT, KIS_ORDER_BUSY, UNKNOWN_ORDER, DISABLED_OR_EXPIRED, RECONCILIATION_REQUIRED, DAILY_TURNOVER_LIMIT, DAILY_LOSS_LIMIT, CONCENTRATION_LIMIT, DAILY_SESSION_SETUP_REQUIRED, BROKER_ORDER_MISMATCH; and the generic `KIS_ORDER_FAILED`. These appear on the KR tab as the raw code (LT:21 fallback). `EXTENDED_SIZE_LIMIT` has a text (LT:21) but is not in the KR allow-list (main:707), so on KR it arrives as `KIS_ORDER_FAILED` (inferred from the two lists). Likewise BROKER_REJECTED and ORDER_UNCERTAIN have texts at LT:21 but are absent from main:707, so if the engine throws one it reads `KIS_ORDER_FAILED` on the KR tab (inferred). `CREDIT_PATH_UNVERIFIED` (LE:125) is in neither list and also reads `KIS_ORDER_FAILED` (inferred).
  - **US allow-list** (main:336, 18 codes): NO_FUNDED_BALANCE, LEVERAGED_NOT_ENABLED, LEVERAGED_EXPOSURE_LIMIT, KIS_NOT_CONNECTED, ACTIVATION_REQUIRED, INVALID_LIMITS, INVALID_ORDER, SESSION_CLOSED, PRICE_MOVED, INSUFFICIENT_CAPACITY, OPEN_BROKER_ORDERS, RECONCILIATION_REQUIRED, KIS_TRADING_DISABLED, DISABLED_OR_EXPIRED, BROKER_REJECTED, ORDER_UNCERTAIN, ACCOUNT_CHANGED, BROKER_ORDER_MISMATCH. Any other engine code (for example ORDER_SIZE_LIMIT, INSTRUMENT_NOT_ALLOWED, LIMIT_CHANGED, DAILY_TURNOVER_LIMIT, APPROVAL_REQUIRED, INVALID_LOSS_LIMIT) becomes `US_REQUEST_FAILED` unless it is in `us-errors.cjs` BASE, and then reads "U.S. account: the request could not complete. Check connectivity and retry. (US_REQUEST_FAILED)" (main:336; `electron/us-errors.cjs:7`; `src/usErrors.ts:12`) (inferred by combining the three).
  - **`src/usErrors.ts`** (`usErrorMessage`, lines 1-14; full table). `KIS_NOT_CONNECTED` → "Connect your KIS account first, or wait for reconnection to finish." Otherwise a stage prefix from the code's start: `US_BALANCE_` → "U.S. holdings", `US_CASH_` → "USD cash", `US_QUOTES_` → "U.S. quotes", else "U.S. account"; and a text by the code's ending:

| Code ending | Text after "<stage>: " |
|---|---|
| NETWORK_UNAVAILABLE | "connection failed. Retrying automatically on the next refresh." |
| REQUEST_TIMEOUT | "KIS did not respond in time. Retained balances may be stale." |
| SERVER_ERROR | "the KIS server returned an error. Retained balances may be stale; the app will retry later." |
| AUTH_FAILED | "authentication failed. Reconnect your KIS account." |
| RATE_LIMITED | "KIS request limit reached. Broker requests pause with increasing backoff (up to five minutes). Last known values are retained." |
| BROKER_REJECTED | "KIS rejected the query. Check overseas/mock-account access in KIS; Korean-market access does not establish overseas access." |
| INVALID_RESPONSE | "KIS returned an unsupported response format. (<code>)" |
| INCOMPLETE_BALANCE | "the result is incomplete. Retained values may be stale; retry refresh." |
| REQUEST_FAILED | "the request could not complete. Check connectivity and retry. (<code>)" |
| anything else | the raw code |

  - **`electron/us-errors.cjs`** (10 lines): no texts, only code lists and helpers. `BASE` = 14 public codes (REQUEST_FAILED, NETWORK_UNAVAILABLE, REQUEST_TIMEOUT, SERVER_ERROR, AUTH_FAILED, RATE_LIMITED, BROKER_REJECTED, INVALID_RESPONSE, INCOMPLETE_BALANCE, KIS_NOT_CONNECTED, FEATURE_UNAVAILABLE, SESSION_CLOSED, ORDER_NOT_SENT, TICKET_EXPIRED) (:1). `ORDER_CODES` = 5 codes kept only for order requests (PRICE_MOVED, INSUFFICIENT_CAPACITY, OPEN_BROKER_ORDERS, INVALID_ORDER, ORDER_UNCERTAIN) (:5). `ORDER_OPERATIONS` = 3 (us-prepare-order, us-place-order, us-revise-order) (:6). `publicUSCode(code,{order})` passes BASE, ORDER_CODES (when `order`), and `US_(BALANCE|CASH|QUOTES)_<9 endings>` (27 staged codes); everything else → `US_REQUEST_FAILED` (:7). `stage(name, fn)` wraps a failure as `US_<name>_<base>` and carries `retryAt`, `brokerCode`, `httpStatus` (:8). `records(value)` normalises a KIS list, throwing `INVALID_RESPONSE` on a bad type (:9).
  - **`electron/broker-errors.cjs`** (18 lines): no texts. `PUBLIC` = 7 codes (REQUEST_FAILED, NETWORK_UNAVAILABLE, REQUEST_TIMEOUT, SERVER_ERROR, RATE_LIMITED, AUTH_FAILED, INVALID_RESPONSE) (:1). `responseError(status, body)` maps a KIS HTTP reply to a reason: `EGW00201` or HTTP 429 → RATE_LIMITED; 401/403 → AUTH_FAILED; ≥500 → SERVER_ERROR; else REQUEST_FAILED; and keeps a safe `brokerCode` and `httpStatus` (:2). `TEMPORARY` = 8 codes (KIS_ORDER_BUSY, RATE_LIMITED, ORDER_NOT_SENT, TICKET_EXPIRED, REQUEST_TIMEOUT, NETWORK_UNAVAILABLE, SERVER_ERROR, SESSION_CLOSED) (:11). `BROKER` = 2 (BROKER_REJECTED, CREDIT_ACCOUNT_REQUIRED) (:12). `classify(error)` returns a kind: `internal` (no code or an `ERR_` code; code `INTERNAL_ERROR`, with file:line), `broker`, `temporary`, `uncertain` (ORDER_UNCERTAIN) or `check` (any other code) (:13-17).
  - **Toasts** (`src/Toast.tsx`): `toast(text, tone='ok')` dispatches a window `CustomEvent('app-toast')` (:5); `Toaster` shows at most 3, replaces one with the same text, and removes each after 3000 ms (ok) or 6000 ms (error); prefix "✓" or "!" (:8-10). From this screen only `configure` raises a toast (LT:21).
  - Amount caps on the U.S. tab are whole dollars: the renderer requires a safe integer for both currencies (LT:25) and so does `optionalCaps` (`electron/optional-caps.cjs:1`). The policy keys keep the `KRW` suffix on the U.S. policy too (LT:28).
  - `PRICE_MOVED` text says "more than 2%" (LT:21); the engine threshold was not read (not determined).
  - Narrow-window behaviour: not determined (CSS not read).

## Paper trading ("Paper")

- **Purpose**: A practice account with simulated money (₩10,000,000 start) and simulated prices; it never sends orders to KIS (`src/PaperTrading.tsx:42`, `electron/paper-engine.cjs:16`).

- **Component files**: `src/PaperTrading.tsx` exports `PaperTrading` (:22) and types `PaperState`, `PaperReply` (:11-12); internal `BoardRow` (:17). `src/PaperCaps.tsx` exports `PaperCaps({state,onSaved})` (:4), mounted inside the settings disclosure (`src/PaperTrading.tsx:72`). Mounted at `src/main.tsx:146`.

- **What it shows**:
  - Without the desktop bridge: heading "Paper trading", "Open the desktop app to use the persistent paper ledger." (:25). Loading: "Loading paper account…" (:26).
  - **Hero "Practice account"** (:41-52): heading "Practice account", sub-line "Simulated money and prices · never sends orders to KIS" (:42). When paused: "Paused · turn the simulation on to trade." (tooltip "Pausing cancels open practice orders.") (:44). Four stats (:46-49): "Total value" (LiveValue + TickDelta); "Cash available" (+ "<amount> held for open orders" when cash is reserved); "Invested" (+ "<n> position(s)"); "Realized profit" (+ "after simulated fees"). When the loss limit is breached: "Daily loss limit reached · emergency reviews on" (:51).
  - **"Prices" board** (aria-label "Paper price board", :54-55): sub-line "Paused" or "Updated <hh:mm:ss> KST"; table columns "Company", "Price", "You hold", (actions). Each row: name, symbol, price (flashes up/down for 700 ms on a change, :19), "<n> sh" or "—", buttons "Buy" / "Sell" (:20).
  - **"Order" ticket** (aria-label "Paper order ticket", :57-65): summary list "Price now"; "Estimated cost" (Buy) / "Estimated proceeds" (Sell); "Fees & slippage" (percent = (feeBps+slippageBps)/100, :34, :61); "Cash available" (Buy) / "Shares held" (Sell). Hint when invalid: "Not enough cash for this many shares." / "You can sell at most the shares you hold." (:62). Result message (role status) (:64).
  - **Activity section** (aria-label "Paper activity", :67-70), three tabs:
    - "Positions": columns "Company", "Shares", "Cost", "Value", "Unrealized"; empty "No practice positions yet. Pick a company in Prices and press Buy." (:68).
    - "Orders" (label "Orders (<n> open)" when some are open): columns "Time", "Order", "Filled", "Status", (action); status may carry " · <reason>"; empty "No practice orders yet." (:67, :69).
    - "Fills": columns "Time (KST)", "Fill", "Price", "Fee", "Realized" ("—" for buys); empty "No fills yet. Orders fill on the next simulated price updates." (:70).
  - **Disclosure "Practice limits & loss tolerance"** (:72-77): "Starting balance ₩10,000,000 · fees <feeBps/100>% · slippage <slippageBps/100>%. The simulation pauses when the app starts and cancels unfinished paper orders." (:72); `PaperCaps`; heading "Daily loss tolerance" with badge "EMERGENCY MODE" or "NORMAL MODE" (:73); Note summary "Hitting this starts emergency reviews; orders stay allowed.", body "Reaching this daily loss starts emergency reviews (when scheduled reviews are on in Engine settings). Orders stay allowed within your other limits. Resets each Seoul calendar day." (:74); footer "Today's start <amount> · current loss <amount> (<pct>%) · emergency at <amount|not set>" (:77).
  - Messages: "Could not load the paper ledger." (:24); "Paper request failed." (:28); "Blocked by risk checks: <reason|not allowed>" (:30); "Paper order failed."; "Blocked: <reason>"; "<Side> <qty> <name> placed. It fills on the next simulated price updates." (:32); "Simulation paused; unfinished paper orders were canceled." / "Simulation running. Prices move and orders can fill." (:43); "Loss tolerance saved."; "Enter a positive KRW amount or a percentage up to 100."; "Could not save loss tolerance." (:76).

- **Controls**:
  - Switch (aria-label "Simulation running"), text "Simulation paused" / "Simulation running"; disabled while busy; calls `pausePaper(!paused)` (:43). Pausing cancels open paper orders (reason "Paper kill switch", `electron/paper-engine.cjs:88`).
  - Board row "Buy" / "Sell" buttons: select the company and side in the ticket; Sell is disabled with no holding and pre-fills the quantity with the shares held (:20, :39).
  - Ticket: "Company" select (aria-label "Paper instrument") over the universe (:58); side toggle "Buy" / "Sell" (aria-label "Paper side") (:59); "Shares" stepper: "−" (aria-label "Fewer shares"), number input (aria-label "Paper quantity", min 1, max 1000, step 1), "+" (aria-label "More shares"), link button "Max <n>" (capped at 1000; disabled when 0) (:60).
  - "Place paper buy order" / "Place paper sell order" (text "Placing…" while busy): disabled while busy, when paused, or when invalid (quantity < 1, cost above available cash, or more than held) (:36, :63). One click runs `proposePaper` then, if the proposal is Ready, `submitPaper` (:29-32). No confirmation step.
  - Tabs "Positions", "Orders", "Fills" (:67).
  - "Cancel paper order" on Pending / Partially filled orders (:15, :69).
  - `PaperCaps` (disclosure "Optional execution caps", `src/PaperCaps.tsx:4`): "Maximum order (KRW)" and "Daily turnover (KRW)" (MoneyField, placeholder "No cap"), "Maximum company allocation (%)" (number, min 1, placeholder "No cap"); button "Save optional caps"; messages "Saved." / "Check the optional cap values." / "Could not save caps."; toasts "Paper caps saved" / "Not saved: check the cap values" / "Not saved: could not reach the engine"; footnote "Blank means no cap. A 100% single-company allocation is permitted."
  - Loss tolerance: "Limit unit" select "Not set" / "KRW amount" / "Percentage" (choosing a unit presets the value: 0, 500000 or 5) and "Maximum daily loss" (MoneyField for an amount, number input otherwise) (:75); button "Save loss tolerance" (disabled while busy) with toasts "Loss tolerance saved" / "Not saved: check the loss tolerance" / "Not saved: could not reach the engine" (:76).

- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method (`electron/paper-engine.cjs`) |
|---|---|---|---|
| `getPaper()` | `paper:get` | main:745 | `paper.getState()` (:124) |
| `configurePaperLoss(value)` | `paper:loss` | main:746 | `paper.configureLoss(value)` (:24); failure → `INVALID_LOSS_LIMIT` |
| `configurePaperCaps(value)` | `paper:caps` | main:747 | `paper.configureCaps(value)` (:23); failure → `INVALID_LIMITS` |
| `proposePaper(command)` | `paper:propose` | main:748 | `paper.propose(command)` (:62); failure → `INVALID_REQUEST` |
| `submitPaper(id)` | `paper:submit` | main:749 | `paper.submit(id)` (:73); failure → `PAPER_REQUEST_FAILED` |
| `pausePaper(paused)` | `paper:pause` | main:750 | `paper.setPaused(paused)` (:86) |
| `cancelPaper(id)` | `paper:cancel` | main:751 | `paper.cancel(id)` (:91) |

  The engine is built as `new PaperEngine(store.db, domain.holdings, ()=>marketCache.snapshot())` (main:247): the universe is the app's demo holdings list and the quotes are the market cache's (the identity of those was not traced).

- **Subscriptions**: a 1000 ms `setInterval` polling `getPaper` with an in-flight guard (:24). The price flash uses a 700 ms timer (:19). No broadcast listeners.

- **Saved state**:
  - SQLite tables `paper_account`, `paper_loss_policy`, `paper_caps`, `paper_proposals`, `paper_orders`, `paper_fills` (`electron/paper-engine.cjs:10-15`).
  - The account starts with cash 10,000,000 and `paused:true` (:16); on every app start the engine pauses the account and cancels open orders with reason "Restart recovery" (:17).
  - Renderer drafts (session memory): `paper:loss`, `paper:symbol` (default '005930'), `paper:side` ('Buy'), `paper:quantity` ('1'), `paper:view` ('Positions') (`src/PaperTrading.tsx:23`); `paper:caps` (`src/PaperCaps.tsx:4`).

- **Notes**:
  - Fixed engine constants `POLICY` (`electron/paper-engine.cjs:3`): feeBps 10, slippageBps 10, toleranceBps 50, quoteMaxAgeMs 5000, proposalLifetimeMs 30000, orderLifetimeMs 60000, fillChunk 2; plus maxOrderKRW 1,000,000, maxDailyTurnoverKRW 5,000,000, maxConcentrationBps 4000, maxDailyLossKRW 500,000, which `getState` overrides with the saved caps and loss status (:126), and `check` uses only the saved caps (:52-58). With nothing saved the caps are all null = no cap (:22; `electron/optional-caps.cjs:1`) and the loss policy is `{mode:'off',value:0}` (:21).
  - Risk-check reason codes shown raw after "Blocked by risk checks: " / "Blocked: " / in the Orders status (`electron/paper-engine.cjs:42-59`, :80): PAPER_PAUSED, INSTRUMENT_NOT_ALLOWED, INVALID_QUANTITY_OR_SIDE, STALE_QUOTE, STALE_PORTFOLIO_QUOTES, PRICE_MOVED, ORDER_SIZE_LIMIT, DAILY_TURNOVER_LIMIT, INSUFFICIENT_CASH, CONCENTRATION_LIMIT, INSUFFICIENT_SHARES, PROPOSAL_NOT_READY, PROPOSAL_EXPIRED, PORTFOLIO_CHANGED. Order reasons: "Restart recovery" (:17), "Paper kill switch" (:88), "User cancellation" (:92), "Paper paused" / "Order expired" (:100). Order statuses: Pending, Partially filled, Filled, Canceled, "Risk stopped" (:82, :105, :119). There is no code-to-text table on this screen.
  - Fills: at most 2 shares per new quote (`fillChunk`), at the quote price ± slippage; orders expire after 60 s (:3, :100-107).
  - Quantity limit 1–1000 in the engine (:44, :63) and in the input (`src/PaperTrading.tsx:60`).
  - The `proposals` list in the state is not displayed (`src/PaperTrading.tsx` has no use of `s.proposals`).
  - Narrow-window behaviour: tables sit in `div.table-scroll` (:55, :68-70); CSS not read.

## Shared loader: RuntimeSettings (journal and news modes)

- **Purpose**: Loads the engine state and passes it to the Journal or News view. The same component also serves Engine settings (another agent). (src/RuntimeSettings.tsx:37, :63, :65)
- **Component files**: `src/RuntimeSettings.tsx`, export `RuntimeSettings({mode,onNavigate})` (src/RuntimeSettings.tsx:37). Mounted at src/main.tsx:150 with `key={tab}` and `mode` = `'news'` for tab News, `'journal'` for tab Journal, else `'settings'`; `onNavigate={go}`.
- **What it shows**:
  - Before the first state arrives: "Loading…" (desktop app) or "Use the desktop app for runtime controls." (no `window.portfolio`). (src/RuntimeSettings.tsx:53)
  - A status line `role="status"` class `notice` with the last message: "Settings saved.", "Completed.", "Request failed.", "Could not load runtime settings.", or a refusal text. (src/RuntimeSettings.tsx:42, :50, :51, :62)
  - `mode==='news'`: `<NewsView>` (src/RuntimeSettings.tsx:63). `mode==='journal'`: `<JournalView>` (src/RuntimeSettings.tsx:65).
- **Controls**: none of its own in these two modes (the draft bar and Claude confirmation render only when `mode==='settings'`, src/RuntimeSettings.tsx:61-62).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `getRuntime()` (src/RuntimeSettings.tsx:42) | `runtime:get` (electron/preload.cjs:24) | main.cjs:722 | `runtimeState()` = `lightState({...automation.getState(), funding, launch, connections, bridgePipe, bridgeScript, notifications},{version:automation.historyVersion()})` (main.cjs:692; `lightState` electron/runtime-state.cjs:13) |
| `getRuntimeHistory()` (src/RuntimeSettings.tsx:42) | `runtime:history` (electron/preload.cjs:29) | main.cjs:723 | `historyOf(automation.getState())` (electron/runtime-state.cjs:19) |
| `refreshNews()` (action `'news'`, src/RuntimeSettings.tsx:48) | `runtime:news` (electron/preload.cjs:33) | main.cjs:739 | `refreshNews()` (main.cjs:109) then `runtimeState()` |
| `configureRuntime(value)` (action `'save'`, src/RuntimeSettings.tsx:49) | `runtime:configure` (electron/preload.cjs:25) | main.cjs:724 | `automation.configure(value)` (validation in electron/automation.cjs:177-202) |
| `approveLesson(id,approved)` (action `'lesson'`, src/RuntimeSettings.tsx:49) | `runtime:lesson` (electron/preload.cjs:71) | main.cjs:743 | `automation.approveLesson(id,approved)` (electron/automation.cjs:1999) |

- **Subscriptions**: a `setInterval` of 2000 ms calls `getRuntime()` (src/RuntimeSettings.tsx:42). In journal and news modes (`wantsHistory`, src/RuntimeSettings.tsx:40) it then calls `getRuntimeHistory()` when `needsHistory(seen, value.historyVersion, has)` is true: no history held yet, or the version is null, or the version differs from the one seen (src/runtimeFeed.ts:23). The history reply is merged over the light state (`withHistory`, src/RuntimeSettings.tsx:41).
- **What the history carries**: the keys `reviews`, `allReviews`, `outcomes`, `newsEvents` (`HISTORY_KEYS`, electron/runtime-state.cjs:5). The 2-second state carries only the latest three reviews in brief plus `historyVersion` and `historyCounts` (electron/runtime-state.cjs:13-17). `historyVersion` is built from the database change counter, the settings revision, the watch scope, the current minute and the database data version (electron/automation.cjs:139), so the history is fetched again at least once a minute (inferred from the minute component). In the engine state `reviews` is `reviewHistory(50)` (connected account) and `allReviews` is `reviewHistory(50,true)`; `newsEvents` is `newsEvents.list(100)`; `outcomes` is `outcomes.list()` (electron/automation.cjs:346).
- **Saved state**: the draft config is kept under draft key `runtime:<mode>:config`, with refs `runtime:<mode>:dirty` and `runtime:<mode>:changed` (src/RuntimeSettings.tsx:38). Drafts are session memory only: kept across navigation, lost on reload or exit (src/useDraftState.ts:2-3). While `dirty` is true the polled config does not replace the draft (src/RuntimeSettings.tsx:42 `dirty.current?current:value.config`).
- **Notes**:
  - `JournalView` receives `onLesson` (src/RuntimeSettings.tsx:65) but does not use it: its parameter list destructures only `state,onNavigate,onDesk` (src/JournalView.tsx:42). Lesson buttons call the API directly in `LessonCard` (src/LearningPanel.tsx:14).
  - `SAVE_ERRORS` (src/RuntimeSettings.tsx:28-30) maps 8 refusal codes to text. They concern the Engine settings save; main.cjs returns only the Claude codes or `INVALID_SETTINGS` (main.cjs:724), and `INVALID_SETTINGS` has no entry, so a refused news save shows the raw `INVALID_SETTINGS` in the notice and the toast "Not saved: INVALID_SETTINGS" (src/RuntimeSettings.tsx:50) (inferred from the fallback chain `SAVE_ERRORS[...]??claudeGateMessage()??reply.message??reply.error`).

## Journal

- **Purpose**: The record of AI decisions, the agent's armed orders and triggers, trade outcomes, lessons, the scoreboard and replays, in six sub-tabs. (src/journalTabs.ts:5; src/JournalView.tsx:47-60)
- **Component files**: `src/JournalView.tsx`, export `JournalView` (src/JournalView.tsx:42); internal `DecisionDetail` (src/JournalView.tsx:22). Tab model and helpers in `src/journalTabs.ts`. Mounted by `RuntimeSettings` in journal mode (src/RuntimeSettings.tsx:65), which is mounted at src/main.tsx:150. Sidebar tooltip: "AI decisions and the lessons you approve for future reviews." (src/WorkspaceUX.tsx:21).
- **What it shows**:
  - Container `aria-label="Portfolio journal"` (src/JournalView.tsx:47).
  - A segmented row `aria-label="Journal views"` with six buttons, in order: "Decisions", "Orders and triggers", "Trades", "Lessons", "Scoreboard", "Replay" (src/journalTabs.ts:5; src/JournalView.tsx:48).
  - Tab badges (`data-count`): only on "Orders and triggers" (number of armed conditional orders, `state.desk.orders.length`) and "Lessons" (lessons with no lifecycle or with status `pending` or `needs-review`); shown only when above 0 (src/journalTabs.ts:10-12; src/JournalView.tsx:48).
  - Warning mark on "Orders and triggers" (`data-warn="true"`, tooltip "Not monitored while auto trading is paused.") when orders are armed and `desk.monitoringActive===false` (src/journalTabs.ts:12; src/JournalView.tsx:46, :48).
  - Sub-tab content: Decisions (below); "Trades" mounts `<TradeOutcomes outcomes={state.outcomes??[]}/>` (src/JournalView.tsx:56); "Orders and triggers" mounts `<AgentDesk>` (src/JournalView.tsx:57); "Lessons" mounts `<LearningPanel state={state}/>` (src/JournalView.tsx:58); "Scoreboard" mounts `<Scoreboard/>` with no props (src/JournalView.tsx:59; documented by another agent); "Replay" mounts `<ReplayPanel/>` (src/JournalView.tsx:60).
- **Controls**: the six tab buttons; `aria-pressed` marks the open one; click calls `setView(name)` (src/JournalView.tsx:48).
- **Calls and channels**: none of its own; data comes from the `state` prop (see Shared loader).
- **Subscriptions**: none of its own (parent polls every 2 s, src/RuntimeSettings.tsx:42).
- **Saved state**: draft keys (session memory only, src/useDraftState.ts:2): `journal:view` (open sub-tab, default 'Decisions'), `journal:filter` (default 'All'), `journal:selected` (selected review id), `history:accounts` (account scope, default 'account', shared with the Console) (src/JournalView.tsx:43). A saved view that no longer exists opens Decisions; the old name 'Reviewed lessons' maps to Lessons (src/journalTabs.ts:7).
- **Notes**:
  - Home's attention items can open a specific sub-tab: an item with `view` sets draft `journal:view` before navigating (src/Dashboard.tsx:31 "journal:view"). Items that do this: `stop-unreadable-<id>`, `plan-stop-<id>`, `plan-trail-<id>`, `restart-notice`, all with `view:'Orders and triggers'` (main.cjs:620, :623, :625, :626).
  - Sidebar badge for Journal: `attention.counts.lessons` (src/main.tsx:135). See "Sidebar badges" at the end.

### Decisions (Journal sub-tab)

- **Purpose**: Lists saved AI reviews and shows the selected one with its order result, outcome and lessons. (src/JournalView.tsx:21, :49-55)
- **Component files**: inline in `JournalView` (src/JournalView.tsx:49-55) plus `DecisionDetail` (src/JournalView.tsx:22-41).
- **What it shows**:
  - Empty state when neither the scoped list nor `allReviews` has entries: "No decisions yet" / "Run a review from Home." (src/JournalView.tsx:49).
  - Source list: `state.allReviews ?? state.reviews` when scope is 'all' or no account is known; otherwise `state.reviews` (src/JournalView.tsx:44). Filtered by `matchesAction` (src/JournalView.tsx:45; src/journalTabs.ts:53).
  - Left list `aria-label="Decision list"`: one button per review with a tone dot, a bold line, a small line and a time (src/JournalView.tsx:52).
    - Bold line: for a review with several orders, the batch title alone; otherwise "`<action>` · `<title>`" (src/JournalView.tsx:52).
    - Title rules (src/JournalView.tsx:19): several orders: counts by action from `batchCounts`, for example "2 buys, 1 sale", with ", first held back" when `decision.withheld` (src/journalTabs.ts:47-50); a withheld buy: "Buy withheld: incomplete plan (`<symbol>`)"; a Hold: "No trade"; otherwise "`<symbol>` ×`<quantity>`" (the ×quantity part only when quantity > 0).
    - Small line: "Emergency review" when `r.emergency`, else the trigger text; plus " · `<account label>`" when all accounts are shown and an account is known; a missing label reads "Earlier (account not recorded)" (src/JournalView.tsx:52; src/AccountScope.tsx:9).
    - Time: HH:MM (en-GB) and below it "today" or MM-DD (src/JournalView.tsx:14-15, :52).
    - Tone class `tone-<action>`: the action in lower case, or for several orders the shared action or "mixed" (src/JournalView.tsx:18; src/journalTabs.ts:51).
  - Empty list messages: "No decisions on `<account label>` yet. Choose All accounts to see earlier ones." (account scope with no entries) or "No decisions match." (src/JournalView.tsx:53).
  - Detail article `aria-label="Decision detail"` (src/JournalView.tsx:29) for the selected review, or the first in the list when none is selected (src/JournalView.tsx:45):
    - Head: an action tag (not shown for several orders) and the title; small line "`<YYYY-MM-DD>` `<HH:MM>` · `<trigger or 'Emergency review'>`"; an outcome pill (src/JournalView.tsx:30).
    - Outcome pill text: "`<n>` orders" for several orders, else the result of `orderPill` (src/JournalView.tsx:25). See the table under Notes.
    - A bubble with the author: "Claude" when `review.vendor==='anthropic'`, else from `PROVIDER`: `local` "Local rules", `openai` "OpenAI", `external` "External agent", else the raw provider (src/JournalView.tsx:13, :31).
    - The explanation: the first three sentences, with the rest behind a link button (src/JournalView.tsx:27, :31; src/journalTabs.ts:15-18).
    - For several orders, a block "Orders" (`aria-label="Orders of this review"`): one line per order "`<action>` `<symbol>` ×`<quantity>`", its pill and its execution note (src/JournalView.tsx:32).
    - "Decision facts" (`aria-label`), up to three label/value pairs from `decisionFacts` (src/JournalView.tsx:33; src/journalTabs.ts:56-62): "Order" = the pill text, or "Orders" = "`<k>` of `<n>` sent"; "Plan" = the first sentence of `decision.plan.thesis` (only when recorded); "AI" = "`<n>` AI call(s)" plus " · < $0.01" (below 5000 micro-dollars) or " · $`<x.xx>`" (only when a usage record for the review exists in `state.tokenSaving.recent`, src/JournalView.tsx:27).
    - Behind "More" (src/JournalView.tsx:34-39): "Execution" with `review.executionNote`; "Outcome" block, one line per outcome with `reviewId` equal to the review: "`<side>` `<quantity>`/`<requested>`", then for a sale "`<gain>` after fees" or for a buy "Bought at `<price>`", plus " · `<assessment category>`", and the day (src/JournalView.tsx:23, :36); "Lessons" block: each lesson whose `evidence.reviewId` is this review, with its status (`lifecycle.status`, else 'approved' or 'pending') and text (src/JournalView.tsx:24, :37); a small line "Review `<8 chars>` · proposal `<8 chars>` · order `<8 chars>`" (src/JournalView.tsx:38).
    - Money format: en-US currency, no decimals for KRW, sign shown except for zero, "—" when null (src/JournalView.tsx:20).
- **Controls**:
  - Select `aria-label="Decision action"`: "All", "Buy", "Sell", "Hold" (src/JournalView.tsx:51). A review with several orders matches when any of its orders has that action (src/journalTabs.ts:53-54).
  - Account scope select (see AccountScope below) (src/JournalView.tsx:51).
  - Each list row: click selects the review (`aria-current="true"` on the selected one) (src/JournalView.tsx:52).
  - Link button "More" / "Less" on the explanation (aria-labels "Show the whole explanation" / "Show less of the explanation"); shown only when the explanation has more than three sentences; renderer-only state (src/JournalView.tsx:26, :31).
  - Disclosure "More" (`aria-label="More about this decision"`); its open state is draft `journal:detailMore` (src/JournalView.tsx:26, :34).
  - Link button "Review lessons →": opens the Lessons sub-tab; shown only when the review has lessons (src/JournalView.tsx:37, :54).
  - Button "Open conversation": sets draft `console:focus` to the review id and navigates to 'AI console'; shown only when `onNavigate` is given (src/JournalView.tsx:38). The Console takes that value once and opens the run with that id (src/AiConsole.tsx:61, :64).
- **Calls and channels**: none directly (state from `runtime:get` + `runtime:history`, see Shared loader).
- **Subscriptions**: none of its own.
- **Saved state**: drafts `journal:filter`, `journal:selected`, `history:accounts`, `journal:detailMore` (session memory only) (src/JournalView.tsx:26, :43).
- **Notes**:
  - Order pill table (`orderPill`, src/journalTabs.ts:27-37):

| Condition | Text |
|---|---|
| no `orderId`, `outcome.code==='PROPOSED'` | "Proposal created" |
| no `orderId`, `outcome.code==='NOT_PROPOSED'` | "No order" |
| no `orderId`, any other `outcome.code` | "Not sent" |
| no `orderId`, no code, `executionNote` starts with "Not sent" | "Not sent" |
| no `orderId`, no code, has `proposalId` | "Proposal created" |
| no `orderId`, nothing else | "No order" |
| `orderId`, no `orderOutcome`, note starts with "Not sent" | "Not sent" |
| `orderId`, no `orderOutcome` otherwise | "Order sent" |
| `orderOutcome.status==='Rejected'` and reason in `ORDER_NOT_SENT`, `SESSION_CLOSED`, `CREDIT_PATH_UNVERIFIED` | "Not sent" |
| `orderOutcome.status==='Rejected'`, other reason | "Rejected by KIS" |
| status `Uncertain` or `Submitting` | "Unclear: check KIS" |
| any other status | "Order sent" |

  - Batch words (`WORDS`, src/journalTabs.ts:47): Buy = "buy"/"buys", Sell = "sale"/"sales"; other actions use the lower-case action plus "s" (src/journalTabs.ts:50).
  - `batchTitle` ("`<n>` orders, first held back") is exported (src/journalTabs.ts:43-44) but `JournalView` imports `batchCounts`, not `batchTitle` (src/JournalView.tsx:11).
  - Dates use the local time zone here (`toLocaleDateString('en-CA')` without a time zone, src/JournalView.tsx:14-15), unlike the Console, which fixes Asia/Seoul (src/AiConsole.tsx:5-6).

### AccountScope (shared select)

- **Purpose**: Chooses whether history shows the connected account only or every account. (src/AccountScope.tsx:1-2)
- **Component files**: `src/AccountScope.tsx`, exports `AccountScope`, `accountName`, types `AccountTag`, `HistoryScope` (src/AccountScope.tsx:3-9). Used in the Journal's Decisions list (src/JournalView.tsx:51) and the Console toolbar (src/AiConsole.tsx:67).
- **What it shows**: a select `aria-label="Accounts"` with options "`<account label>` only" (value `account`) and "All accounts" (value `all`). Renders nothing when no account is known (src/AccountScope.tsx:6-7).
- **Controls**: the select; `onChange` passes the scope to the parent (src/AccountScope.tsx:7).
- **Calls and channels**: none.
- **Subscriptions**: none.
- **Saved state**: parents keep the choice in draft `history:accounts` (src/JournalView.tsx:43; src/AiConsole.tsx:58), so Journal and Console share it for the session.
- **Notes**: account labels come from `automation.accountTag()`: "Paper", "KIS live", "KIS mock" or "KIS" (electron/automation.cjs:126). `accountName(null)` reads "Earlier (account not recorded)" (src/AccountScope.tsx:9).

### Orders and triggers: AgentDesk (Journal sub-tab)

- **Purpose**: Shows what the trading AI is keeping: notes, review triggers and armed conditional orders, and lets the user remove any of them. (src/AgentDesk.tsx:3)
- **Component files**: `src/AgentDesk.tsx`, exports `AgentDesk` (src/AgentDesk.tsx:14) and `trailText` (src/AgentDesk.tsx:8). Mounted at src/JournalView.tsx:57 with `desk={state.desk}`, `conditionalOn={state.config.conditionalOrders}`, `trailingOn={state.config.trailingStops===true}`.
- **What it shows**:
  - Above the desk, when orders are armed but not monitored: notice "Not monitored while auto trading is paused." (src/JournalView.tsx:57).
  - When `state.desk` is missing: "Nothing to show yet" / "The agent's notes, review triggers and conditional orders appear here once the engine has loaded them." (src/JournalView.tsx:57).
  - Heading "Agent desk" with "Notes, review triggers and conditional orders the AI is keeping." (src/AgentDesk.tsx:17).
  - Error notice `aria-label="Unprotected holdings"`, one entry per `desk.unprotected` item (src/AgentDesk.tsx:18-20): bold "`<symbol>`: stop loss covers `<covered>` of `<quantity>` shares." (partial) or "`<symbol>` has no stop loss."; then "The last one was rejected `<date time>`", optionally " for a passing reason" (`temporary`), optionally "; a replacement waits for your approval" (replacement status `proposed` and broker status `Ready`), then "; the next review is asked to re-arm it or say why not."
  - Warning notice `aria-label="Purchases without a stop order"`, one line per `desk.planStopFailures` item: bold "The purchase of `<quantity>` `<symbol>` has no stop order." followed by the reason (src/AgentDesk.tsx:21).
  - Empty text when there are no notes, triggers, armed orders or recent orders: "Nothing yet. The AI adds notes, review triggers and conditional orders during reviews." (conditional orders on) or "Nothing yet. The AI adds notes and review triggers during reviews." (off) (src/AgentDesk.tsx:16, :22).
  - Section "Conditional orders · armed", with " · inactive while auto trading is paused" when `monitoringActive===false` (src/AgentDesk.tsx:23). Each row (src/AgentDesk.tsx:24): a purpose tag; bold "`<side>` `<quantity>` `<symbol>`"; " at `<limit price>`" or " at the market price"; small text " when `<conditions>` · until `<date time>`"; optional parts: " · sells only the shares its purchase buys" (`linkedBuy`), " · `<trail text>`" (`trail`), " · not trailing: `<reason>`" (`trailNotUsed`), " · waiting: `<text>`" (`waiting`); and the reason on its own line.
  - Conditions are written "`<expr>` `<op>` `<value>`", joined by " or " when `combine==='any'`, else " and " (src/AgentDesk.tsx:5).
  - Section "Review triggers": bold name; " when `<conditions>` · until `<date time>`"; the reason (src/AgentDesk.tsx:26-27).
  - Section "Notes": bold symbol or "General"; the note; " updated `<date time>` · until `<date time>`" (src/AgentDesk.tsx:29-30).
  - Disclosure "Recently fired, expired or cancelled" (a `Note`, src/Note.tsx:3), shown when there are recent orders or fired triggers (src/AgentDesk.tsx:32-34): each recent order "`<purpose>` · `<side>` `<quantity>` `<symbol>`", a badge with its status, and its outcome text; each fired trigger: name, badge "fired `<date time>`", and results "`<expr>` = `<actual>` (`<op>` `<value>`)" joined by "; ".
- **Controls**:
  - "Dismiss" (`aria-label="Dismiss the stop-loss warning for <symbol>"`): `dismissUnprotected(u.orderId)` (src/AgentDesk.tsx:20).
  - "Cancel" (`aria-label="Cancel conditional order <id>"`): `cancelConditionalOrder(o.id)` (src/AgentDesk.tsx:25).
  - "Remove" (`aria-label="Remove trigger <id>"`): `cancelTrigger(t.id)` (src/AgentDesk.tsx:28).
  - "Delete" (`aria-label="Delete note <symbol|general>"`): `deleteNote(n.symbol)` (src/AgentDesk.tsx:31).
  - None of the four has a confirmation step or a disabled state (src/AgentDesk.tsx:20, :25, :28, :31). A failed call is swallowed without a message (`act`, src/AgentDesk.tsx:15).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `cancelTrigger(id)` | `desk:cancel-trigger` (electron/preload.cjs:60) | main.cjs:441 | `automation.desk.cancelTrigger(scope,id)` (electron/agent-desk.cjs:59): status `cancelled`, `closedBy:'user'` |
| `deleteNote(symbol)` | `desk:delete-note` (electron/preload.cjs:61) | main.cjs:442 | `automation.desk.deleteNote(scope,symbol)` (electron/agent-desk.cjs:76): deletes the row from `agent_notes` |
| `cancelConditionalOrder(id)` | `desk:cancel-order` (electron/preload.cjs:62) | main.cjs:443 | `automation.desk.cancelOrder(scope,id)` (electron/agent-desk.cjs:208): status `cancelled`, `closedBy:'user'` |
| `dismissUnprotected(id)` | `desk:dismiss-unprotected` (electron/preload.cjs:63) | main.cjs:444 | `automation.desk.dismissUnprotected(scope,orderId)` (electron/agent-desk.cjs:207): sets `acknowledgedAt` on the rejected order |

  All four go through `deskAction` (main.cjs:440): it authorizes, takes `automation.watchScope()`, throws `KIS_NOT_CONNECTED` when there is no scope, runs the action and returns `automation.deskState()` (electron/automation.cjs:1592).
- **Subscriptions**: none of its own. The returned desk state is put into the parent state through `onDesk` (src/JournalView.tsx:57; src/RuntimeSettings.tsx:65); the 2-second poll refreshes it afterwards.
- **Saved state**: the engine database, tables `agent_triggers`, `agent_notes`, `conditional_orders` (electron/agent-desk.cjs:59, :76, :207). No renderer state.
- **Notes**:
  - Purpose labels (`PURPOSE`, src/AgentDesk.tsx:13): `stop_loss` "Stop loss", `take_profit` "Take profit", `entry` "Entry", `exit` "Exit", `other` "Order"; an unknown purpose shows raw.
  - Tag colour: `role-add` for a Buy, `role-trim` otherwise (src/AgentDesk.tsx:24).
  - Trailing-stop text (`trailText`, src/AgentDesk.tsx:8-12). Distance `d` is "`<pct>`%" or "`<distance>` (`<multiple>` × ATR)". Head, first match: awaiting fill: "trails `d` from the fill of its purchase · stop `<floor>` until then"; not active with an activation price: "trails `d` from `<activateAt>` · stop `<floor>` until then"; has a high: "trails `d` below the high · high `<high>` · stop now `<level>`"; else "trails `d` from the first price after the fill · stop `<level>`". Added parts: "trailing paused (off in settings)" when the trailing setting is off; "not tracked since `<HH:MM>`"; "not caught up: daily highs could not be read" (`catchUp.status==='unavailable'`); "not caught up: a capital change was filed" (`'skipped'`); "not tracked `<from>` to `<to>`" (last untracked span). Numbers: two decimals when the symbol contains ":" (U.S.), else rounded with thousands separators (src/AgentDesk.tsx:7-8).
  - `deskState()` returns `recentOrders` limited to 10 and `firedTriggers` limited to 5 (electron/automation.cjs:1592).
  - Dates use the system locale with month, day, hour, minute (src/AgentDesk.tsx:4).

### Trades: TradeOutcomes (Journal sub-tab)

- **Purpose**: Lists recorded fills with their after-fee result and evidence quality. (src/TradeOutcomes.tsx:4-13)
- **Component files**: `src/TradeOutcomes.tsx`, export `TradeOutcomes` (src/TradeOutcomes.tsx:4), internal `OutcomeHistory` (src/TradeOutcomes.tsx:17). Mounted at src/JournalView.tsx:56.
- **What it shows**:
  - Heading "Trade outcomes" (src/TradeOutcomes.tsx:8).
  - Empty state: "No recorded fills yet." (src/TradeOutcomes.tsx:9).
  - One disclosure per outcome; summary "`<symbol>` · `<side>` `<quantity>`/`<requested>` · `<environment>` · " then "`<gain>` after fees" for a sale or "Entry recorded" for a buy (src/TradeOutcomes.tsx:9).
  - Inside (src/TradeOutcomes.tsx:10-12): the evaluation text; when an assessment exists, figures "After-fee return", "Exit cost drag", "Evidence", "Evaluation" (percentages to two decimals, "Unknown" when null), the recommendation text, and a disclosure "Calculation & gaps" with "Acquisition basis: … · Before exit charges: …", the basis method, a list of gaps, and "No causal, benchmark or holding-period conclusion is implied."; figures "Execution", "Average price", "Fees & transaction taxes", "Cash movement", "Cost basis"; for a sale "After estimated tax: `<amount>` · `<tax status>`"; a disclosure "Evidence history · v`<version>`"; the linked decision's explanation or "No linked agent decision; manual order or older history."; small line "`<date time>` · `<market>` · Review `<8 chars or 'none'>`".
  - Evidence history rows: "v`<n>` · `<status>` · `<quantity>` shares · `<gain>` after fees" or "Result unknown"; "Loading versions…" while loading; "Could not load versions." on failure (src/TradeOutcomes.tsx:17).
  - Closing disclosure "Evidence coverage": "App-recorded fills only. Broker quantities are reported execution; fees and tax results are estimates. Entries await an exit outcome. Gains and losses alone do not prove decision quality." (src/TradeOutcomes.tsx:13).
  - Money: system-locale currency; "Unknown" when null (src/TradeOutcomes.tsx:7).
- **Controls**:
  - Select `aria-label="Outcome source"`: "All outcomes" (`all`), "Broker" (`broker`), "Paper" (`paper`); filters on `row.source` (src/TradeOutcomes.tsx:5-6, :8).
  - Disclosures: each outcome row, "Calculation & gaps", "Evidence history · v`<n>`" (opening it loads the versions), "Evidence coverage" (src/TradeOutcomes.tsx:9-13, :17).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `getOutcomeHistory(id)` (src/TradeOutcomes.tsx:17) | `runtime:outcome-history` (electron/preload.cjs:68) | main.cjs:740 | `automation.outcomes.history(id)` = `OutcomeLedger.history` (electron/outcome-ledger.cjs:91): up to 20 versions, newest first; throws `INVALID_REQUEST` for a non-string or an id over 200 characters |

- **Subscriptions**: none; the list comes from `state.outcomes` (history fetch, see Shared loader). The versions load each time the disclosure is opened (src/TradeOutcomes.tsx:17).
- **Saved state**: none. The source filter is renderer-only `useState` and resets when the sub-tab is left (src/TradeOutcomes.tsx:5).
- **Notes**: this list is not filtered by the account scope select (it takes only `outcomes`, src/JournalView.tsx:56).

### Lessons: LearningPanel (Journal sub-tab)

- **Purpose**: Review, approve, retire or reopen lessons drawn from completed trades; approved lessons are shown to the AI in later reviews. (src/LearningPanel.tsx:8)
- **Component files**: `src/LearningPanel.tsx`, export `LearningPanel` (src/LearningPanel.tsx:5), internal `LessonCard` (src/LearningPanel.tsx:12). Mounted at src/JournalView.tsx:58. Each card embeds `LessonTrials` (src/LearningPanel.tsx:15).
- **What it shows**:
  - Heading "Learning feedback" with "Optional. Nothing waits on it: no order, approval or money depends on these notes." (src/LearningPanel.tsx:8).
  - Summary: "Awaiting review `<n>`", "Approved `<n>`", "Expired `<n>`", "Last evaluation `<time>`" or "Not run" (from `state.learning`) (src/LearningPanel.tsx:8).
  - Alert when `learning.error`: "Local evaluation failed; learning records may be stale." (src/LearningPanel.tsx:8).
  - "Approved lessons are shown to the AI in later reviews. They don’t change trading rules." (src/LearningPanel.tsx:8).
  - When `state.reflections` exists: notice "AI reflection · `<reason>`", "`<n>` calls today · $`<x.xx>` accounted for", and a disclosure "Reflection queue" with one line per job "`<symbol>` · `<status>` · Attempt `<n>`/3 · `<model>` · `<error>`" or "Waiting for a completed sale." (src/LearningPanel.tsx:8).
  - Lesson cards for the filtered list, or "No lessons in this view." (src/LearningPanel.tsx:8).
  - Closing disclosure "Learning coverage": "Final sales produce candidates automatically. Partial fills wait for completion. Changed evidence revokes approval; approved lessons expire after the selected period. Retrieval stays within the same account and stock, with held positions prioritized. AI reflections are hypotheses for review. Forward experiments compare explicit exit rules with buy-and-hold. They do not validate arbitrary AI strategies." (src/LearningPanel.tsx:8).
  - Each card (`aria-label="Learning candidate"`, src/LearningPanel.tsx:15): title "Procedural reminder" (evidence kind `procedural`), else the symbol, else "Legacy observation"; a badge with `lifecycle.status`, else "approved"/"pending"; small line "Applies across this account · `<support>`" (procedural) or "`<environment|'Paper'>` · `<market|'KR'>` · Evidence v`<n>` · `<assessment category|'Checklist'>`"; the lesson text.
  - Reflection block when a completed reflection exists: "AI reflection · unvalidated" with "Observed:", "Unknown:", "Hypothesis:", "Suggested lesson:", "Applies when:"; a disclosure "Earlier reflection(s)" listing "Evidence v`<n>`" (plus " · without the entry and exit records" below version 2, plus the date) and its "Suggested lesson:" (src/LearningPanel.tsx:15).
  - Disclosure "Original decision" with `evidence.thesis` (src/LearningPanel.tsx:15).
  - Disclosure "Evidence quality": "`<confidence>` · Causal conclusion: unassessed", the gaps, and "Outcome `<id>` · Review `<8 chars|'Unlinked'>`" (src/LearningPanel.tsx:15).
  - With a lifecycle: the change reason, plus " · Review by `<date>`" when an expiry is set (src/LearningPanel.tsx:15).
  - Status message after an action (see Notes) (src/LearningPanel.tsx:14-15).
- **Controls**:
  - Select `aria-label="Lesson status"`: "Optional feedback" (`pending`, default), "Approved", "Expired", "Retired", "All lessons" (`all`) (src/LearningPanel.tsx:6, :8). `pending` matches lessons with no lifecycle or status `pending`/`needs-review`; the others match `lifecycle.status` exactly (src/LearningPanel.tsx:7).
  - "Use suggestion in draft": copies the reflection's lesson and applicability into the draft fields and shows "Suggestion copied to the draft. Review it before approving." (src/LearningPanel.tsx:15).
  - Disclosure "Edit lesson & applicability" (only with a lifecycle) holding: textarea "Reviewed lesson" (3 rows, max 2000, placeholder "What does this evidence support? Avoid assuming a loss proves a mistake."); textarea "When to apply" (`aria-label="Lesson applicability"`, 2 rows, max 1000); select "Review again in" (`aria-label="Lesson review period"`) with 7, 30, 90, 180, 365 "days" (src/LearningPanel.tsx:15).
  - Primary button "Approve for future reviews", or "Save & renew approval" when the status is `approved`; disabled while busy or when `evidence.assessment.eligible===false` (src/LearningPanel.tsx:15).
  - "Retire lesson", or "Reopen" when the status is `retired`; disabled while busy (src/LearningPanel.tsx:15).
  - No confirmation step on any of them (src/LearningPanel.tsx:14-15).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `reviewLesson(id,{action,expectedSignature,note,applicability,days})` (lessons with a lifecycle, src/LearningPanel.tsx:14) | `runtime:review-lesson` (electron/preload.cjs:70) | main.cjs:742 | `automation.syncLearning()`, then `automation.memory.review(id,value)` (electron/learning-memory.cjs:75) |
| `approveLesson(id,approved)` (lessons without a lifecycle, src/LearningPanel.tsx:14) | `runtime:lesson` (electron/preload.cjs:71) | main.cjs:743 | `automation.approveLesson(id,approved)` (electron/automation.cjs:1999) |

- **Subscriptions**: none of its own; lessons, `learning`, `reflections`, `lessonTrials` arrive in the 2-second state (src/RuntimeSettings.tsx:42; electron/automation.cjs:346).
- **Saved state**:
  - Engine: `memory.review` writes the lesson lifecycle (status, note, applicability, `approvedAt`, `expiresAt` = now + days), sets `lessons.approved`, and appends a `lesson_history` row (electron/learning-memory.cjs:83-84, :36).
  - Drafts (session memory only): `lesson:<id>:<signature>:note` and `lesson:<id>:<signature>:scope` (src/LearningPanel.tsx:13). The status filter and the review period are plain `useState` (src/LearningPanel.tsx:6, :13).
- **Notes**:
  - Review-period default: 90 when the lesson has `approvedAt` or status `approved`; otherwise `lifecycle.reviewDays`, else 30 (src/LearningPanel.tsx:13).
  - Result messages (src/LearningPanel.tsx:14): ok "Saved."; `LESSON_CHANGED` "Trade evidence changed. Review the updated record before approving."; `OUTCOME_NOT_FINAL` "Wait until this order is final."; any other error "Could not save. Check the lesson text and review period."; a thrown call "Could not save lesson."
  - Codes main.cjs can return for `runtime:review-lesson`: `LESSON_CHANGED`, `OUTCOME_NOT_FINAL`, `INVALID_LESSON_REVIEW`, `LESSON_NOT_FOUND`, else `LESSON_REVIEW_FAILED` (main.cjs:742). For `runtime:lesson`: `INVALID_REQUEST` (main.cjs:743).
  - Engine rules for a review (electron/learning-memory.cjs:76-82): action must be `approve`, `retire` or `reopen`; note at most 2000 characters; applicability non-empty and at most 1000; days an integer 1 to 365; approving needs `assessment.eligible`; approving a procedural lesson needs a non-empty note. Status after: `approved`, `retired`, or `pending` (reopen), with change reasons "Approved for context; not a validated strategy.", "Retired by user", "Reopened for review" (electron/learning-memory.cjs:83-84).
  - `memory.list()` returns at most 100 lessons (electron/learning-memory.cjs:86).
  - The card's React key includes the signature, so a card is rebuilt when the evidence signature changes (src/LearningPanel.tsx:8).

### LessonTrials (inside each lesson card)

- **Purpose**: A forward-only experiment that compares buy-and-hold with an explicit exit rule derived from the lesson. (src/LessonTrials.tsx:12; electron/lesson-trials.cjs:2)
- **Component files**: `src/LessonTrials.tsx`, export `LessonTrials` and type `LessonTrial` (src/LessonTrials.tsx:6-7). Mounted in `LessonCard` (src/LearningPanel.tsx:15).
- **What it shows**:
  - Disclosure "Test this lesson · `<n>` experiments" (src/LessonTrials.tsx:12).
  - Note "Compare holding against an exit rule built from this lesson.": "Translate the lesson into an explicit exit rule. Both simulated portfolios start at 100 on the first fresh price after you start. The unchanged baseline holds; the candidate exits on the next observed price after its trigger." (src/LessonTrials.tsx:12).
  - Note "Set costs. See what this comparison leaves out.": "Set costs for this instrument. Annual capital gains tax, FX, liquidity and whole-share constraints are excluded. No re-entry. Prices are sampled while the app is open; gaps may miss triggers. Paper-source lessons use synthetic prices. This is a rule comparison, not a replay of the AI strategy." (src/LessonTrials.tsx:12).
  - One notice per experiment: bold "`<status>` · `<n>` price samples"; the hypothesis; "`<rule>` · Trigger `<x>`% · Activation `<x>`% · Commission `<x>`% · Sale levy `<x>`% · Slippage `<x>`%"; "`<start>` → `<end>` · Gaps over 2 minutes: `<n>`"; a table with columns "Portfolio", "Net return", "Max drawdown", "Costs / 100" and rows "Buy & hold" and "Candidate"; "Return difference: `<x.xx>` percentage points · " then "Candidate exited", "Exit waiting for next price" or "Candidate holding"; before both arms exist: "Waiting for a fresh price for `<symbol>`."; "For exploration only. Nothing changes automatically." (src/LessonTrials.tsx:12).
  - Status message: "Collecting future prices." (started), "Experiment stopped." (stopped), the error code from the reply, or "Could not save experiment." (src/LessonTrials.tsx:10).
- **Controls**:
  - Textarea "Testable hypothesis" (max 2000, placeholder "Explain which part of the lesson this rule tests.") (src/LessonTrials.tsx:12).
  - Select "Candidate rule": "Exit below entry" (`loss-exit`), "Protect gains from peak" (`trailing-profit`) (src/LessonTrials.tsx:12).
  - Number inputs: "Drop trigger (%)", "Activate after gain (%)" (only for `trailing-profit`), "Commission each side (%)", "Sale levy (%)", "Slippage each side (%)", "Calendar days" (src/LessonTrials.tsx:12).
  - Button "Start forward test": disabled while busy, when the hypothesis is empty, when the lesson's assessment is not eligible, when the lesson is retired, or when one of its experiments is `collecting` (src/LessonTrials.tsx:12).
  - Button "Stop experiment": only on an experiment with status `collecting`; disabled while busy (src/LessonTrials.tsx:12).
  - No confirmation steps (src/LessonTrials.tsx:10-12).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `lessonTrial('start',lessonId,{...form,signature,numbers})` (src/LessonTrials.tsx:10) | `runtime:lesson-trial` (electron/preload.cjs:69) | main.cjs:741 | `automation.syncLearning()`, then `automation.trials.start(id,value)` (electron/lesson-trials.cjs:7) |
| `lessonTrial('stop',trialId)` (src/LessonTrials.tsx:10) | `runtime:lesson-trial` | main.cjs:741 | `automation.trials.stop(id)` (electron/lesson-trials.cjs:14) |

- **Subscriptions**: none; experiments come from `state.lessonTrials` (src/LearningPanel.tsx:8).
- **Saved state**: engine table `lesson_trials` (electron/lesson-trials.cjs:4, :6). The form is draft `trial:<lessonId>` (session memory only) (src/LessonTrials.tsx:8).
- **Notes**:
  - Form defaults: rule `loss-exit`, threshold 10, activation 5, fee 0.1, sale levy 0, slippage 0.1, days 30, hypothesis empty (src/LessonTrials.tsx:8).
  - Engine validation (electron/lesson-trials.cjs:9-11): `LESSON_CHANGED` when the lesson has no lifecycle, is not eligible, is retired or its signature differs; `INVALID_TRIAL` unless rule is `loss-exit` or `trailing-profit`, hypothesis is non-empty and at most 2000 characters, threshold is above 0 and at most 100, activation 0 to 100, each of the three cost percentages 0 to 10, and days an integer 1 to 365; `TRIAL_ACTIVE` when the lesson already has a collecting experiment. Stop: `TRIAL_NOT_FOUND` (electron/lesson-trials.cjs:14). main.cjs:741 also raises `LOCAL_EVALUATION_FAILED` and `INVALID_TRIAL` for an unknown action; which codes it passes back to the window is not determined (the handler line is longer than could be read).
  - The error code is shown raw, with no code-to-text table (src/LessonTrials.tsx:10).
  - `list()` returns at most 200 experiments (electron/lesson-trials.cjs:5).

### Scoreboard (Journal sub-tab)

- Mounted at src/JournalView.tsx:59 as `<Scoreboard/>` with no props, when the sub-tab "Scoreboard" is open. Documented by another agent.

### Replay: ReplayPanel (Journal sub-tab)

- **Purpose**: Re-runs saved reviews with a change next to an unchanged baseline and compares both with what prices did afterwards; places no orders. (src/ReplayPanel.tsx:4, :39)
- **Component files**: `src/ReplayPanel.tsx`, exports `ReplayPanel` (src/ReplayPanel.tsx:27), `failureText` (src/ReplayPanel.tsx:25), type `ReplayEstimate` (src/ReplayPanel.tsx:15). Mounted at src/JournalView.tsx:60. Renders nothing without `window.portfolio` (src/ReplayPanel.tsx:31).
- **What it shows**:
  - Heading "Replay" with "Test a change on past reviews before using it. Uses two AI calls per review; no orders." (src/ReplayPanel.tsx:39).
  - Confirmation block (`aria-label="Replay confirmation"`, Claude replays only, src/ReplayPanel.tsx:46-50): "`<n>` saved review(s), each sent twice: to your review model and to Claude Opus 5.5. The saved account data of these reviews goes to Anthropic. Nothing is traded."; "`<basis>`: about $`<x>` for Claude and $`<x>` for OpenAI, $`<x>` in all."; "The replay stops before a request that would take its measured spending past $`<cap>`. Each Claude request also needs about $`<x>` of room under your Anthropic daily limit while it runs; that is released when it finishes."
  - Warning text for errors (see Notes) (src/ReplayPanel.tsx:51).
  - For the latest run only (`runs[0]`, src/ReplayPanel.tsx:37):
    - Non-Claude summary: "Last run `<date time>`: `<n>` of `<m>` decisions changed", optionally " with the proposed built-in text", optionally " (on `<model>`, `<effort>` effort)", then " · excess return baseline `<x>` vs change `<x>` over `<k>` scored" (src/ReplayPanel.tsx:56).
    - Claude summary (`aria-label="Claude replay summary"`, src/ReplayPanel.tsx:52-55): "Last run … on Claude Opus 5.5, `<basis>`. Answers not accepted: `<formatFailures>` (`<n>` × `<rule>`; …). Refused: `<n>`. Failed otherwise: `<n>`. Markdown in explanations: `<text>`.", optionally " Answers in the enforced form: `<x>`; sent as text after a refusal: `<n>`; text parts dropped: …"; "Spent: $`<x>` Claude, $`<x>` OpenAI (estimated $`<x>` and $`<x>`); about `<n>` s per Claude answer.", optionally " Stopped by the replay cap|the Anthropic daily limit; `<n>` review(s) was|were not run."; "`<comparison>`: `<n>` of `<m>` decisions differ from the baseline. Results per review are below."
    - Table `aria-label="Replay results"`, columns "Day", "Original", "Baseline", "With change", "Baseline result", "Change result" (src/ReplayPanel.tsx:57). Day carries " *" when approximate. Decision cells read "Hold" or "`<action>` `<quantity>` `<symbol>`" (src/ReplayPanel.tsx:20), or a failure text in the negative style (src/ReplayPanel.tsx:26). Hovering the Baseline or With change cell shows that side's explanation as a tooltip (src/ReplayPanel.tsx:57). Result cells: signed percentage with two decimals, "waiting" when null, "—" when that side failed (src/ReplayPanel.tsx:21, :57). Changed rows get class `research-self` (src/ReplayPanel.tsx:57).
    - Note "How to read this": "Both columns re-run the same saved review without tools; only your change differs, so differences come from it. Results are excess returns against KOSPI or the S&P 500 over five trading days (a Buy gains with the stock, a Sell with its fall, a Hold scores zero). * marks reviews from before full contexts were saved, rebuilt from the console log." With the proposed text: "The change column uses the proposed built-in text; the baseline uses the current one." and, when any row has `filled`, " Reviews saved before extended sessions were recorded use your current extended-session settings on both sides." For Claude: "A replay has no research rounds, so its answers are not the same as a live review’s. With this few reviews the results do not show which model is better." Then the run's own `summary.note` (src/ReplayPanel.tsx:58).
- **Controls**:
  - Date input "From" (`aria-label="Replay from"`), default 7 days ago; date input "To" (`aria-label="Replay to"`), default today; both computed on a UTC+9 clock (src/ReplayPanel.tsx:23, :29, :40).
  - Number input "Reviews" (`aria-label="Replay reviews"`), min 1, max 12, default 4 (src/ReplayPanel.tsx:29, :40).
  - Textarea "Change to test" (`aria-label="Replay instructions"`, 3 rows, max 1500, placeholder "For example: Do not add to semiconductor stocks while the regime is risk-off.") (src/ReplayPanel.tsx:41).
  - Select "Run the change on" (`aria-label="Replay model"`): "Same model as reviews" (empty value), "GPT-6 Luna · no reasoning", "GPT-6 Luna · low", "GPT-6 Sol · low", "GPT-6 Sol · medium", "Claude Opus 5.5 · medium" (src/ReplayPanel.tsx:19, :42). Changing it clears a pending confirmation.
  - Money field "Stop when this replay has spent (USD)" (`label="Replay cap (USD)"`, min 0.5, max 100, default 3): shown only when the Claude model is chosen; changing it clears a pending confirmation (src/ReplayPanel.tsx:28, :43).
  - Checkboxes: "Without the market narrative", "Without similar episodes", "Without the regime gauge and sizing", "Built-in text: proposed" (src/ReplayPanel.tsx:44).
  - Primary button "Run replay" (reads "Replaying…" while busy; disabled while busy). For a non-Claude model it runs at once; for Claude it first asks for an estimate and shows the confirmation (src/ReplayPanel.tsx:36, :45).
  - In the confirmation: "Cancel" (closes it) and primary "Start replay" (disabled while busy) (src/ReplayPanel.tsx:50). This is the only confirmation step; there is no typed phrase.
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `listReplays()` (on mount, src/ReplayPanel.tsx:30) | `replay:list` (electron/preload.cjs:56) | main.cjs:407 | `{runs:automation.replays.runs(), busy:Boolean(automation.replaying)}`; `replays` is `ReplayStore` from electron/replay.cjs (electron/automation.cjs:122) |
| `estimateReplay(options)` (src/ReplayPanel.tsx:36) | `replay:estimate` (electron/preload.cjs:58) | main.cjs:409 | `automation.replayEstimate(options)` (electron/automation.cjs:1697): throws `REPLAY_UNAVAILABLE` when the AI is not available; returns null for a non-Claude plan |
| `runReplay(options)` (src/ReplayPanel.tsx:34) | `replay:run` (electron/preload.cjs:57) | main.cjs:410 | `automation.replay(options)` (electron/automation.cjs:1698) |

  Options sent: `from`, `to`, `limit`, `instructions`, `withoutNarrative`, `withoutEpisodes`, `withoutRegime`, `proposedText`, `model` (`{openaiModel,reasoningEffort}` or undefined) and, for Claude, `capUSD` (src/ReplayPanel.tsx:32, :34, :36). Both handlers return `{ok:false,error}` with the engine's code when it matches `^[A-Z_]{3,40}$`, else `REPLAY_FAILED` (main.cjs:409-410).
- **Subscriptions**: none. The list is read once on mount; a finished run is put at the top of the local list (src/ReplayPanel.tsx:30, :34). A replay running when the panel opens sets `busy` from the list reply, and nothing in this file clears it until the panel is mounted again (src/ReplayPanel.tsx:30) (inferred).
- **Saved state**: finished runs are kept by the engine's `ReplayStore` (electron/automation.cjs:122; storage details not determined). The form, the cap and the confirmation are plain `useState` and reset when the sub-tab is left (src/ReplayPanel.tsx:28-29).
- **Notes**:
  - Error texts (`ERRORS`, src/ReplayPanel.tsx:16-17), 9 codes: `INVALID_MODEL_SETTINGS` "That model and effort combination is not allowed."; `REPLAY_NO_CHANGE` "Add instructions, remove a section, pick another model or the proposed text to compare."; `REPLAY_NOTHING` "No saved reviews in that period."; `REPLAY_UNAVAILABLE` "Replay needs the AI decision maker and its key."; `AI_BUDGET_EXHAUSTED` "Daily AI budget reached."; `REPLAY_BUSY` "A replay is already running."; `CLAUDE_DRY_RUN_REQUIRED` "Claude replay needs one completed Claude dry run on this account."; `AI_NOT_CONNECTED` "Claude replay needs the Anthropic key in Connections."; `DATA_SHARING_NOT_ENABLED` "Claude replay needs "Share KIS data with Anthropic" in Connections."
  - Fallbacks: run "The replay did not finish. See Console."; estimate "Could not prepare the replay."; thrown call "Could not reach the engine." (src/ReplayPanel.tsx:34, :36).
  - Failure texts per row (`failureText`, src/ReplayPanel.tsx:25): `not-accepted` "Not accepted: `<rule or code>`"; `refused` "Refused (`<status>` `<errorType>`): `<message>`"; `limit` "Not run: Anthropic daily limit"; `stopped` "Not run: replay cap reached"; any other kind (`uncertain`) "Failed (`<code>`; may have been charged)".
  - Only the latest run is displayed; earlier runs are loaded but not shown (src/ReplayPanel.tsx:37, :52).

### Journal export

- The only caller of `exportJournal` is the Console's "Export interactions" button (src/AiConsole.tsx:67); the Journal tab itself has no export control (search of src/ for "exportJournal": src/AiConsole.tsx:67 and the type at src/main.tsx:38 only). See AI console below.

## AI console

- **Purpose**: Shows each review, scout run, replay, dry run or notice as a conversation between the app and the AI, built from the saved interaction events. (src/AiConsole.tsx:11; src/WorkspaceUX.tsx:22)
- **Component files**: `src/AiConsole.tsx`, export `AiConsole({events})` (src/AiConsole.tsx:57); internal `summarize`, `ContextCard`, `ThreadItem` (src/AiConsole.tsx:12, :26, :38). Mounted at src/main.tsx:151 when `tab==='AI console'`. Sidebar label "Console" (src/WorkspaceUX.tsx:7). It is the first tab when the window opens with `location.hash==='#console'` (src/main.tsx:43). Sidebar tooltip "Each review as a conversation between the app and the AI." (src/WorkspaceUX.tsx:22).
- **What it shows**:
  - Section `aria-label="AI conversations"` (src/AiConsole.tsx:66).
  - Empty state when the scoped event list has no runs: "No AI conversations yet", or "No AI conversations on `<account label>` yet" when the account filter hides existing events; below: "Choose All accounts to see earlier ones. " (only in that case) and "Run a review from Home to see it here." (src/AiConsole.tsx:68).
  - Events are grouped by `runId`; each group is sorted by timestamp; runs are sorted newest first (src/AiConsole.tsx:62).
  - Left list `aria-label="AI runs"`: per run a tone dot; bold "`<outcome>`" plus " · `<symbol>`" (when a symbol exists and the outcome is not Hold); small "`<trigger>`" plus " · `<account label>`" when all accounts are shown; time HH:MM (Asia/Seoul) and "today" or MM-DD (src/AiConsole.tsx:5-6, :70). "No runs match." when the search or filter leaves none (src/AiConsole.tsx:70).
  - Thread `aria-label="Conversation"` for the open run: head with the trigger as title; "`<YYYY-MM-DD>` `<HH:MM:SS>` KST · run `<8 chars>` · `<model>` · `<n>` tokens"; an outcome pill (src/AiConsole.tsx:72). Then one item per event that passes the search and the type filter (src/AiConsole.tsx:64, :73).
  - Thread items by event kind (src/AiConsole.tsx:38-56):
    - `Context`: card "What the AI saw" with facts (when present in the JSON body) "Account" (`kis-combined` shown as "Korea + U.S.", `local-paper` as "Paper", `kis` as "KIS"), "Stocks", "Positions", "News items", "Lessons", "Macro included", "Emergency active", and a disclosure "Inspect supplied context" with the formatted JSON (src/AiConsole.tsx:26-37).
    - `Agent` titled "Decision": bubble from "AI" with an action tag; for a non-Hold "`<symbol>` · `<quantity>` shares" plus " (`<credit>`)" when credit is set and not `none`; the explanation; "Plan: …" joined with " · " from thesis, "invalid if …", "stop …", "target …", "`<n>` days", "`<x>` confidence" (shown when the plan has a thesis or a stop price); "To scout" (plus " (run requested)") with "looking for …", "avoid …", questions, feedback items, or the reason (src/AiConsole.tsx:41). A body that is not JSON is shown raw.
    - `Agent` titled "Scout plan": bubble "AI" / "Portfolio plan" with the summary, target lines (role tag, name or symbol, " · `<weight>`%", thesis), "Watch: `<focus>`", brief answers, "Self-review: `<retrospective>`" (src/AiConsole.tsx:42).
    - Other `Agent` events: row "→" "AI asked: `<title>`" with the body shortened to 200 characters (src/AiConsole.tsx:43).
    - `Tool`: row "←" with the title and a disclosure whose summary is the body shortened to 160 characters and whose content is the formatted body (src/AiConsole.tsx:9, :44).
    - `Program`: bubble from "App" with the title and body (src/AiConsole.tsx:45).
    - `Risk`: row "◆" with title and body (src/AiConsole.tsx:46).
    - Any other kind (for example `System`): if the body is JSON with `inputTokens`: "`<title>`" and "`<n>` in · `<n>` out tokens · `<n>` cached"; if JSON with `wireBytes`: "`<x>` KB of `<x>` KB · dry run · largest: …" (up to three parts) with a disclosure "Details"; any other JSON object: the title with a disclosure whose summary is the body shortened to 120 characters; otherwise the title and the body shortened to 240 characters. Titles matching /fail|error/i get class `failed` in the last two forms (src/AiConsole.tsx:47-55).
  - Every item shows its time HH:MM:SS in Asia/Seoul (src/AiConsole.tsx:5, :39).
  - Footer: "The AI's private reasoning is not shown, only what was exchanged. " then "History is saved on this computer (latest 600 events)." (desktop) or "Browser preview history is temporary." (src/AiConsole.tsx:77).
- **Controls** (toolbar, src/AiConsole.tsx:67):
  - Text input `aria-label="Search interactions"`, placeholder "Search messages, context, or run ID…": case-insensitive substring match over each event's title, body and run id; runs with no matching event are hidden, and only matching events show in the thread (src/AiConsole.tsx:63-64).
  - Account scope select (see AccountScope): in 'account' scope only events whose `account` equals the connected account's key are used; shown only when an account is known (src/AiConsole.tsx:60, :67; src/AccountScope.tsx:6).
  - Select `aria-label="Event type"`: "All", "Program", "Context", "Tool", "Agent", "Risk", "System"; matches `e.kind` exactly (src/AiConsole.tsx:63, :67).
  - Button "Pause auto-scroll" / "Resume auto-scroll": toggles whether the thread end is scrolled into view when the number of shown events or the open run changes (src/AiConsole.tsx:65, :67).
  - Button "Export interactions": `exportJournal()`; no disabled state, no result message (src/AiConsole.tsx:67).
  - Run list buttons: click opens that run and clears the one-time focus (src/AiConsole.tsx:70). The open run is, in order: the focused run (from the Journal's "Open conversation"), the selected run, the first visible run (src/AiConsole.tsx:64).
  - Disclosures inside items: "Inspect supplied context", tool-result summaries, "Details" (src/AiConsole.tsx:36, :44, :52, :54).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `getEvents()` (called in `App`, src/main.tsx:129) | `events:get` (electron/preload.cjs:87) | main.cjs:840 | returns the in-memory `events` array, which is `store.getEvents()` after each append (main.cjs:106; electron/storage.cjs:36) |
| `onEvents(cb)` (in `App`, src/main.tsx:128) | broadcast `events:changed` (electron/preload.cjs:105-109) | sent at main.cjs:107 and main.cjs:854 | the whole events array is sent to every window |
| `getRuntime()` (src/AiConsole.tsx:59) | `runtime:get` | main.cjs:722 | `runtimeState()`; only `account` is read |
| `exportJournal()` (src/AiConsole.tsx:67) | `events:export` (electron/preload.cjs:5) | main.cjs:841 | a save dialog titled 'Export interaction journal', default file name 'portfolio-journal.json', JSON filter; on a chosen path writes `{exportedAt, events, reviews: automation.getState().reviews, lessons: automation.getState().lessons}` as indented JSON |
| `runDemo()` (declared only, src/main.tsx:38; no caller in src/) | `demo:run` (electron/preload.cjs:96) | main.cjs:842-857 | throws `TEST_ONLY` unless the environment variable `PORTFOLIO_SMOKE_DATA` is set; otherwise builds `domain.demoEvents(...)` from the synthetic state and appends one event every 400 ms, broadcasting `events:changed` after each; ignores a call while one is running |

- **How events are appended and broadcast**: `interaction(runId,kind,title,body)` (main.cjs:101-108) does nothing while the app is closing; shortens a title over 500 characters and a body over 32000 characters, adding "… [shortened from `<n>` characters]"; adds the account key and label from `automation.accountTag()` when there is one; calls `store.appendEvent`; reloads `events` from the store; and sends `events:changed` with the full array to all windows. A storage error is swallowed and nothing is broadcast (main.cjs:106). `appendEvent` requires string `id`, `runId`, `timestamp`, `kind`, `title`, `body` of at most 32000 characters each, keeps optional `account` and `accountLabel` of at most 200 characters, inserts with `INSERT OR IGNORE`, and deletes all but the latest 600 rows (electron/storage.cjs:20-35). There is no renderer write API for events (electron/storage.cjs:21).
- **Subscriptions**:
  - `App` subscribes to `events:changed` before requesting `events:get`; the fetched list replaces the state only when it is not shorter than what a broadcast already delivered (src/main.tsx:128-129). On failure the app-level alert reads "Could not load console events." (src/main.tsx:129, :135).
  - `AiConsole` polls `getRuntime()` on mount and every 30000 ms to learn the connected account (src/AiConsole.tsx:59).
- **Saved state**:
  - Events: the app database table `events`, latest 600 (electron/storage.cjs:31-32).
  - Drafts (session memory only): `console:query`, `console:filter` (default 'All'), `console:scroll` (default true), `console:run` (selected run), `history:accounts` (shared with the Journal) (src/AiConsole.tsx:58, :61). `console:focus` is a one-time value set by the Journal and removed when read (src/AiConsole.tsx:61; src/useDraftState.ts:8).
  - The export writes a file the user picks (main.cjs:841).
- **Notes**:
  - **main.tsx `query`, `filter`, `scroll`**: `App` declares `query`, `filter`, `scroll` and a ref `end` (src/main.tsx:66-69), an effect that scrolls `end` into view (src/main.tsx:132) and a filtered list `shown` (src/main.tsx:133). None of them is passed to `AiConsole`, which receives only `events` (src/main.tsx:151) and keeps its own `query`, `filter`, `scroll`, `end` (src/AiConsole.tsx:61). `end` is not attached to any element in `App`'s JSX and `shown`, `setQuery`, `setFilter`, `setScroll` are not used there (src/main.tsx:135-152). They are leftovers with no effect on screen.
  - Run outcome and tone (`summarize`, src/AiConsole.tsx:12-24). Outcome, first match:

| Condition | Outcome | Tone |
|---|---|---|
| any event title matches /fail\|error/i | "Failed" | `failed` |
| an event titled "Scout plan" | "Plan" | `scout` |
| an event titled "Dry run · inputs checked" or "Dry-run review · nothing applied" | "Dry run" | `done` |
| not a dry run and no event of kind Program/Agent/Context and no "Review completed"/"Replay finished" | "Notice" | `done` |
| the Decision body has `withheld` | "Buy withheld" | the action in lower case |
| the Decision body has an `action` | that action (Buy, Sell, Hold, …) | the action in lower case |
| any title matches /reflection/i | "Reflection" | `done` if finished, else `running` |
| an event titled "Review completed" or "Replay finished" | "Completed" | `done` |
| otherwise | "In progress" | `running` |

  - Run trigger: the title of the first `Program` event, else the first event's title (src/AiConsole.tsx:23). Model: the first word of the body of the "Model used" event (src/AiConsole.tsx:15, :23). Tokens: input plus output tokens from the "Review completed"/"Replay finished" body (src/AiConsole.tsx:15, :23).
  - The account filter leaves out events saved before accounts were recorded; they show only under "All accounts" (src/AccountScope.tsx:1-2; src/AiConsole.tsx:60).
  - Auto-scroll uses `scrollIntoView({block:'nearest'})` (src/AiConsole.tsx:65).
  - The export includes `reviews` for the connected account only (`getState().reviews`, electron/automation.cjs:346 `reviewHistory(50)`) and all listed lessons; it does not apply the search, type or account filters of the screen (main.cjs:841).
  - Home attention items that open this tab ("See details"): `review-backoff`, `provider-wait-<vendor>`, `review-error` (main.cjs:614, :616, :617).

## Discover

"D" = `src/Discover.tsx`.

- **Purpose**: Research page for one market at a time: today's market overview, the AI market narrative, a listing search, the account's watchlist, a KIS ranking screener, the AI scout's plan, and the symbol-list status (D:60-96).

- **Component files**: `src/Discover.tsx` exports `Discover({onOpenChart,onNavigate})` (D:24) and types `Security`, `WatchEntry`, `ScreenRow`, `ScreenResult`, `DiscoveryState`, `DiscoveryReply` (D:7-15). Mounted at `src/main.tsx:139` with `onOpenChart={openCompany}` and `onNavigate={go}`. Sub-panels, in page order: `QuickLook` (D:61, only when a name was clicked), market tabs (D:62), `MarketPulse` or `USMarketPulse` (D:63), `MarketNarrative` (D:64), "Find a listing" (D:65), "Watchlist" (D:73), "Market screener" (D:77), `ScoutPanel` (D:91), "Symbol list" (D:92).

- **What it shows** (page-level parts; sub-panels have their own sections below):
  - Without the desktop bridge: "Use the desktop app for market discovery." (D:50).
  - **Find a listing** (D:65-72): results table (aria-label "Search results") with columns "Symbol", "Name", "Market", "Type", and a hidden-label "Watchlist" column; 10 rows per page (`PAGE_SIZE`, D:21); the name cell adds the English name when different (D:70); type labels: Stock, ETF, ETN, REIT, Fund, Warrant, Other, "Unlisted" for unknown (D:23). Pager text "<a>–<b> of <n>" (D:71). Empty: "No matching listings." (D:71). The last column shows an "Add" button or the badge "WATCHING" (D:53).
  - **Watchlist** (D:73-76): heading "Watchlist" with badge "<n> / 30". Intro: "Watching means monitoring: the AI considers these in its reviews and can propose trades in them. " then, when monitoring mode is 'on', "A review starts when an entry level the AI set is crossed, or on a <watchlistPct>% move, with alerts grouped into one review."; otherwise "For now any <holdingPct|3>% move starts a review" plus "; selective watchlist alerts are being observed" in 'observe' mode, then "."; then " Pin an AI pick to keep it." (D:74). Tooltip: "Watchlist symbols are quoted with your holdings (up to 20 per market). The AI may add up to 10 entries with a reason and replaces its oldest unpinned entry when full; it cannot remove yours. Your trading allowlist and caps still decide what can be ordered." (D:74).
    - Not connected: "Connect your KIS account in Connections to keep a watchlist for it." (D:75). Empty: "Add stocks from search or the screener." (D:75).
    - Table (aria-label "Watchlist entries"), columns "Symbol", "Name", "Price", "Day", "Reason", hidden-label "Actions" (D:75). The name cell has a sub-line "<Type> · <You | AI | AI · pinned> · <Mon D>" (tooltip "Added <date> by you|the AI") and a monitoring line: "No price reviews" | "Holding · review on <pct>% moves" | "Entry level · review when it crosses above|below <price> USD|KRW" | "Watching · alert on <pct>% moves" (D:14, D:75). Price tooltip "Updated <time>" or "Not quoted yet"; "—" with no quote (D:75). "Day" is the change text with a small bar centred on zero (±10% fills it) (D:58-59). "Reason" shows the entry's reason or "—" (D:75). A row flashes up/down for 1400 ms when its price changes (D:36-37).
  - **Market screener** (D:77-90): heading "Market screener"; status "Loading…" with a spinner, or "Updated <time> · next in <s>s" (D:77). Not connected: "Connect KIS in Connections to see market rankings." (D:83). Error line with the mapped text (D:83). First load: six skeleton rows (aria-label "Loading rankings") (D:85). Table (aria-label "Screener results"): "Symbol", "Name" (+ " · <Type>"), sortable "Price", "Change", "Volume", "Market value", and an Add/WATCHING column (D:86). Empty: "No rows match the filter." or "No results match the selected type." (D:86). Footer: "KIS rankings, refreshed every minute. Click a column to sort and a name for a quick look. A ranking is not a trade signal." with tooltip "Korean codes containing letters, such as some preferred shares, cannot be traded in this app and are left out." (D:89).
  - **Symbol list** (D:92-94): heading "Symbol list"; "<n> listings · updated <date time>" or "Downloading the symbol list…"; tooltip "KOSPI, KOSDAQ, NASDAQ, NYSE and AMEX, downloaded daily from KIS public master files." (D:92). Error: "Some markets could not be refreshed: <error>. Previous listings remain in use." (D:93).
  - Page notice (role status, error style) at the bottom with the last failed action's text (D:95).

- **Controls**:
  - Market tabs (aria-label "Discover market"): "Korea", "U.S." (D:62). Switching also sets the screener market and the search-market filter (D:30).
  - Search: text input (aria-label "Search securities", placeholder "Company name, Korean code or U.S. ticker"; Enter runs the search); select (aria-label "Search market") "All markets" / "Korea" / "U.S."; button "Search" (primary; disabled while busy or with an empty query) (D:66).
  - Result rows: symbol link → `onOpenChart(symbol)`; name link → opens QuickLook; "Add" → `updateWatchlist('add',symbol,'')` (disabled while busy or not connected) (D:53, D:70). Pager "‹ Previous" / "Next ›" (D:71).
  - Watchlist rows: symbol link (chart), name link (QuickLook), "Pin" / "Unpin" (AI entries only), "Remove" (aria-label "Remove <symbol>"); disabled while busy; no confirmation (D:75).
  - Screener: "Refresh" (disabled while loading) (D:77); selects "Market" ("Korea (KOSPI + KOSDAQ)", "U.S."), "Exchange" (US only: "NASDAQ", "NYSE", "AMEX"), "Ranking" ("Trading volume", "Top gainers", "Top losers", "Market value"), "Security type" ("Stocks", "ETFs", "Any except warrants") (D:78-81); filter input (aria-label "Filter screener results", placeholder "Filter by name or code") shown when connected with results (D:82); sortable column heads with " ▲" / " ▼" (first click sorts descending; a second click reverses) (D:57).
  - Symbol list: "Refresh symbol list" (text "Downloading…" and disabled while refreshing or busy) (D:92).

- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Module method |
|---|---|---|---|
| `getDiscovery()` | `discovery:get` | main:682 | returns `discoveryState()` (main:680): `master.status()`, `automation.discovery.list()`, `connected`, `automation.monitoring()` (`electron/automation.cjs:1321`) |
| `getWatchQuotes()` | `discovery:quotes` | main:684 | reads the in-memory `kisQuotes` map and `automation.usQuotes`; no broker call (main:683 comment) |
| `searchSecurities(query, market)` | `discovery:search` | main:685 | `master.search(query,{market,limit:30})` (security master) |
| `screenMarket(query)` | `discovery:screen` | main:686 | `screener.screen(query)` (`electron/discovery.cjs:28`); `KIS_NOT_CONNECTED` with no snapshot |
| `updateWatchlist(action, symbol, value)` | `discovery:watch` | main:687 | `watchlist.add / remove / pin` (`electron/discovery.cjs:13`, `:22`, `:23`); `add` also triggers a quote poll |
| `refreshSecurityMaster()` | `discovery:refresh-master` | main:688 | `master.refresh(true)` |
| `getMarketOverview(refresh)` | `research:market` | main:379 | `research.market(refresh)` (`electron/research-service.cjs:160`) |
| `getUSMarketOverview(refresh)` | `research:us-market` | main:381 | `research.usMarket(refresh)` (`electron/research-service.cjs:161`) plus the `US_VIX` series from `macro.get()` |
| `refreshNarrative()` | `narrative:refresh` | main:401 | `automation.buildNarrative()` (`electron/automation.cjs:1767`) |
| `hideNarrativeDriver(id, hidden)` | `narrative:hide` | main:402 | `automation.narratives.hide(id, hidden)`; returns `narrativeState()` (`electron/automation.cjs:1796`) |
| `runScout()` | `scout:run` | main:725 | `automation.scout()` (`electron/automation.cjs:1874`) |
| `getRuntime()` | `runtime:get` | main:720 | `runtimeState()` (used by MarketNarrative and ScoutPanel) |
| `getResearch(symbol, sections)` | `research:company` | main:446 | used by QuickLook; not traced |
| `openNews(url)` | `runtime:open-news` | main:743 | opens the URL externally only if it is a known news item URL |

  Discovery replies are `{ok, data, state}`; an error code that is not `[A-Z_]{3,40}` becomes `DISCOVERY_FAILED` (main:681).

- **Subscriptions** (all timers; no broadcast listeners):
  - `getDiscovery` every 5000 ms (D:31).
  - `getWatchQuotes` every 4000 ms while connected (D:38).
  - A 1000 ms clock for the "next in <s>s" countdown (D:39).
  - The screener reloads on any filter change, on "Refresh", and every 60000 ms while connected; stale replies are ignored by a sequence number (D:41-49). The main side also caches each ranking for 60 s (`CACHE_MS`, `electron/discovery.cjs:4`, `:31`).

- **Saved state**:
  - Watchlist entries: SQLite table `watchlist`, keyed by scope (the KIS `accountKey`, main:360) and symbol (`electron/discovery.cjs:8`). User entries are saved pinned (`pinned: source==='user'`, `electron/discovery.cjs:20`).
  - Renderer drafts (session memory): `discover:query`, `discover:query-market`, `discover:screen` (default `{market:'KR',exchange:'NASD',kind:'volume',type:'stock'}`), `discover:market` (D:26-29). Results, page, filter, sort and the QuickLook selection are component state only (D:26, D:33).

- **Notes**:
  - Code-to-text table `errors` (D:16; 5 entries): KIS_NOT_CONNECTED → "Connect your KIS account in Connections first."; UNKNOWN_SYMBOL → "That symbol is not in the downloaded symbol list."; WATCHLIST_FULL → "The watchlist is full (30). Remove an entry first."; INVALID_WATCHLIST → "Invalid symbol."; RATE_LIMITED → "KIS is rate limiting requests. Try again shortly." Any other code → "The request could not be completed." (D:17). A thrown call → "Could not reach the engine." (D:46, D:51).
  - Watchlist limits: 30 entries in total, at most 10 unpinned AI entries; a new AI entry evicts the oldest unpinned AI entry; user entries are never evicted (`electron/discovery.cjs:4`, `:12`, `:18-19`). Reasons are cut to 300 characters (main:687). The UI adds with an empty reason (D:53).
  - The screener asks for `limit:30` (D:45); the engine clamps the limit to 1–30 (`electron/discovery.cjs:29`) and drops symbols that are not six digits (KR) or exchange:ticker (US) (`electron/discovery.cjs:32`).
  - The search returns at most 30 rows (main:685).
  - Sorting is client-side on the loaded rows; rows with no value sort last (D:56).

### MarketPulse / USMarketPulse

- **Purpose**: Today's market overview for the selected market (`src/MarketPulse.tsx:4`, `:31`).
- **Component files**: `src/MarketPulse.tsx` exports `MarketPulse` (:11) and `USMarketPulse` (:34), type `USMarketReply` (:33); mounted at D:63.
- **What it shows**:
  - Korea (aria-label "Korea market today"): heading "Korea market today"; "Loading…" or "Updated <time>" (:20). Unavailable: "Connect your KIS account to see the market." (reason KIS_NOT_CONNECTED) or "Market data is not available right now." (:21). Per index: name, level, change %, an advance/flat/decline bar (aria-label "<n> advancing, <n> declining"), "<n> up · <n> down" plus " · <n> limit up" / " · <n> limit down" (:22-24). "KOSPI sectors" (with " · strongest and weakest" when more than 10; then the first 5 and last 5 are shown) (:17, :25). "Foreigners are buying" and "Institutions are buying": top 5 names with net buying in compact ₩; empty "No data yet today." (:18, :26). Note "About this data": "KIS data. Sector moves compare with the previous close. Foreign and institutional buying are preliminary intraday tallies by value and change through the day." (:27).
  - U.S. (aria-label "U.S. market today"): heading "U.S. market today" (:42); same loading/unavailable texts (:43); index ETFs with label, ticker link, price, change % (:44); "VIX volatility" with value, change and "Close <date>" (:45); "S&P sectors · strongest to weakest" (:46); Note "About this data": "KIS quotes of ETFs that track each index and the Select Sector SPDR funds for the sectors; change is against the previous close. KIS does not provide U.S. advance/decline counts or investor flows. VIX is the latest daily close from FRED." (:47).
- **Controls**: "Refresh" (disabled while busy) → reload with `refresh=true` (:20, :42). Name/ticker links → `onOpenChart(symbol)` (:18, :44).
- **Calls and channels**: `getMarketOverview(refresh)` → `research:market` (main:379); `getUSMarketOverview(refresh)` → `research:us-market` (main:381).
- **Subscriptions**: none; loads once on mount and on "Refresh" (:14, :37).
- **Saved state**: none in the renderer. The main side caches the overview in the research cache (main:387 `research.cached('MARKET','market')`).
- **Notes**: VIX colour is inverted (a rise is shown in the negative tone) (:45).

### MarketNarrative

- **Purpose**: "What's driving the market": the AI's confirmed market drivers, a regime gauge, and similar past episodes (`src/MarketNarrative.tsx:3`).
- **Component files**: `src/MarketNarrative.tsx` exports `MarketNarrative` (:17) and type `NarrativeState` (:6); internal `EpisodeRow` (:11). Mounted at D:64. Renders nothing until the runtime state has a `narrative` (:20).
- **What it shows**:
  - Heading "What's driving the market"; status "Reading headlines…" | "Updated <n min ago | n h ago | date> · weekdays 08:30 and 16:30" | the `blocked` text | "Not built yet" (:25).
  - Regime gauge (aria-label "Regime gauge"): "Gauge: Risk-on|Neutral|Risk-off" and one chip per component "<name> · <reading>" (tooltip "<name>: <value>") (:7, :26).
  - Warning note after a failed update: "Daily AI budget reached." (AI_BUDGET_EXHAUSTED), else the `blocked` text, else "The narrative could not be updated. See Console." (:21, :27).
  - Summary line: regime tag + summary (:28).
  - Driver list (aria-label "Market drivers"): tag "Trigger" or "Background"; title; theme chips; summary; "Confirmed by: <observations>" or "Not confirmed by market data, so the agents do not see it."; " · Affects <list>"; " · <confidence> confidence · since <date>"; "Sources: <source links>" (:29-33). Hidden or unconfirmed drivers are greyed (:29).
  - Theme chip labels (`THEME`, :8; 17 entries): rates "Rates", inflation "Inflation", growth_slowdown "Growth", geopolitics "Geopolitics", oil_energy "Oil", fx_dollar "Dollar", credit_stress "Credit", ai_profitability "AI profits", ai_demand "AI demand", semiconductor_cycle "Chip cycle", china_competition "China", trade_tariffs "Tariffs", policy_regulation "Policy", earnings "Earnings", korea_policy "Korea policy", liquidity_flows "Flows", other "Other".
  - "Similar past episodes" list (aria-label "Similar episodes"): "<day> · <title>", badge "<n>% similar", the drivers or "No drivers recorded", and "After 1 / 5 / 20 trading days: KOSPI … · SPX … · SOX …" or "not enough days yet" (:12-15, :35).
  - Note "Episode library · <n>" with the full list and "Days when KOSPI, the S&P 500, Nasdaq or the semiconductor index moved sharply, with the drivers of the day and what indices did afterwards." (:36).
  - Footer: "Hidden drivers stay here but the agents stop reading them." (:37).
- **Controls**: "Update now" (text "Updating…" while busy; disabled while busy or when `blocked` is set) → `refreshNarrative()` (:21, :25). Per confirmed driver: "Hide" / "Show" (aria-label "Hide|Show driver <title>") → `hideNarrativeDriver(id, hidden)` (:22, :34). Source links → `openNews(url)` (:33).
- **Calls and channels**: `getRuntime()` → `runtime:get` (main:720), fields `narrative` and `regime`; `refreshNarrative()` → `narrative:refresh` (main:401); `hideNarrativeDriver` → `narrative:hide` (main:402); `openNews` → `runtime:open-news` (main:743).
- **Subscriptions**: polls `getRuntime` every 10000 ms (:19). It does not use `subscribeRuntime`.
- **Saved state**: a driver's hidden flag is saved by `automation.narratives.hide` (main:402; store not traced). Nothing in the renderer.
- **Notes**: `narrativeState()` returns the latest narrative, up to 20 episodes, up to 3 similar episodes (minimum score 0.2), `busy`, `blocked`, `error`, `enabled` (`electron/automation.cjs:1796`). A refresh error code that is not `[A-Z_]{3,40}` becomes `NARRATIVE_FAILED` (main:401).

### QuickLook

- **Purpose**: A quick look at one listing without leaving Discover: price, trend line, key numbers and the analyst or fund line (`src/QuickLook.tsx:3`).
- **Component files**: `src/QuickLook.tsx` exports `QuickLook({symbol,name,watching,onClose,onOpen,onWatch})` (:7); rendered at the top of Discover when a name is clicked (D:61). Uses `Spark` from `src/ResearchPanel` (:2).
- **What it shows**: heading = name; sub-line "<symbol> · <TYPE> · <sector>" (:18). "Loading…" until the overview arrives; "No quote available right now." when it is not ok (:19). Price and change % (:20); a sparkline of closes (:21); six stats "Market cap", "PER", "PBR", "52-week range", "1-month return", "Volatility" (:22). Analyst line: "<n> brokerages · <n> Buy · <n> Hold · <n> Sell · median target <x> (<±%>)" plus " · <n> raised, <n> cut in 90 days" (:23). Fund line: "<index|Fund> · <issuer> · <n>× daily · premium <±%> · net assets <₩…>" (:24). Badge "WATCHING" when already listed (:26).
- **Controls**: "Close" (aria-label "Close quick look"); the Escape key also closes (:14, :18). "Full research and chart" (primary) → `onOpen` → `onOpenChart(symbol)` (:26, D:61). "Add to watchlist" → `updateWatchlist('add',symbol,'')` (:26, D:61).
- **Calls and channels**: `getResearch(symbol,['overview'])`, then `['risk']`, then one of `['financials']` (U.S. symbols), `['fund']` (ETF/ETN) or `['analysts']` → `research:company` (main:446) (:11-12).
- **Subscriptions**: a window `keydown` listener for Escape (:14). No timers.
- **Saved state**: none.
- **Notes**: for a U.S. symbol the third section fetched is `financials`, which this panel does not display (:12, :15).

### ScoutPanel

- **Purpose**: Shows the AI scout's latest plan and lets the user run the scout now (`src/ScoutPanel.tsx:20`).
- **Component files**: `src/ScoutPanel.tsx` exports `ScoutPanel({onOpenChart,onNavigate})` (:21) and `failedLine` (:19); styles in `src/scout.css` (12 lines; not read in detail). Mounted at D:91. Renders nothing until the runtime state has `scout` (:24).
- **What it shows**:
  - Heading "AI scout"; status "Researching the market…" | the `blocked` text | "Updated <just now | n min ago | n h ago | date> · <model>" | "No plan yet"; plus " · next: <times>" when scheduled runs are on and not blocked (:27, :29).
  - Warning note after a failed run (see Notes) (:31). After a failed run that kept an older plan (aria-label "Last scout run"): "Last run gave no plan; the plan from <MM-DD HH:MM> is kept." or "Last run failed; the plan from … is kept." (KST stamp) (:18-19, :32).
  - No plan: "The scout studies rankings, analyst views and estimates, picks a shortlist for your watchlist and writes a plan the trading reviews follow." plus " Turn on scheduled runs in Engine settings → Schedule and triggers." when scheduled runs are off (:33).
  - Plan: summary paragraph (:34); "Cash target <n>%" and "Watch <focus>" (:35); table (aria-label "Scout plan") with columns "Stock", "Role", "Target", "Why" (role tags Hold, Add, Candidate, Trim, Exit, :5; tooltip "Risks: …") (:36).
  - "Too large to buy · alternatives checked": per stock, the reason and alternatives tagged "Chosen", "Rejected" or "Not researched" (:37-40).
  - "From trading reviews": answered briefs (question and answer) and pending briefs with "Run requested · " (when requested) and "Next run answers this" (:41-44).
  - "Self-review <text>" (:45).
  - Note with a score line as its summary: "Past picks: <n> of <n> beat the market over 20 trading days" (or "5 trading days"), with " (too few to judge)" for a small sample, or "Past picks: <n> tracked, first results after 5 trading days" (:10-15). Inside: table (aria-label "Scout pick results") with columns "Pick", "Picked", "5 days", "20 days", "Trading" (a dropped pick shows " dropped"; "Trading" shows the review's verdict or Bought / Proposed / Recommended / "—", :8) and "Return minus KOSPI or the S&P 500, from the close on the pick day. The scout reads this before each run." (:47-49).
- **Controls**: "Research log" link button (only when the latest plan has a `runId`) → `onNavigate('AI console')` (:30). "Run scout" (primary; text "Researching…" while busy; disabled while busy or blocked; tooltip = the `blocked` text or "Research the market now and update the shortlist and plan") → `runScout()` (:26, :30). Stock links → `onOpenChart` (:36, :38-39).
- **Calls and channels**: `getRuntime()` → `runtime:get` (main:720), field `scout`; `runScout()` → `scout:run` (main:725) → `automation.scout()` (`electron/automation.cjs:1874`); on failure the reply's error is `automation.scoutError ?? 'SCOUT_FAILED'` (main:725).
- **Subscriptions**: polls `getRuntime` every 4000 ms (:23).
- **Saved state**: none in the renderer.
- **Notes**: code-to-text table `ERRORS` (:16; 5 entries): AI_BUDGET_EXHAUSTED → "Daily AI budget reached"; SCOUT_BUSY → "A scout run is already going"; RATE_LIMITED → "KIS is rate limiting; try again shortly"; AI_TIMEOUT → "The AI took too long"; STALE_DECISION → "The account changed during the run". Other codes: "The scout run stopped: <lastErrorDetail>." when a detail exists, else the `blocked` text, else "The scout run did not finish. See Console." (:26). A thrown call → "Could not reach the engine." (:26).

## News

- **Purpose**: Shows headlines and DART disclosures matched to the user's stocks, and holds the news sources and the news-triggered review setting. (src/NewsView.tsx:12-22; src/WorkspaceUX.tsx:23)
- **Component files**: `src/NewsView.tsx`, export `NewsView` (src/NewsView.tsx:6); `src/NewsSources.tsx`, export `NewsSources` (src/NewsSources.tsx:6), mounted inside "Manage sources" (src/NewsView.tsx:21). `NewsView` is mounted by `RuntimeSettings` in news mode (src/RuntimeSettings.tsx:63), mounted at src/main.tsx:150. Sidebar tooltip "Headlines and DART disclosures for your stocks." (src/WorkspaceUX.tsx:23).
- **What it shows**:
  - Section `aria-label="News headlines"`, heading "Headlines & disclosures"; small line "Updated `<date time>`" or "Not refreshed yet", " · `<n>` items · `<n>` about your symbols" (src/NewsView.tsx:12).
  - Items: `state.newsEvents` when present; otherwise `state.news` mapped to events (kind `disclosure` when the source is 'DART', else `headline`; no symbols; importance `normal`) (src/NewsView.tsx:8).
  - Summary: "News feed" = "Configured" / "Not connected" (from `config.newsURL`); "Corporate disclosures" = "Open DART connected" / "Not connected"; "Refresh" = "Every 5 minutes" when scheduled reviews are enabled and the news trigger is not `off`, else "Every 30 minutes"; "Last news-triggered review" = a time or "None this session" (src/NewsView.tsx:11, :13).
  - Error notice when `state.newsError`: "Refresh failed. Headlines may be out of date." (src/NewsView.tsx:14).
  - Each item (`article.news-entry`, src/NewsView.tsx:16): small "`<source>` · `<published or 'Date unavailable'>`" plus " · Triggered a review" when `triggeredAt`; the title, preceded by a badge "IMPORTANT" when importance is `high`; matched symbols as badges (`aria-label="Matched symbols"`); and on the right either a "Read source ↗" button (https links) or the source name in muted text.
  - Empty states: "No matching headlines." (items exist but none match) or "No headlines yet. Connect a feed or Open DART, then refresh." (src/NewsView.tsx:16).
  - Disclosure "Sources and review triggers" (`aria-label` the same); open by default when there is no `newsURL` and DART is not connected (src/NewsView.tsx:17).
    - Note "Matched to your stocks by code, name or ticker.": "Items are matched to your holdings, watchlist, trading allowlists and AI-watched symbols by stock code, company name or ticker. AI reviews receive matched items first, then the latest general headlines. Full articles are not included." (src/NewsView.tsx:18).
    - Note "Which disclosures trigger a review": "Important disclosures include capital raises, mergers and splits, earnings, large supply contracts, control changes, trading halts, delisting risk and legal events. At most one news-triggered review runs every 10 minutes; events arriving meanwhile are reviewed together. Scheduled reviews must be enabled, and API budgets and guardrails still apply." (src/NewsView.tsx:20).
    - Inner disclosure "Manage sources" (same default-open rule) with the feed URL field, "Add an Open DART key in Connections for disclosures.", and `NewsSources` (src/NewsView.tsx:21).
  - `NewsSources` (src/NewsSources.tsx:14-22): heading "Feeds · `<n>`/10"; a list `aria-label="News feeds"` with each feed's label (or the URL's host name) and URL; "Suggested: " followed by link buttons for suggested feeds not yet added, and " · Add all" when more than one is missing; two switch rows; a warning text after a failed save.
- **Controls**:
  - Primary button "Refresh news" ("Refreshing…" while busy): disabled while busy or when there is neither `config.newsURL` nor a DART connection; calls `refreshNews()` (src/NewsView.tsx:12; src/RuntimeSettings.tsx:48, :63).
  - Text input `aria-label="Filter headlines"`, placeholder "Filter headlines or symbols…": case-insensitive match on the title or any matched symbol (src/NewsView.tsx:10, :15).
  - Select `aria-label="News source"`: "All sources" plus each distinct source in the items (src/NewsView.tsx:9, :15).
  - Checkbox `aria-label="Only news about my symbols"`, label "Only my symbols": keeps items with at least one matched symbol (src/NewsView.tsx:10, :15).
  - Button "Read source ↗": `openNews(url)`; shown only for URLs starting with `https:` (src/NewsView.tsx:16).
  - Select "News-triggered reviews" (`aria-label` the same; disabled while busy): `off` "Off", `disclosures` "Important disclosures for my symbols", `all` "Any news about my symbols" (src/NewsView.tsx:5, :19). Changes the draft only; saved by "Save news settings".
  - Input "Public RSS / Atom feed" (`aria-label="Public news feed URL"`, type url, placeholder "https://…"): edits `newsURL` in the draft; saved by "Save news settings" (src/NewsView.tsx:21).
  - Button "Save news settings" (disabled while busy): `configureRuntime({newsURL,newsTrigger})` (src/NewsView.tsx:22; src/RuntimeSettings.tsx:49). On success: notice "Settings saved." and toast "News settings saved"; on refusal: toast "Not saved: `<reason>`"; on a thrown call: "Request failed." and toast "Not saved: could not reach the engine" (src/RuntimeSettings.tsx:50-51).
  - `NewsSources` controls, each saved at once (src/NewsSources.tsx:10-20):
    - "Remove" per feed (`aria-label="Remove feed <label|url>"`): saves the list without it (src/NewsSources.tsx:16).
    - Input `aria-label="Add news feed URL"` (placeholder "https://… RSS or Atom feed") and button "Add feed": disabled unless the trimmed text matches `^https://\S+$` and fewer than 10 feeds exist; adds `{url}` and saves; a duplicate URL is ignored (src/NewsSources.tsx:12, :17).
    - Suggested feed link buttons (label = feed label): add that feed and save (src/NewsSources.tsx:18).
    - Link button "Add all": adds all missing suggestions, cut to 10 feeds in all, and saves (src/NewsSources.tsx:18).
    - Switch "KIS market headlines", row text "KIS market headlines, tagged with stock codes": saves `kisNews` (src/NewsSources.tsx:19).
    - Switch "U.S. ticker headlines", row text "Headlines for U.S. stocks you hold or watch (up to 5)": saves `usTickerNews` (src/NewsSources.tsx:20).
    - Save feedback: toast "News sources saved"; on `ok:false` warning "Could not save. Check the address." and toast "Not saved: check the feed address"; on a thrown call "Could not save." and toast "Not saved: could not reach the engine" (src/NewsSources.tsx:10).
  - No confirmation steps anywhere on this screen (src/NewsView.tsx:12-22; src/NewsSources.tsx:10-20).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs line | Calls |
|---|---|---|---|
| `refreshNews()` (src/RuntimeSettings.tsx:48) | `runtime:news` (electron/preload.cjs:33) | main.cjs:739 | `refreshNews()` (main.cjs:109-124), then returns `runtimeState()` |
| `openNews(url)` (src/NewsView.tsx:16) | `runtime:open-news` (electron/preload.cjs:72) | main.cjs:745 | `shell.openExternal(url)` only when the URL is a string found in `automation.news` or in `automation.newsEvents.list(300)`; otherwise nothing |
| `getSuggestedFeeds()` (src/NewsSources.tsx:9) | `news:suggested` (electron/preload.cjs:53) | main.cjs:744 | returns `SUGGESTED_FEEDS` from electron/news.cjs:29-35 |
| `configureRuntime({newsURL,newsTrigger})` (src/RuntimeSettings.tsx:49) | `runtime:configure` (electron/preload.cjs:25) | main.cjs:724 | `automation.configure(value)` |
| `configureRuntime({newsFeeds})`, `({kisNews})`, `({usTickerNews})` (src/NewsSources.tsx:10-11, :19-20) | `runtime:configure` | main.cjs:724 | `automation.configure(value)` |
| `getRuntime()`, `getRuntimeHistory()` | `runtime:get`, `runtime:history` | main.cjs:722-723 | see Shared loader |

- **What a refresh does** (main.cjs:109-124): skips when a refresh is already running; gathers sources: every URL in `config.newsFeeds` plus `config.newsURL` (duplicates removed) through `news.fetchFeed`; when `usTickerNews` is on, a Yahoo Finance headline feed for up to 5 U.S. symbols taken from U.S. holdings and the U.S. watchlist (`news.yahooFeed`, electron/news.cjs:37); when `kisNews` is on and KIS is connected and idle, the KIS `news` request; when DART is connected, the provider `disclosures` request. Feeds and ticker feeds are skipped when `PORTFOLIO_SMOKE_DATA` is set. Names of failed sources go to `automation.newsSourceErrors`. Unless every source failed, `automation.news` becomes the items de-duplicated by URL, newest first, at most 200, `newsUpdatedAt` is set, and the items are ingested into `automation.newsEvents` with the relevant securities. `automation.newsError` is `'NEWS_REFRESH_FAILED'` when all sources failed or on an exception, else null.
- **Subscriptions**: the parent's 2-second `getRuntime()` poll plus the history fetch (see Shared loader). Main process timer: inside the main tick, a refresh starts when the last one is older than 300000 ms (scheduled reviews enabled and news trigger not `off`) or 1800000 ms otherwise, and at least one of `newsURL`, a non-empty `newsFeeds`, `kisNews` or a DART connection exists (main.cjs:242). The period of that tick is not determined here.
- **Saved state**:
  - `newsURL`, `newsTrigger`, `newsFeeds`, `kisNews`, `usTickerNews` are fields of the automation config, written through `automation.configure` (main.cjs:724; electron/automation.cjs:15, :177, :183, :202).
  - The draft of `newsURL` and `newsTrigger` lives under draft key `runtime:news:config` with `runtime:news:dirty` (session memory only) until "Save news settings" (src/RuntimeSettings.tsx:38, :58).
  - `NewsSources` keeps `feeds`, `kis`, `us` in `useState`, initialised from the config when the component mounts; they are not re-read from later polls (src/NewsSources.tsx:7-8).
  - The headline filter, source select and "Only my symbols" are renderer-only `useState` (src/NewsView.tsx:7).
- **Notes**:
  - `SUGGESTED_FEEDS` (electron/news.cjs:29-35), 6 entries: "CNBC Markets" (https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664), "CNBC Technology" (…&id=19854910), "MarketWatch top stories" (https://feeds.content.dowjones.io/public/rss/mw_topstories), "Yonhap economy" (https://www.yna.co.kr/rss/economy.xml), "Hankyung finance" (https://www.hankyung.com/feed/finance), "Maeil Business stocks" (https://www.mk.co.kr/rss/50200011/).
  - Trigger labels (`triggerLabels`, src/NewsView.tsx:5): `off` "Off", `disclosures` "Important disclosures for my symbols", `all` "Any news about my symbols". The engine's allowed list is `MODES=['off','disclosures','all']` (electron/news-events.cjs:5).
  - News-triggered reviews: the engine starts one only when the trigger is not `off` and at least 600000 ms have passed since the last, taking up to 5 pending events (electron/automation.cjs:1992).
  - "Refresh news" is disabled and the "News feed" figure reads "Not connected" when only `newsFeeds` or `kisNews` are set, because both look at `config.newsURL` and the DART connection only (src/NewsView.tsx:12-13). The background refresh does run for those sources (main.cjs:242). The two disclosures also open by default in that case (src/NewsView.tsx:17, :21).
  - KIS headlines carry a `kis-news:<id>` URL (electron/news.cjs:26), so they show the source name instead of "Read source ↗" (src/NewsView.tsx:16).
  - Feed rules in the engine (electron/news.cjs:5-20): feed URL must be https with no user name or password and not a local or private address (`INVALID_FEED_URL`); 15-second timeout; redirects are an error; a document over 500000 characters or with a DOCTYPE/ENTITY is refused (`INVALID_FEED`); at most 50 items per feed; titles cut to 500 characters; only https item links are kept.
  - In news mode the save sends only `newsURL` and `newsTrigger`, whatever else the draft holds (src/RuntimeSettings.tsx:49).
  - `NewsSources` renders `new URL(f.url).hostname` for a feed without a label (src/NewsSources.tsx:16).

## Sidebar badges for Journal and News

- `App` calls `useAttention()` (src/main.tsx:42), which calls `getAttention()` on mount and every 5000 ms (src/Dashboard.tsx:11-13) -> channel `workspace:attention` (electron/preload.cjs:18) -> main.cjs:630 `attentionState()` (main.cjs:602-629), returning `{items,counts}` with `counts={approvals:{'KIS trading':n,'U.S. stocks':n},lessons,news}` (main.cjs:603).
- Badge value per sidebar row (src/main.tsx:135): Journal = `attention.counts.lessons`; News = `attention.counts.news`; every other tab = `attention.counts.approvals[name]`. A zero or missing value shows no badge.
- `counts.lessons` = `automation.memory.summary().pending` (main.cjs:609): lifecycle records with status `pending` or `needs-review` (electron/learning-memory.cjs:87). The same step adds the Home item "Optional: `<n>` learning note(s) to look at" with action "Open Journal" (main.cjs:609).
- `counts.news` = the number of news events (from the latest 100) with importance `high`, at least one matched symbol, and first seen within the last 86400000 ms (main.cjs:619). The same step adds the Home item "`<n>` important disclosure(s) about your stocks today" with action "Read" (main.cjs:619).
- Badge class: `urgent` when the tab has approvals waiting; `optional` for Journal; none for News (src/main.tsx:135). Tooltips: Journal "Optional learning feedback: nothing waits on it"; News "Important disclosures today"; others "Orders waiting for approval" (src/main.tsx:135).
- Relation to the Journal's own tab badges: the sidebar Journal badge counts lifecycle records in the engine (electron/learning-memory.cjs:87), while the "Lessons" sub-tab badge counts lessons in the window's state with no lifecycle or with a pending/needs-review status (src/journalTabs.ts:11). The two can differ, for example for a lesson without a lifecycle record, or because `memory.list()` is capped at 100 (electron/learning-memory.cjs:86) (inferred). The "Orders and triggers" sub-tab badge (armed orders) has no sidebar counterpart (src/main.tsx:135; src/journalTabs.ts:12).
- The News badge does not clear when the News tab is opened; it follows the 24-hour window only (main.cjs:619) (inferred: no handler marks events as read).

## Macro

- **Purpose**: Shows official macro inputs for Korea (Bank of Korea ECOS) and the U.S. (FRED), and the upcoming U.S. release calendar (`src/MacroView.tsx:26-37`).

- **Component files**: `src/MacroView.tsx` exports `MacroView` (:20) and type `MacroState` (:5); internal `Tile` (:15) and `Spark` (:10). Mounted at `src/main.tsx:140`. Returns nothing without the desktop bridge (:23).

- **What it shows**:
  - Heading "Macro inputs"; status "Updated <date time> · refreshes every 6 hours" | "Loading official data…" | "Not loaded yet" (:27).
  - Error (role alert): "The last refresh failed (<error>). Showing the previous data." (:28).
  - "Korea · Bank of Korea ECOS" grid and "United States · FRED" grid of tiles (:30-31). Each tile (:16-18): name; latest value (KRW values 1 decimal, others 2) with the unit (" ₩" for KRW); signed change "+x / −x / ±0" with " pts" for percent units, followed by "vs previous"; a sparkline (aria-label "<n> recent observations from <date> to <date>"); "<period> · <source>" plus " · last refresh failed" when stale. Monthly series show the period as month and year (:8).
  - Series list (from `SERIES`, `electron/macro.cjs:4-20`; 15 series). Korea (ECOS): "BoK base rate" (%), "USD/KRW" (KRW), "KTB 3-year yield" (%), "KTB 10-year yield" (%), "Korea CPI inflation" (% y/y). U.S. (FRED): "Effective fed funds rate" (%), "U.S. 2-year Treasury" (%), "U.S. 10-year Treasury" (%), "U.S. CPI inflation" (% y/y), "U.S. unemployment rate" (%), "VIX volatility index", "WTI crude oil" (USD/bbl), "Brent crude oil" (USD/bbl), "Broad dollar index", "High-yield credit spread" (%).
  - "Unavailable this refresh: <ids>." when some series failed (:32).
  - "Upcoming releases": table (aria-label "Release calendar") with columns "Date" (adds " · today"), "Release", "Source" (:34). Empty: "No tracked releases in the next 45 days." (:34). No calendar: "The FRED release calendar could not load; check the FRED key." or "Add a free FRED key in Connections to see U.S. release dates." (:35). Tracked FRED releases (`RELEASES`, `electron/macro.cjs:23`): "U.S. CPI", "U.S. jobs report", "U.S. GDP", "U.S. PPI", "U.S. PCE inflation", "U.S. retail sales", "U.S. job openings (JOLTS)"; FOMC dates come from a fixed schedule (`electron/macro.cjs:21-22`, `:97`).
  - Disclosure "Sources and coverage": "Korea: Bank of Korea ECOS (your key | public sample access, limited to the latest 10 observations per series). United States: Federal Reserve Bank of St. Louis FRED downloads; daily rates and VIX lag one business day, CPI and unemployment are monthly. Inflation is year-over-year from the index. Changes compare with the previous observation. The AI receives the latest values and the next two weeks of releases as background context. Korean policy-meeting dates and analyst consensus are not connected." (:37).

- **Controls**: "Refresh" (text "Refreshing…"; disabled while busy or while the main side is refreshing) → `refreshMacro()` (:24, :27). The "Sources and coverage" disclosure (:37). No other controls.

- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Module method |
|---|---|---|---|
| `getMacro()` | `macro:get` | main:667 | `macroState()` (main:600): `macro.get()` (the `MacroStore`, `electron/macro.cjs:118`), `refreshing`, `error`, `ecosConnected`, `fredConnected` |
| `refreshMacro()` | `macro:refresh` | main:668 | `refreshMacro()` (main:598): `providerService.request('macro')`, then `macro.save(result)` |

- **Subscriptions**: polls `getMacro` every 60000 ms (:22). The main side refreshes on its own when the data is older than 6 hours (checked every 10 minutes, main:599).

- **Saved state**: none from this screen (no settings). The snapshot is stored by `MacroStore` (`electron/macro.cjs:118`; table not read).

- **Notes**: history kept per tile: 30 observations, or 12 for year-over-year series (`electron/macro.cjs` `summarize`, lines 44-52). With the ECOS sample key only the last 10 rows per series are requested (`electron/macro.cjs:3`). No code-to-text table: the error code is shown raw inside the sentence (:28).

## Connections

- **Purpose**: one page for every private connection: the KIS brokerage account, the optional market-calendar key, the AI providers, the other provider keys, SEC EDGAR, and the external agent bridge. The App updates section is mounted under it (`src/main.tsx:142-143`).
- **Component files**: `src/Connections.tsx` (`Connections`, with local `StatusPill`, `CalendarKeyCard`, `SecCard`); `src/ProviderCards.tsx` (`ProviderCards`, `ProviderCard`); `src/AppUpdates.tsx` (`AppUpdates`); types in `src/KisAccount.tsx`. Texts for the Anthropic note come from `src/providerText.mjs` (`ANTHROPIC_NOTE`, `providerUses`; file not read: not determined).

### KIS brokerage card (`src/Connections.tsx:45-65`)

- **What it shows**: heading "KIS brokerage", sub-line "Korean and U.S. accounts · read only until you activate trading". Status pill (`:34-35`): "Needs attention" (an error), "Connecting…", "Connected · MOCK" / "Connected · LIVE" (environment in capitals), or "Not connected".
  - Error notice from `kisErrors` (`:11`); with a kept snapshot it adds " The previous snapshot is retained; it may be stale." Unknown codes read "Unable to query the account." A remembered-file error (`kisFile.error`) shows when there is no account error.
  - Row "Credential file": hint is the remembered file's name or "None imported".
  - Row "Balance" (connected only): "<amount> reported by KIS · <n> Korean positions · checked HH:MM KST".
  - Row "At launch": "Reconnects automatically" or "Stays disconnected".
  - Disclosure "Settled cash and why totals differ from Home" (connected): a six-row table: "Korean holdings at KIS prices", "Cash counted by KIS (reported total − holdings)", "KIS reported total", "Settled (D+2) cash used by Home" (or "Not reported"), "Total deposit balance", "Still settling (deposit − settled cash)"; then the note "Why this can differ from the KIS total" (`:53-62`).
  - Disclosure "Credential file format" (not connected; open by default when no file is remembered): a JSON example with the field names `environment`, `appKey`, `appSecret`, `accountNumber`, `accountProductCode` and placeholder values, and "Use mock or live credentials matching the selected environment. Keep the original file outside this workspace; importing does not remove or protect it." (`:63`).
- **Controls**:
  - "Import credentials and connect" (primary, not connected) / "Import different credentials" (connected) / "Connecting…" (busy). Calls `importKis`.
  - "Refresh balance": `refreshKis`. "View holdings →": opens Holdings.
  - "Reconnect": disabled unless a file is remembered and not already connecting. `reconnectConnection('kis')`.
  - "Disconnect": title "End this session. The remembered file still reconnects at the next launch." `disconnectKis`.
  - "Forget & disconnect" (danger): title "Disconnect and stop reconnecting at launch". `forgetConnection('kis')`. No confirmation dialog.

### Market calendar card (`CalendarKeyCard`, `src/Connections.tsx:95-105`)

- **What it shows**: "Market calendar", "Optional · official KRX holidays"; pill "Loading…", "Official calendar" or "Weekdays only". Row "Live key for the calendar" with the file name (or "None imported") and " · reconnects at launch". Note "Used only to read the KRX holiday calendar." explaining that KIS offers the calendar only to live keys, that the key runs in its own process which reads the calendar once every six hours, and that it never reads balances, quotes or orders.
- **Controls**: "Import live key" (`importCalendarKey`), "Reconnect", "Forget" (danger).
- Error texts set by the main process (main.cjs:93): "This is a mock key. KIS offers the market calendar only to live keys." or "Could not open the calendar key. Reimport it if moved or invalid."

### AI providers (`ProviderCards`, `src/ProviderCards.tsx`; section id `ai-providers`)

- **What it shows**: heading "AI providers", "Keys come from your provider file. Data sharing and limits are per provider." One card each for "OpenAI" and "Anthropic". Card hint: what the provider is used for (`providerUses`). Pill "Key loaded" / "No key".
  - Row "Key": "From <provider file name>" or "Add openaiApiKey to your provider file and import it" / "Add anthropicApiKey to your provider file and import it". The key itself is never shown.
  - Row "Share KIS data with <name>": hint "Holdings, values and orders, sent with each request that uses this provider".
  - Row "Calls per day": hint "Today: <n>".
  - Row "Spending per day": hint "Today: $x.xx (local estimate)".
  - Anthropic only: a dry-run reservation line "One dry run of up to <n> requests can reserve up to $x; the first request about $y." plus, when blocked, " The spending limit ($z) is below that, so a dry run cannot start until you raise it."; "Measured dry run: <date>, <n> requests, $x." or "Measured dry run: none yet on this account."; note "What Anthropic is used for now".
- **Controls**:
  - "Test" (title "Lists the provider's models. Uses no tokens."): `testProviderKey(vendor)`; the result sentence shows under the row. Disabled without a key.
  - Switch "Share KIS data with <name>": applies at once (`configureRuntime({shareKisWithOpenAI})` or `{shareKisWithAnthropic}`).
  - `Limit` controls for calls (1–200) and spending (0.01–100 USD, step 0.01), each with a "No limit" mini-switch. Edits go to a card-local draft; "Discard" and "Save limits" appear while it is dirty. Save toasts "<name> settings saved" or "Not saved: <message>"; an exception toasts "Not saved: could not reach the engine".
- A link from Engine settings → Trading scrolls this section into view once (`takeDraft('connections:ai-providers')`, `src/Connections.tsx:21`).

### AI, news and alert keys card (`src/Connections.tsx:70-81`)

- **What it shows**: "AI, news and alert keys", "Optional · one JSON file"; pill "Loading…", "<n> of 3 loaded" (counting AI, DART and the mobile webhook, `:36`) or "Not configured". Key rows with a pill "Loaded" or the missing text: "Open DART" ("Korean disclosures"; "Not set"), "Bank of Korea ECOS" ("Korean macro data"; "Sample access"), "FRED" ("U.S. release calendar"; "Not set"), "Mobile webhook" ("Phone alerts"; "Not set"). Row "Provider file": file name or "None imported", plus " · reconnects at launch".
  - Disclosure "Provider JSON format": a JSON example with the field names `openaiApiKey`, `anthropicApiKey`, `dartApiKey`, `ecosApiKey`, `fredApiKey`, `secContactEmail`, `pushWebhookURL` and placeholder values; note "An OpenAI key turns the AI on. Macro keys are optional."
- **Controls**: "Import provider JSON" (`importProviders`; message "Provider keys imported." or the reply's message/error or "Import failed."), "Reconnect", "Forget & disconnect" (danger).

### SEC EDGAR card (`SecCard`, `src/Connections.tsx:111-126`)

- **What it shows**: "SEC EDGAR", "Optional · U.S. financials, dividends and filings"; pill "On" / "Not set". Row "Contact email": hint "Saved in the app", "From the provider file", or "SEC asks every app to name a contact. No key or account is needed." Note "Sent only to sec.gov."
- **Controls**: email input (placeholder "you@example.com"); "Save" (disabled when empty or unchanged); "Test" (disabled until ready); "Clear" (only with a saved email).
- **Messages**: "Saved. U.S. company research now loads SEC filings." / "Cleared." / "Connected: <name>, <n> recent filings, financials through <year>." Errors from `SEC_ERRORS` (`:110`): `INVALID_EMAIL` "Enter a valid email address."; `SEC_RATE_LIMITED` "SEC refused the request (rate limit or contact). Try again in a few minutes."; `SEC_UNAVAILABLE` "SEC EDGAR did not respond. Try again later."; `SEC_CONTACT_MISSING` "Save a contact email first."; `NOT_IN_SEC` "SEC has no filings for the test company."; `BROKER_UNAVAILABLE` "The provider process is not running. Reconnect the provider file and try again." Unknown codes show raw.

### External agent bridge card (`src/Connections.tsx:85-88`)

- "External agent bridge", "MCP stdio bridge · paper snapshots and risk-checked proposals only". Disclosure "Setup command": "No KIS credentials, live-account data or live-order tools are exposed. Select “External agent bridge” as the decision provider in Engine settings." and the command `node "<bridgeScript>" "<bridgePipe>"` built from the runtime state (`runtimeState()` fields `bridgeScript`, `bridgePipe`, main.cjs:692).

### Closing note

"How automatic reconnection works": "Successful imports remember the file location in your app data, shared across builds. On startup the private brokers reopen those files. Keys are not copied into the database. Trading and scheduled reviews still start paused." (`src/Connections.tsx:90`).

### App updates (`src/AppUpdates.tsx`)

- **What it shows**: "App updates", "Version <current> · checked <local date-time>", and a badge (capitals) from the status: "Development build" (disabled), "Checking…", "Version <v> available", "Downloading <n>%", "Version <v> ready to install", "Up to date", "Last check failed", "Not checked yet". In a development or portable build only: "Updates work in the installed app only." The whole section is hidden without the preload bridge or before the first state.
- **Controls**:
  - "Check for updates" (disabled while checking or downloading).
  - "Download <version>" (primary; only when an update is available). Nothing downloads without this click (`updater.autoDownload=false`, `electron/app-updates.cjs:11`).
  - "Restart and install" (primary; only when downloaded; disabled while `blockedReason` is set).
  - Disclosure "Release notes" (when the release has notes; HTML tags stripped, at most 2000 characters, `electron/app-updates.cjs` `summary`).
  - Checkbox "Check for updates every 6 hours" (aria-label "Check for updates automatically"): saves at once.
  - Note "Updates are checksum-verified. Installing restarts the app once trading is idle."
- **Blocked reasons** (`BLOCKED`, `src/AppUpdates.tsx:5`; produced by `canInstall`, main.cjs:640): `AUTO_TRADING_ARMED` "Stop auto trading first; updating restarts the app." (scheduled reviews on and the session armed); `REVIEW_RUNNING` "An AI review is running; try again when it finishes."; `ORDERS_OPEN` "Wait until open broker orders are filled, canceled or reconciled." (any Korea or U.S. order in `Submitting`, `Uncertain`, `Accepted` or `Partially filled`). Unknown: "Installing is blocked right now."
- **Error texts** (`ERRORS`, `:6`; codes from `publicError`, `electron/app-updates.cjs`): `NETWORK_UNAVAILABLE` "Could not reach GitHub. Check the connection."; `RELEASE_NOT_FOUND` "No published release was found for this app yet."; `CHECKSUM_MISMATCH` "The download did not match its published checksum and was discarded."; `SIGNATURE_INVALID` "The download signature did not verify and was discarded."; `UPDATE_FAILED` "The update could not be completed." Other refusals: "The request could not be completed."; exception: "Could not reach the engine."

### Calls and channels

| `window.portfolio` method | Channel | Handler (main.cjs, search the channel) | Calls |
|---|---|---|---|
| `getRuntime` | `runtime:get` | `'runtime:get'` | `runtimeState()` (fields used: `connections`, `providerStatus`, `config`, `usageByVendor`, `agentModels`, `claudeReservation`, `claudeDryRun`, `bridgeScript`, `bridgePipe`) |
| `importKis` | `kis:import` | `'kis:import'` (≈824) | native open dialog "Import KIS credentials" (filter "Credential JSON", `.json`); `remembered.forget('kis')`; `connectKisFile(path)` (main.cjs:95-100) → `kisService.request('import', path)` |
| `refreshKis` | `kis:refresh` | `'kis:refresh'` | `refreshKisBalance()` |
| `disconnectKis` | `kis:disconnect` | `'kis:disconnect'` | stops both live engines, clears quotes, `kisService.disconnect()`, broadcasts market |
| `reconnectConnection(kind)` | `connections:reconnect` | `'connections:reconnect'` | `connectKisFile` / `connectCalendarFile` / `connectProviderFile` with the remembered path |
| `forgetConnection(kind)` | `connections:forget` | `'connections:forget'` | `remembered.forget(kind)` then disconnects that service (for KIS also stops both live engines) |
| `importProviders` | `runtime:providers` | `'runtime:providers'` | native open dialog "Import provider configuration" (filter "Provider JSON"); `connectProviderFile(path)` (main.cjs:78-82) → `providerService.request('import', path)` |
| `importCalendarKey` | `calendar:import` | `'calendar:import'` | native open dialog "Import a live KIS key for the market calendar"; `connectCalendarFile(path)` (main.cjs:90-94), then `refreshKrCalendar()` |
| `testProviderKey(vendor)` | `providers:test` | `'providers:test'` (≈397) | `providerService.request('test-key',{vendor})`; text from `electron/key-test.cjs` `text`; also logs a "Provider key test" console event |
| `configureRuntime(patch)` | `runtime:configure` | `'runtime:configure'` | `automation.configure` |
| `getSecContact` / `setSecContact` / `testSec` | `sec:get` / `sec:set` / `sec:test` | `'sec:get'` etc. (≈698-703) | `secState()`; `store.setSetting('sec-contact-email', …)`; `providerService.request('sec-company',{symbol:'NASD:AAPL',…})` |
| `getUpdates` / `checkForUpdates` / `downloadUpdate` / `installUpdate` / `saveUpdateSettings` | `update:get` / `update:check` / `update:download` / `update:install` / `update:settings` | `'update:get'` etc. (≈642-646) | `AppUpdates.view` / `check` / `download` / `install` / `saveSettings` (`electron/app-updates.cjs`) |
| `onUpdates` | broadcast `update:changed` | sent from `onChange` (main.cjs:641) | every updater event |

### Subscriptions

- `Connections` polls `getRuntime` on its own 2-second timer (`src/Connections.tsx:22`), not through `subscribeRuntime`.
- `AppUpdates` listens to `update:changed` and reads `getUpdates` once.
- `SecCard` reads `getSecContact` once on mount.
- The KIS state (`kis`, `kisBusy`) is owned by `App` and passed in (`src/main.tsx:142`).

### Saved state

- **Remembered file locations**: `settings` rows `connection-file:kis`, `connection-file:providers`, `connection-file:calendar`, holding the absolute path only (`electron/remembered-files.cjs` `key`, `remember`). Written after a successful import (main.cjs:80, :92, :97). Deleted by Forget. A new import first forgets the old path.
- Keys are held by the worker services (`kisService`, `providerService`, `calendarService`) that were asked to `import` the file; the on-screen note states they are not copied into the database (`src/Connections.tsx:90`). What the workers keep in memory: not determined (worker files not read; credential files never opened).
- Importing a provider file with an AI key sets the automation config `provider` to `openai` (`connectProviderFile`, main.cjs:80); not on the automatic restore at start (`selectProvider=false`, main.cjs:860).
- Sharing switches and daily limits: automation config (see section 3).
- SEC contact email: setting `sec-contact-email` (main.cjs `'sec:set'`).
- Update preference: table `app_update_settings`, one JSON row (`electron/app-updates.cjs` `saveSettings`).
- Page messages and the reconnect progress are renderer-only. A "… reconnected." message clears itself after 6 seconds (`src/Connections.tsx:29`).

### Notes

- `kisErrors` (`src/Connections.tsx:11`), 9 codes: `INVALID_CREDENTIAL_FILE` "Check the credential JSON format."; `AUTH_FAILED` "Authentication failed. Check your KIS credentials and API access."; `RATE_LIMITED` "KIS rate limit reached. Wait before refreshing."; `BROKER_REJECTED` "KIS rejected the query. Check account permissions and environment."; `INCOMPLETE_BALANCE` "The complete balance could not be retrieved. No partial balance is displayed."; `INVALID_RESPONSE` "KIS returned an unexpected response."; `REQUEST_FAILED` "The request failed. Check connectivity and retry."; `BROKER_UNAVAILABLE` "Broker process unavailable. Import credentials again."; `BUSY` "A request is already running."
- Reconnect result messages (`src/Connections.tsx:27-28`): "<KIS | AI, news and alert keys | Market calendar> reconnected." or "<name> could not reconnect: <error>." While waiting: "Reconnecting…". Forget: "Connection forgotten. It will not reopen at the next launch."
- Main-process file errors: KIS "Could not reconnect. Check the file location, credentials and network, or import again." (main.cjs:98); providers "Could not reopen provider JSON. Reimport it if moved, deleted or invalid." (main.cjs:81).
- A reconnect or forget is ignored while that kind is `connecting` (main.cjs `'connections:forget'`, `'connections:reconnect'`).
- The page uses the settings card and row style (`settings-card`, `Row block`), section 4.1.

## Engine settings (shell: `RuntimeSettings mode="settings"`)

- **Purpose**: Holds the draft of the automation config, loads the runtime state, saves the changed keys, and shows the unsaved-changes bar and the Claude confirmation. The body is `EngineSettings` (src/RuntimeSettings.tsx:62 "EngineSettings state=").
- **Component files**: src/RuntimeSettings.tsx:37 `RuntimeSettings({mode,onNavigate})`, modes `'settings'|'news'|'journal'`. Mounted at src/main.tsx:150 for the tabs Journal, News and Engine settings with `key={tab}` and `mode` = `'news'` / `'journal'` / `'settings'`. Mode switch: `mode==='settings'` renders `EngineSettings` (src/RuntimeSettings.tsx:62), `mode==='news'` renders `NewsView` (:63), `mode==='journal'` renders `JournalView` (:65). Only journal and news fetch the history (`wantsHistory`, src/RuntimeSettings.tsx:40). Draft keys are per mode: `'runtime:'+mode+':dirty'`, `':changed'`, `':config'` (src/RuntimeSettings.tsx:38).
- **What it shows**:
  - Before the first load: "Loading…", or "Use the desktop app for runtime controls." when `window.portfolio` is missing (src/RuntimeSettings.tsx:53).
  - Unsaved bar (only settings mode and only while the draft is dirty): region aria-label "Unsaved engine settings", text "Unsaved changes" and "The saved settings stay active until you save" (src/RuntimeSettings.tsx:61).
  - Status notice (`role="status"`, class `notice`) with the last message: "Settings saved.", "Completed.", "Draft discarded.", "Could not load runtime settings.", "Request failed.", or the refusal text (src/RuntimeSettings.tsx:42, :50, :51, :60, :62).
  - Toasts on save: "Settings saved" (ok), "Not saved: " + reason (error), "Not saved: could not reach the engine" (src/RuntimeSettings.tsx:50-51).
  - The Claude confirmation dialog (see "Claude confirm dialog" below).
- **Controls**:
  - "Discard" (src/RuntimeSettings.tsx:61): clears the dirty flag and the changed-key set, resets the draft to `state.config`, message "Draft discarded." (:60). Disabled while `busy`.
  - "Save changes" (primary, src/RuntimeSettings.tsx:61): if the draft's `openaiModel` starts with `claude-` and the saved one does not, it opens `ClaudeConfirm` instead of saving; otherwise it saves. Disabled while `busy`.
  - Every edit goes through `apply(patch)` (src/RuntimeSettings.tsx:57): sets dirty, records the keys in `changed`, merges the patch, then runs `correctAgents(next)` (src/agentDraft.mjs:23) and adds its fixes (an agent that would resolve to GPT-6 Astra or a Claude model with effort None gets its own effort `low`).
  - `setModel(model)` (src/RuntimeSettings.tsx:62 "setModel=") sets `openaiModel` and, when the model is `gpt-6-astra` and the trading effort is `none`, also sets `reasoningEffort:'low'`.
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method |
|---|---|---|---|
| `getRuntime()` (src/RuntimeSettings.tsx:42) | `runtime:get` (electron/preload.cjs:24) | electron/main.cjs:722 | `runtimeState()` (main.cjs helper; wraps `automation.getState()`: inferred from the name, its body was not read) |
| `getRuntimeHistory()` (journal/news only, src/RuntimeSettings.tsx:42) | `runtime:history` (preload.cjs:29) | electron/main.cjs:723 | `historyOf(automation.getState())` |
| `configureRuntime(value)` (src/RuntimeSettings.tsx:49) | `runtime:configure` (preload.cjs:25) | electron/main.cjs:724 | `automation.configure(value)` (electron/automation.cjs:172) |
| `reviewRuntime()` (src/RuntimeSettings.tsx:49, kind `review`) | `runtime:review` (preload.cjs:26) | electron/main.cjs:731 | `automation.review()` (electron/automation.cjs:695) |
| `importProviders()` (kind `import`; no caller inside EngineSettings) | `runtime:providers` (preload.cjs:32) | electron/main.cjs:732 | not read (belongs to Connections) |
| `refreshNews()` (news mode) | `runtime:news` (preload.cjs:33) | electron/main.cjs:739 | `refreshNews()` in main.cjs |
| `approveLesson(id,approved)` (journal mode) | `runtime:lesson` (preload.cjs:71) | electron/main.cjs:743 | `automation.approveLesson(id,approved)` |

- **What a save sends** (src/RuntimeSettings.tsx:49): in settings and journal mode the value is only the keys in the `changed` set (each with the draft's value), plus `enabled: config.enabled` always, plus `claudeTradingConfirmed:true` only after the Claude confirmation. In news mode it is `{newsURL,newsTrigger}` only.
- **What the handler returns** (electron/main.cjs:724): `{ok:true,state}` on success. On a throw: `{ok:false,error}` where `error` is the engine's own code only for `CLAUDE_NOT_ENABLED_FOR_TRADING`, `CLAUDE_DRY_RUN_REQUIRED:(scout|narrative|compacting|reflection)`, `CLAUDE_TRADING_(DRY_RUN|KEY|CONSENT|LIMITS|CONFIRM)` and `CLAUDE_MODEL_NOT_FOR_TRADING`; every other failure becomes `INVALID_SETTINGS`. No `state` is returned on failure.
- **Subscriptions**: its own `setInterval(refresh,2000)` on `getRuntime` (src/RuntimeSettings.tsx:42). It does not use `subscribeRuntime`. While the draft is dirty, a refresh does not overwrite the draft (`dirty.current?current:value.config`, :42).
- **Saved state**: the automation config, saved by `automation.configure` into the table `automation_settings` row 1 as JSON (electron/automation.cjs:171 `saveConfig`, :212). The draft, the dirty flag and the changed-key set are session memory only (src/useDraftState.ts:2 "Session memory only: navigation retains drafts; reload/exit discards them").
- **Notes**:
  - The save error table is `SAVE_ERRORS` (src/RuntimeSettings.tsx:28-30), listed in full under "Error-code-to-text tables" below.
  - A save in settings mode sends only the keys changed (src/RuntimeSettings.tsx:49). A save never arms the session: only Start auto trading does (audit item 15, 1.5.69). Turning "Scheduled reviews" off disarms it; turning it on saves the switch, and the schedule runs from the next Start. After an app start `sessionArmed` is false (electron/automation.cjs:123 "this.sessionArmed=false"). Until 1.5.69 every save carried the saved `enabled` and re-armed a session paused after a restart.
  - A value the engine refuses for range or type reasons comes back as `INVALID_SETTINGS` (electron/main.cjs:724). `SAVE_ERRORS` has no entry for it, so the notice shows the raw code "INVALID_SETTINGS" and the toast "Not saved: INVALID_SETTINGS" (src/RuntimeSettings.tsx:50; inferred from the fallback chain `reply.message??reply.error`).
  - `SAVE_ERRORS` has an `INVALID_MODEL_SETTINGS` text, but the handler at electron/main.cjs:724 does not pass that code through (it maps it to `INVALID_SETTINGS`), so that text cannot appear from a save (inferred from the handler's allow-list).
  - Unknown keys are refused: any key not in `DEFAULTS` (other than `claudeTradingConfirmed`) throws `INVALID_SETTINGS`; keys in `LEGACY_SETTINGS` are silently dropped (electron/automation.cjs:173-175, :20).
  - Narrow window: the unsaved bar is fixed at the bottom right, width `min(520px, 100vw - 240px)` (src/polish.css:247). Under 760px each row stacks its text above its control and selects take the full width (src/polish.css:245).

### EngineSettings frame (tab strip and "Run portfolio review")

- **Purpose**: Splits the settings into four sub-tabs and offers one manual review with the saved settings.
- **Component files**: src/EngineSettings.tsx:27 `EngineSettings(props)`; exported `ENGINE_TABS` (:16), `SEVERAL_OPEN_CONFIRM` (:46), `ordersHint` (:51), `universeLine` (:56). Mounted by `RuntimeSettings` (src/RuntimeSettings.tsx:62). Props: `state, config, busy, dirty, edit, setModel, onReview, onState, onNavigate` (src/EngineSettings.tsx:11).
- **What it shows**: a segmented tab list (aria-label "Engine sections") with the tabs "Trading", "Agents", "Schedule and triggers", "Alerts" (src/EngineSettings.tsx:16, :31). Only the open tab is rendered (:33-37). The root has aria-label "Engine settings" (:30).
- **Controls**:
  - Tab buttons (`role="tab"`): switch the sub-tab; the choice is kept for the session under draft key `engine:tab`, default "Trading" (src/EngineSettings.tsx:29).
  - "Run portfolio review" (primary; reads "Reviewing…" while `state.busy`): calls `onReview` → `action('review')` → `reviewRuntime()`. Disabled when `busy`, `state.busy` or the draft is dirty. Tooltip: "Save or discard your changes before reviewing" when dirty, else "Run one review now with the saved settings" (src/EngineSettings.tsx:32).
- **Calls and channels**: `reviewRuntime()` → `runtime:review` → electron/main.cjs:731 → `automation.review()` (electron/automation.cjs:695, default trigger 'User request'). On failure the handler returns `{ok:false,error:automation.lastError??'REVIEW_FAILED',message:automation.lastErrorDetail??'Review failed.'}` (electron/main.cjs:731). The notice shows `reply.message` first, then the code (src/RuntimeSettings.tsx:50). On success the notice reads "Completed." (:50).
- **Subscriptions**: none of its own; it gets `state` from the parent's 2-second poll (src/RuntimeSettings.tsx:42).
- **Saved state**: the open tab, session memory only (`useDraftState('engine:tab')`, src/EngineSettings.tsx:29; src/useDraftState.ts:2).
- **Notes**: the tab strip is sticky at the top (src/polish.css:178 `.settings-jump{position:sticky`). The settings column is at most 860px wide (src/polish.css:173).

### Sub-tab "Trading"

- **Purpose**: What account the AI manages, who decides, order submission, position sizing, extended sessions, guardrails, order execution and conditional orders.
- **Component files**: `TradingTab` (src/EngineSettings.tsx:78), `SeveralOrders` (:60), `ExtendedSessions` (:228), `StartWithWindows` (:265), `Guardrails` (src/Guardrails.tsx:7).
- **What it shows** (cards in order):
  1. Card "Agent guidelines" (aria-label "Guidelines"), hint "Your goals in plain language. The AI reads them on every review." A 4-row textarea with placeholder "Example: Concentrated positions are fine; protect gains when the outlook weakens." (src/EngineSettings.tsx:80-81).
  2. Card "Trading" (src/EngineSettings.tsx:83-93) with rows:
     - "Portfolio", hint "Which account the AI manages" (:84).
     - "Decision maker" (:85).
     - "Scheduled reviews", hint "Review on a timer and when prices move" while auto trading runs (`state.launch.running`), otherwise "Takes effect when you press Start auto trading." (:86).
     - "Place orders automatically", hint "Orders that pass your limits are sent without asking" when on, "Every AI order waits for your approval" when off (:87).
     - "Risk per trade", hint "Largest loss at the stop, as a share of equity. Sets the AI's position-size ceiling." (:88).
     - "Stop distance", hint "Multiple of the daily average true range (ATR)." (:89).
     - "Data sharing", hint "Per provider, in Connections · OpenAI on/off, Anthropic on/off" (built from `shareKisWithOpenAI` and `shareKisWithAnthropic`), with the link button "Open Connections" (:91).
     - "Start with Windows", hint by state: the `reason` when not available ("Available in the installed app." electron/login-item.cjs:31, or "Windows did not answer. Try again later." :13), else the `note` ("Set for all users of this PC; turn it off in Windows Startup apps." :20, "Turned off in Windows Startup apps." :21), else "Opens the app when you sign in to Windows. After a restart at night it opens only once you sign in. It starts paused." An `error` is appended ("Windows did not accept the change." electron/login-item.cjs:48, "Invalid request." electron/main.cjs:634) (src/EngineSettings.tsx:269-270).
  3. Card "Extended hours", hint "Trade outside regular sessions. Each session has its own switch; all start off.", badge "On" when any of the four session switches is on, else "Off" (src/EngineSettings.tsx:230-231). When the account is not live: notice "The connected account is a mock account, which accepts no extended-session orders. These switches take effect on a live account." (:232; `live` is `state.accountEnvironment==='live'`, :94). Rows:
     - "Korea · Nextrade (NXT)", hint "Pre-market 08:00–08:50 and after-market 15:30–20:00 KST, limit orders on NXT" (:233).
     - "U.S. · KIS daytime session", hint "During Korean daytime (09:00–17:00 KST in summer), limit orders only" (:234).
     - "U.S. · Pre-market", hint "04:00–09:30 New York time; every order waits for your approval" (:235).
     - "U.S. · After-market", hint "16:00–20:00 New York time; needs KIS after-market extension on your account; every order waits for your approval" (:236).
     - "Largest extended-session order", hint "Share of the market's equity per order" (:237).
     - Note "How extended orders work" (a `Note` disclosure) with the long text starting "Orders go out only while a session you switched on is open, and stop 5 minutes before it ends." (:238).
  4. Card "Guardrails" (aria-label "Autopilot guardrails"), hint "Hard limits for unattended trading." (src/Guardrails.tsx:10). Badge: "Tripped today" (class `warning-badge`) when `state.guardrails.trippedToday`; "Advisory only" when `lossAction==='review'` and both limits are 0; else "Active" (:9-10). The badge tooltip is the `HOW` text: "Guardrails act on AI decisions and automatic orders, not on orders you approve yourself. Daily loss limits are set per market on the trading pages. The order limit counts automatic orders per Seoul day across markets; later proposals wait for approval. Stopping turns off reviews and automatic orders until you restart." (:6). Rows:
     - "When a daily loss limit is hit" (:11).
     - "Automatic orders per day", hint "Later proposals wait for approval · N today" or "No cap on automatic orders · N today" (N = `guardrails.autoOrdersToday`) (:12).
     - "Stop after failed reviews in a row", hint "Auto trading stops at this many · N in a row now" or "Never stops for failed reviews · N in a row now" (N = `guardrails.failureStreak`) (:13).
     - When tripped: error notice "A guardrail stopped auto trading today. Positions and accepted broker orders are unchanged." (:14).
     - Disclosure "Recent guardrail events · N": each event as kind, local time and detail. Kind names: `auto-stopped` "Auto trading stopped", `buys-blocked` "Buys blocked", `order-limit` "Order limit reached" (:5, :15).
  5. Card "Order execution", hint "How KIS orders are placed and kept until they fill." (src/EngineSettings.tsx:96). Rows:
     - "Follow the best price", hint when on "Orders go in at the best bid (sell) or ask (buy) and move with it every 3 seconds until filled, within any bound the AI set. Orders you change in KIS are left to you.", when off "Orders stay at the price they were placed at." (:97).
     - "Several open orders", hint when on "Orders can be open for different stocks at the same time.", when off "One open order at a time. Off by default." (:64).
     - "Orders per review", hint from `ordersHint` (:51-54): "Needs several open orders turned on." / "<Model> answers one order per review." / "Up to N with <Model>." plus " Using N." when the saved number is above the ceiling. The model name comes from `MODEL_NAMES[state.orderLimits.model]`, fallback "The trading model" (:61).
     - "More" disclosure (only when several open orders is on and the ceiling is above 1) with four lines: "Closing orders (sales, repayments, covers) go first, then the others in the AI's order." / "Every order passes every check a single order passes; one that fails is skipped and the others go." / "An order not started within five minutes of the decision is not sent." / `universeLine(scope)`: "A review can trade the stocks it is shown: at most 20 Korean and 20 U.S. stocks, your holdings included." (both), "...at most 20 U.S. stocks..." (us), "...at most 20 Korean stocks..." (otherwise) (:56-59, :71-75).
  6. Card "Conditional orders" (aria-label "Conditional order settings"), hint "Stop-loss, take-profit and entry orders the AI arms with conditions. They fire only while auto trading is on and the market is open, and still pass every risk check." (:100). Row "Let the AI set conditional orders", hint "Off by default." (:101). Only when that switch is on (:102-109):
     - "Submit them automatically", hint "Otherwise each one waits for your approval." when `autoSubmit` is on, else "Needs automatic submission in Trading. Until then each one waits for approval." (:103).
     - "Let stops trail", hint when on "Stops the AI sets may follow the price up. Checked only while the app runs.", else "Off by default." (:104).
     - "Armed at once", hint "Most orders waiting at one time." (:105).
     - "Largest order", hint "Share of account equity for one buy." (:106).
     - "Price drift allowed", hint "How far the limit may sit from the price when it fires." (:107).
     - "Longest life", hint "Orders expire after this many hours." (:108).
- **Controls**:
  - Textarea aria-label "Agent guidelines", `maxLength=6000`, writes `guidelines` (:81). It is not disabled while busy (no `disabled` attribute, :81).
  - Select aria-label "Portfolio scope": "Paper (simulated)" (`paper`), "Korea · KIS" (`kis`), "U.S. · KIS" (`us`), "Korea + U.S. · KIS" (`both`); writes `scope` (:84).
  - Select aria-label "Decision provider": "Rules only (no AI, paper)" (`local`; the option is disabled unless the draft scope is `paper`), "AI model" (`openai`), "External agent" (`external`); writes `provider` (:85). OpenAI versus Claude is not chosen here: both use provider `openai`, and the model id on the Agents tab selects the vendor (electron/ai-models.cjs:1-3 "the model id alone selects it"; src/WorkspaceUX.tsx:38 "startsWith('claude-')?'Claude':'OpenAI'").
  - Switch "Scheduled reviews" → `enabled` (:86). Switch "Place orders automatically" → `autoSubmit` (:87).
  - Number "Risk per trade" min 0.1 max 20 step 0.1 unit "%" → `sizingRiskPct` (:88). Number "Stop distance in ATR" min 0.5 max 5 step 0.5 unit "× ATR" → `sizingAtrMultiple` (:89).
  - Link button "Open Connections": sets the one-time draft `connections:ai-providers`=true and navigates to "Connections" (:91).
  - Switch "Start with Windows": calls `setLoginItem(on)` at once (not part of the draft or the save). Disabled while its own call runs or when `available` is false (:268-270).
  - Four session switches → `sessionKrNxt`, `sessionUsDaytime`, `sessionUsPre`, `sessionUsAfter` (:233-236). Number "Largest extended-session order" min 0.5 max 50 step 0.5 unit "%" → `extendedMaxOrderPct` (:237).
  - Select aria-label "Loss-limit response": "Review more often, keep trading" (`review`), "Block new AI buys" (`block-buys`), "Stop auto trading for the day" (`stop`) → `lossAction` (src/Guardrails.tsx:11).
  - `Limit` "Automatic orders per day": number 1–100 plus a small switch labelled "No limit" (aria-label "Unlimited Automatic orders per day"). "No limit" on writes `maxAutoOrdersPerDay=0`; off writes 10 (`ORDER_DEFAULT`); the number writes `Math.max(1,v)` (src/Guardrails.tsx:4, :12).
  - `Limit` "Stop after consecutive failed reviews": number 1–20 plus a small switch labelled "Never stop". On writes `maxConsecutiveFailures=0`; off writes 3 (`FAILURE_DEFAULT`); the number writes `Math.max(1,v)` (src/Guardrails.tsx:4, :13).
  - Switch "Follow the best price" → `orderTracking` (src/EngineSettings.tsx:97).
  - Switch "Several open orders": turning it ON does not edit the draft; it opens an inline dialog (class `notice`, `role="dialog"`, aria-label "Turn on several open orders?"). Turning it OFF writes `severalOpenOrders=false` at once. The switch is disabled while the dialog is open (:64-65).
    - Dialog title "Turn on several open orders?"; body "Orders can be open for different stocks at the same time. This applies even at one order per review: an open order no longer blocks every other order. KIS's handling of several open orders has not yet been seen on your live account. You can turn it off again at any time." (:46-47).
    - Dialog "More" disclosure, three lines: "An unclear order blocks only its own stock and counts in full until it is resolved." / "Funding and the deposit and withdrawal checks count every open order." / "\"Orders per review\" is a separate setting, 1 unless you change it." (:48, :67).
    - Buttons "Turn on" (primary; writes `severalOpenOrders=true` to the draft and closes) and "Cancel" (:68). The change still needs "Save changes".
  - Number "Orders per review" min 1, max `Math.max(ceiling,saved)` → `ordersPerReview`. Disabled when busy, when several open orders is off, or when the ceiling is 1 or less (:70). The ceiling is `state.orderLimits.ceiling` = the smaller of the model's order ceiling and the review universe (20, or 40 for scope `both`) (electron/automation.cjs:1065, :1068; electron/ai-models.cjs:54).
  - Conditional order controls: switches → `conditionalOrders`, `conditionalAutoSubmit`, `trailingStops`; numbers "Most armed conditional orders" 1–10 → `conditionalMaxActive`; "Largest conditional order" 1–50 step 1 "%" → `conditionalMaxOrderPct`; "Conditional order price drift" 0.1–10 step 0.1 "%" → `conditionalMaxSlippagePct`; "Conditional order lifetime" 1–336 "h" → `conditionalMaxHours` (:101-108).
  - All controls except the guidelines textarea and the "Start with Windows" switch are disabled while `busy` (each row's `disabled={busy}`).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method |
|---|---|---|---|
| `getLoginItem()` (src/EngineSettings.tsx:267) | `system:login-item` (electron/preload.cjs:18) | electron/main.cjs:633 | `loginItem.get()` (electron/login-item.cjs:29) |
| `setLoginItem(on)` (src/EngineSettings.tsx:268) | `system:set-login-item` (preload.cjs:18) | electron/main.cjs:634 | `loginItem.set(on)` (electron/login-item.cjs:37) |
| everything else on this tab | saved through `configureRuntime` | electron/main.cjs:724 | `automation.configure` |

- **Subscriptions**: `StartWithWindows` reads Windows' state once on mount (src/EngineSettings.tsx:267). No timers.
- **Saved state**: automation config keys as listed in "Settings rows". "Start with Windows" is Windows' own login item, not a saved engine setting; it is read from Windows every time and can be set only by the installed (packaged) app (electron/login-item.cjs:2-6, :31, :40). Turning trailing stops off or on has side effects in `configure`: armed trailing stops stay armed as fixed stops and a console line "Trailing stops paused" is logged; switching on resumes from the next quotes (electron/automation.cjs:204-209).
- **Notes**: The Guardrails card can be reached from `RuntimePulse`'s "View guardrails" button, but that component is not mounted (see "RuntimePulse" below). `Card` ids `eng-guidelines`, `eng-trading`, `eng-extended`, `eng-guardrails`, `eng-execution`, `eng-conditional` exist as anchors (src/EngineSettings.tsx:80-100, :231); what links to them was not determined.

### Sub-tab "Agents"

- **Purpose**: The model and reasoning effort of each of the five agents (trading review, scout, market narrative, context compacting, reflection), the reflection limits, and today's AI use.
- **Component files**: `AgentsTab` (src/EngineSettings.tsx:144), `AgentModelRows` (:121), `claudeHint` (:139); helper module src/agentDraft.mjs (`AGENT_KEYS` :8, `claudeGateText` :17, `resolved` :20, `correctAgents` :23, `effortOptions` :31).
- **What it shows** (cards in order):
  1. Card "Trading review" (aria-label "AI model"), hint "Decides Buy, Sell or Hold. The other agents can follow it." when an OpenAI or Anthropic key is loaded, else "No AI key loaded. Add one in Connections." (src/EngineSettings.tsx:148). Rows "Model" (hint from `claudeHint`) and "Reasoning effort" (hint "Higher is slower and costs more") (:149-150).
     - `claudeHint` texts (:139-143): gate closed: "Claude Opus 5.5: dry run only for now (Dashboard → Dry run)"; saved model is Claude and first review pending: "Trades on Claude: no fallback. The first review waits for you on Home."; saved model is Claude otherwise: "Trades on Claude: no fallback. Reviews wait when Claude cannot answer."; not on Claude and a counting dry run exists: "Claude Opus 5.5: you confirm before it trades"; else "Claude Opus 5.5 needs a dry run on this version first (Dashboard → Dry run)".
  2. Card "AI scout" (aria-label "Scout agent"), hint "Researches the market and writes the plan for the trading reviews. It never trades. When it runs: Schedule and triggers." (:152). Rows "Model" and "Effort" (`AgentModelRows`).
  3. Card "Market narrative" (aria-label "Narrative agent"), hint "Summarises what is driving the market for the reviews. It never trades." Row "Scheduled narrative", hint "Weekdays 08:30 and 16:30. Update now on Discover works either way."; then "Model" and "Effort" (:155-157).
  4. Card "Context compacting", hint "Shrinks research results that grow too large for a review." Rows "Model" and "Effort" (:159-160).
  5. Card "Reflection" (aria-label "Reflection agent"), hint "After a trade closes, the AI drafts a lesson for you to approve." Rows "Post-trade reflection", "Model", "Effort", "Reflection calls", "Reflection spending" (:162-166).
  6. Card "Daily AI budget", badge "Today N calls · $X.XX" (`state.usage`), hint "A local estimate from reported tokens. Limits are per provider, in Connections." (:169). One read-only row per vendor, "OpenAI" and "Anthropic": "N of M calls · $X.XX of $Y.YY", with "no limit" where the vendor's unlimited flag is on (:170-171). Disclosure "Recent API calls": table (aria-label "Recent API calls") with columns "Time", "Model", "Status", "Tokens in / out", "Cost" (cost shows "$X.XX reserved" until an estimate exists); empty state "No calls yet." (:172).
  - Per-agent "Model" row hint: "Now <model name> · <Effort>" from `state.agentModels[agent]` (the saved, resolved values) (:124, :132).
  - Per-agent Claude line (shown when the agent's resolved draft model starts with `claude-`), aria-label "<Name> on Claude" (:133): a `notice` when blocked, else muted text "Requests go to Anthropic and count against its limit; needs sharing KIS data with Anthropic." (the second clause is omitted for the narrative). Blocked texts (:130): "The Anthropic key is not loaded: this agent will not run."; the `claudeGateText` sentence "<Agent> is set to Claude Opus 5.5, which needs a measured dry run on this account. Run one, or choose another model for it." (src/agentDraft.mjs:17); "Sharing KIS data with Anthropic is off: this agent will not run." (not for the narrative). Additions: for compacting " One condensing can reserve up to $X.XX." (from `state.claudeReservation.compactUpToUSD`); for Haiku " A wait Anthropic starts holds Claude reviews. Prompts over 100,000 tokens cost 5× more." (:133).
- **Controls**:
  - Select aria-label "Trading model": group "OpenAI": "GPT-6 Luna" (`gpt-6-luna`), "GPT-6 Sol" (`gpt-6-sol`), "GPT-6 Astra" (`gpt-6-astra`); group "Anthropic": "Claude Opus 5.5" (`claude-opus-5-5`), labelled "Claude Opus 5.5 · dry run only" and disabled when `state.claudeTrading.enabled` is false and the draft is not already on Claude. Calls `setModel` (writes `openaiModel`, and `reasoningEffort:'low'` for Astra with None) (src/EngineSettings.tsx:149; src/RuntimeSettings.tsx:62).
  - Select aria-label "Reasoning effort": "None", "Low", "Medium", "High"; "None" is not offered for GPT-6 Astra or a Claude model (:146, :150). Writes `reasoningEffort`.
  - Per agent, select aria-label "<Name> model" (names: "Scout", "Market narrative", "Context compacting", "Reflection"): "Same as the trading agent" (`same`), "GPT-6 Luna", "GPT-6 Sol", "GPT-6 Astra", group "Anthropic": "Claude Opus 5.5", and for compacting only "Claude Haiku 5.5" (`claude-haiku-5-5`). The Claude options are disabled unless the Anthropic key is loaded and `state.claudeDryRun` exists (or the option is already the draft's value); the label then reads "Claude Opus 5.5 · needs the Anthropic key in Connections" or "Claude Opus 5.5 · after a measured dry run" (the Haiku option uses the same suffixes) (:127-128, :132). Keys: scout `scoutModel`, narrative `narrativeModel`, compacting `routineModel`, reflection `reflectionModel` (src/agentDraft.mjs:8).
  - Per agent, select aria-label "<Name> effort": "Same as the trading agent" (`same`), then "None" (only where allowed), "Low", "Medium", "High". "None" is never offered for the scout and the narrative, nor when the agent's resolved model is GPT-6 Astra or a Claude model (src/agentDraft.mjs:31-34). A saved value the list would not offer is shown as a disabled option "<Value> · not allowed with this model" (src/EngineSettings.tsx:134). Keys: `scoutEffort`, `narrativeEffort`, `routineEffort`, `reflectionEffort`.
  - Switch "Scheduled market narrative" → `narrativeEnabled` (:156). Switch "Post-trade reflection" → `reflectionEnabled` (:163).
  - `Limit` "Reflection calls per day": number 1–200 and "No limit" switch → `reflectionCallsPerDay`, `reflectionUnlimitedCalls` (:165). `Limit` "Daily reflection budget (USD)": money field (currency USD) 0.01–100 step 0.01 and "No limit" switch → `reflectionUSDPerDay`, `reflectionUnlimitedBudget` (:166).
  - Disclosure "Recent API calls" (:172).
- **Calls and channels**: none of its own; all values are saved by `configureRuntime` (electron/main.cjs:724 → `automation.configure`). Model checks run in electron/ai-models.cjs `settings` (:30) and `assertTradingModel` (:28), electron/agent-models.cjs `validate` (:31), and electron/automation.cjs `claudeTradingRefusal` (:990).
- **Subscriptions**: none of its own.
- **Saved state**: automation config keys `openaiModel`, `reasoningEffort`, the eight agent keys, `narrativeEnabled`, `reflectionEnabled`, `reflectionCallsPerDay`, `reflectionUSDPerDay`, `reflectionUnlimitedCalls`, `reflectionUnlimitedBudget`. The provider limits shown on "Daily AI budget" (`maxCallsPerDay`, `maxUSDPerDay`, `unlimitedCalls`, `unlimitedBudget`, `anthropicCallsPerDay`, `anthropicUSDPerDay`, `anthropicUnlimitedCalls`, `anthropicUnlimitedBudget`) are read-only here and are set in Connections (src/EngineSettings.tsx:168-171).
- **Notes**:
  - Draft correction: after every edit, `correctAgents` raises to `low` the own effort of the compacting and reflection agents when they would resolve to GPT-6 Astra or a Claude model with effort None; the scout and narrative are skipped because the engine raises their None to Low itself (src/agentDraft.mjs:9-12, :23-28; electron/agent-models.cjs:24).
  - Engine rules for agents (electron/agent-models.cjs:31-45): model must be a non-empty string of at most 60 characters; effort must be `same` or one of none/low/medium/high; effort `none` is refused for scout and narrative; the resolved pair must pass `ai-models.settings`; Claude Haiku 5.5 is allowed only for compacting (`INVALID_MODEL_SETTINGS`); a non-trading agent that resolves to a Claude model is refused with `CLAUDE_DRY_RUN_REQUIRED:<agent>` unless `claudeAllowed`.
  - `claudeAllowed` is true when the save only turns `enabled`/`autoSubmit` off, or when some non-trading agent resolves to Claude and `completedClaudeDryRun()` returns a record (electron/automation.cjs:196). That record is the newest dry run of mode `review` on a `claude-` model, not failed, with a decision, at least one call and a measurement, made on the connected account, whose AI calls all completed with usage and accounted cost (electron/automation.cjs:959-968).

### Claude confirm dialog and the trading-on-Claude rules

- **Purpose**: Ask before a save switches the trading model to Claude, and state the engine's conditions for that save.
- **Component files**: src/ClaudeConfirm.tsx:6 `ClaudeConfirm({config,state,busy,onConfirm,onCancel})`; lines from src/claudeConfirmLines.mjs:9 `claudeConfirmLines(config,state)`. Mounted by `RuntimeSettings` in settings mode while `claudeConfirm` is true (src/RuntimeSettings.tsx:62).
- **What it shows**: an inline block (class `notice`, `role="dialog"`, aria-label "Trade with Claude Opus 5.5") titled "Trade with Claude Opus 5.5?" and a bullet list (src/ClaudeConfirm.tsx:7-9). The lines (src/claudeConfirmLines.mjs:14-21):
  1. "Every review sends your account data (holdings, cash, orders and prices) to Anthropic."
  2. "No fallback: when Claude cannot answer, reviews wait and you are alerted. Armed stops keep running."
  3. "A wait started by any Claude call, the helpers' included, holds automatic reviews until it ends."
  4. Cost: "Your last dry run cost $X.XX for N request(s). At your interval (every M minutes) that is about $Y.YY a day for K scheduled reviews; triggered reviews add to it." With auto interval the middle reads "At your base interval (every M minutes; the AI may change it)". With no measured cost: "There is no measured cost yet." K = ceil(open minutes / interval), open minutes: `kis` 380, `us` 390, `both` 770, `paper` 0 (:7, :10-11).
  5. Limits: "Your Claude limits: unlimited." or "Your Claude limits: $X and N requests a day." with "no dollar limit" / "no request limit" where a flag is on (:12).
  6. Only when helpers follow the trading model (`scoutModel`, `narrativeModel`, `reflectionModel` equal `same`): "<Names> move(s) to Claude too. It has / They have not yet run on Claude with real requests." (:4, :13, :18).
  7. "Context compacting uses <Claude model name>." or "Context compacting still uses OpenAI (<model name>)." (:20).
  8. "The first review waits for you: run it from Home. Automatic reviews start after it completes." (:21).
- **Controls**: "Trade with Claude" (primary): closes the dialog, sets `confirmed.current=true` and saves; the save then carries `claudeTradingConfirmed:true` (src/ClaudeConfirm.tsx:10; src/RuntimeSettings.tsx:49, :62). "Cancel": closes the dialog; nothing is saved and the draft stays (src/RuntimeSettings.tsx:62). Both disabled while `busy`. The flag is cleared after every action (`confirmed.current=false`, src/RuntimeSettings.tsx:51).
- **Calls and channels**: `configureRuntime` → `runtime:configure` → electron/main.cjs:724 → `automation.configure` (electron/automation.cjs:172).
- **Subscriptions**: none.
- **Saved state**: `claudeTradingConfirmed` is never stored: it is deleted before the config is saved (electron/automation.cjs:174, :196). On a switch to Claude the engine sets the first-review state to `pending` in table `claude_trading_state`; switching back to another vendor clears it (electron/automation.cjs:215, :989).
- **Notes** (the engine's order of checks for a Claude trading model, electron/automation.cjs:187-196, :990-1000; electron/ai-models.cjs:24-28):
  1. `assertTradingModel`: `CLAUDE_NOT_ENABLED_FOR_TRADING` when the gate constant is off (`CLAUDE_TRADING_ENABLED=true` in this tree, electron/ai-models.cjs:24); `CLAUDE_MODEL_NOT_FOR_TRADING` when the model is not `claude-opus-5-5`.
  2. `claudeTradingRefusal(next,{saving:true,switching})`, skipped when the save only turns `enabled`/`autoSubmit` off ("Stop is never refused", electron/automation.cjs:191-195). In order: `CLAUDE_MODEL_NOT_FOR_TRADING`; `CLAUDE_TRADING_DRY_RUN` when `claudeTradingDryRun()` is null; `CLAUDE_TRADING_KEY` when the Anthropic key is missing; `CLAUDE_TRADING_CONSENT` when `shareKisWithAnthropic` is not true; `CLAUDE_TRADING_LIMITS` when the Anthropic daily calls or dollars do not cover one review's reservation; `CLAUDE_TRADING_CONFIRM` when switching from another vendor without `claudeTradingConfirmed`.
  3. `claudeTradingDryRun()` (electron/automation.cjs:976-979): the completed Claude dry run counts when its instructions fingerprint equals the current single-order or several-orders fingerprint; or, for a record with only an app version, when that version is at least 1.5.60; or, for an older record, when it was made at or after `CLAUDE_FORMS_SINCE` and recorded its answer form.
  4. Then the per-agent check `CLAUDE_DRY_RUN_REQUIRED:<agent>` (electron/agent-models.cjs:44; agents are checked in the order scout, narrative, compacting, reflection, :12).
  - The UI side: the option is disabled while the gate is closed (src/EngineSettings.tsx:149); the dialog opens only when the draft model is Claude and the saved one is not (src/RuntimeSettings.tsx:61). `state.claudeTrading` = `{enabled, dryRunReady, firstReview}` comes from electron/automation.cjs:346.
  - The handler passes the code only; the engine's own text (`error.text`, which for `CLAUDE_TRADING_LIMITS` carries the numbers) is not sent to the window by `runtime:configure` (electron/main.cjs:724; electron/automation.cjs:998). The window shows the `SAVE_ERRORS` text.

### Sub-tab "Schedule and triggers"

- **Purpose**: When reviews run (interval, closed markets, price and order triggers), when the scout runs, and the token-saving rules.
- **Component files**: `ScheduleTab` (src/EngineSettings.tsx:177), `NotHeldRow` (:246), mapping module src/price-review-rows.ts, `TokenSaving` (src/TokenSaving.tsx:7).
- **What it shows** (cards in order):
  1. Card "Schedule" (src/EngineSettings.tsx:179-186). Rows:
     - "Let the AI choose the interval", hint "Between 1 and 60 minutes, depending on the market" (:180).
     - "Review interval (minutes)", or "Initial review interval (minutes)" when the auto switch is on; hint (auto on and `state.reviewInterval.auto`): "Now every N min · <reason>" (:181).
     - "When markets are closed", hint by value: `keep` "Reviews follow the interval around the clock", `off` "No scheduled reviews until a market opens", `pre-open` "One review 10 minutes before the next open" (:182).
     - "Holdings: price move trigger", hint "Review early when a holding moves this much" (:183).
     - "Stocks you don’t hold", hint `PR.LINE[option]` (src/price-review-rows.ts:11-12): `same` "Any stock moving by the holdings percent, or reaching a level the AI set"; `wider` "A level the AI set, when crossed, or a move of the percent below"; `levels` "Only a price level the AI set, when crossed"; `never` "Holdings, schedule and news still start reviews"; `trial` "The watchlist alert trial decides until it ends (More)".
     - "Wider move" (in the row list only for option `wider`; inside "More" while Observe is on), hint "Default N%, twice the holdings trigger" (N = 2 × `eventTolerancePct`) (src/EngineSettings.tsx:249-250, :255, :258; src/price-review-rows.ts:36).
     - "More" disclosure (aria-label "Stocks you don’t hold: more"), shown when the Observe switch applies, or `watchlistAlerts` is not `off` and an observation summary exists, or a trial record exists (:256). Contents: row "Observe watchlist alerts", hint "Logs what entry levels and wider moves would do. Nothing changes." (:257); "Wider move" (:258); row "Watchlist alert trial" (only when `watchlistAlerts==='observe'`), hint: "Needs “Stocks you don’t hold” set to Same as holdings" when locked; when on "Price reviews use watchlist alerts; the current rule runs in shadow. Ends by itself on a rollback condition, after $2.50 of added reviews, or after 5 trading days per market"; when off "Off: nothing changes. Only price-move reviews would change; protection and every other trigger stay as they are" (:259); trial status line (aria-label "Watchlist alert trial status"): "Trial <status> (<endReason>): N Korean and M U.S. qualifying trading days (K not fully watched, not counted), P price reviews, A the current rule would not have started ($X.XX). <endDetail>" (:260); observation line (aria-label "Watchlist alert observation"): "Last 7 days: N price reviews started. Checks that would alert: A current rule, B watchlist alerts, in E episodes (… current rule only, … watchlist alerts only, … both) · D of T alerts on stocks you don’t hold later, U not alerted." (:261).
     - "Review after an order update", hint "A fill, cancellation or rejection starts a review" when on, "Updates are seen at the next review" when off (:185).
  2. Card "AI scout runs" (aria-label "Scout settings"). Hint: `state.scout.blocked` when set; else "Next: <times> KST. Its model is on the Agents tab." when times exist; else "When the scout researches the market. Its model is on the Agents tab." (:187). Rows:
     - "Scheduled scout runs", hint "On each market's trading days. Uses the daily AI budget." (:188).
     - "Reviews can ask for a scout run", hint "When the plan looks stale. Up to 3 a day, at least 2 hours apart." (:189).
     - Only when scheduled runs are on, four slot rows (:22-26, :191): "Before Korea opens" ("20 minutes before the open. The plan is ready at the open, without the day's market data."), "After Korea opens" ("Once the day's breadth and investor flows are in. Researches Korea."), "Korea midday" ("4 hours after the open. Researches Korea."), "Before the U.S. opens" ("30 minutes before the U.S. open. Researches the U.S.").
     - "More" disclosure: row "After Korea opens: minutes after the open", hint "Default 60. The investor-flow lists are empty until about 09:20; the institution list fills by about 10:00."; and a paragraph starting "Times follow each exchange's calendar, including daylight saving and holidays." (:192-195).
  3. Card "Token saving", hint "Emergencies, your own requests and important disclosures always get a full review.", badge "Avg $X / review" (`tokenSaving.averageMicro`, "—" when none) with tooltip "Today: N skipped · M reviewed" (src/TokenSaving.tsx:8-9). Rows:
     - "Skip unchanged reviews", hint "Skip a scheduled review when holdings, cash and prices (within half the price move trigger), market sessions, the regime and important news are unchanged" (:10).
     - "Review gate", hint: `on` "Scheduled reviews run only when something that can change a decision changed since the last one"; `observe` "Logged beside the skip above; nothing changes"; `off` "Off" (:11).
     - "Skip research known to be unavailable", hint when on "Research the tools confirmed unavailable for a waiting stock is not requested again until its source can answer differently, a filing or news arrives, or you ask for a review"; when off "Off: unavailable research can be requested again in every review" (:12).
     - Line (gate `observe` and suppression `on`): "Scheduling is observed only; research suppression is active." (:13).
     - Observation line (gate not `off` and a summary exists), aria-label "Review gate observation": "Last 7 days: N scheduled checks, R reviews ran, S skipped. The gate would skip G, W more than now (about $X.XX); backstop B, risk or protection K. Reviews C, decision changes E, trades T; A AI calls, $Y.YY." (:14).
     - "Routine review scope", hint when `focused`: "Routine reviews reassess what changed against the whole portfolio and reuse the rest. A full comparison runs at each pre-open, on your request, in an emergency, for a filing, important news, a risk or protection change, and at least every 4 hours while a market is open"; when `full`: "Every review compares every permitted strategy" (:15).
     - "Longest stretch of skips" (only when skip unchanged is on or the gate is not `off`), hint "A safety check-in: even with no changes, review again after this long. Longer saves more." (:16).
     - "Slow down near the budget", hint "At 80% of the daily budget, scheduled reviews run half as often" (:17).
     - Disclosure "Recent reviews · tokens and cost" (when any): table (aria-label "Recent review cost") with columns "Time", "Model", "Calls", "Input (cached)", "Output", "Cost" (:18).
- **Controls**:
  - Switch "Auto review interval" → `autoReviewInterval` (src/EngineSettings.tsx:180). Number "Review interval" min 1 max 1440 unit "min" → `intervalMinutes` (:181).
  - Select aria-label "Reviews while markets are closed": "Review once before the open" (`pre-open`), "Wait for the open" (`off`), "Keep the schedule" (`keep`) → `closedMarketReviews` (:182).
  - Number "Holdings price move trigger" min 0.1 max 50 step 0.1 "%" → `eventTolerancePct` (:183).
  - Select aria-label "Stocks you don’t hold": "Same as holdings" (`same`), "Entry levels and wider moves" (`wider`), "Entry levels only" (`levels`), "Never" (`never`); a fifth, disabled option "Trial running: entry levels and wider moves" is shown and the select is disabled while `alertTrial==='on'` (src/EngineSettings.tsx:253-254; src/price-review-rows.ts:9-10). What each choice writes (src/price-review-rows.ts:21-25): `same` → `notHeldPriceReviews:'default'` and, only if `watchlistAlerts` was `on`, `watchlistAlerts:'off'` (an `observe` value is kept); `wider` → `notHeldPriceReviews:'default'`, `watchlistAlerts:'on'`; `levels` → `notHeldPriceReviews:'levels'`; `never` → `notHeldPriceReviews:'never'`. What the row shows for saved values (`shown`, :15-17): trial on → `trial`; `never` → `never`; `levels` → `levels`; else `watchlistAlerts==='on'` → `wider`, otherwise `same`.
  - Number "Wider move for stocks you don’t hold" min 0.1 max 50 step 0.1 "%" → `watchlistMovePct`; shows `2*eventTolerancePct` while the saved value is null (src/EngineSettings.tsx:249).
  - Switch "Observe watchlist alerts": on writes `watchlistAlerts:'observe'`, off writes `'off'` (src/price-review-rows.ts:33). Shown under `same`; shown but disabled under `trial`; under `levels`/`never` shown only when `observe` is already saved (src/price-review-rows.ts:29-32).
  - Select aria-label "Watchlist alert trial": "Off", "On" → `alertTrial`. Disabled when `notHeldPriceReviews` is not `default` and the trial is not on (src/EngineSettings.tsx:251, :259).
  - Switch "Review after an order update" → `orderUpdateReviews` (:185).
  - Switches "Scheduled scout runs" → `scoutEnabled`; "Reviews can request a scout run" → `scoutAiRequests`; slot switches → `scoutBeforeKrOpen`, `scoutAfterKrOpen`, `scoutKrMidday`, `scoutBeforeUsOpen` (:188-191). Number "Minutes after the Korean open" min 10 max 240 "min" → `scoutAfterOpenMinutes` (:193).
  - Switch "Skip unchanged reviews" → `skipUnchanged` (src/TokenSaving.tsx:10). Select aria-label "Review gate": "Observe only" (`observe`), "On" (`on`), "Off" (`off`) → `reviewGate` (:11). Select aria-label "Research suppression": "Off", "On" → `researchSuppression` (:12). Select aria-label "Routine review scope": "Full" (`full`), "Focused on changes" (`focused`) → `routineReviews` (:15). Number "Maximum skip minutes" min 15 max 720 "min" → `maxSkipMinutes` (:16). Switch "Slow down near the budget" → `degradeNearBudget` (:17).
- **Calls and channels**: none of its own; saved by `configureRuntime` (electron/main.cjs:724). Validation: electron/automation.cjs:177 (interval, tolerance), :182 (gate, routine scope, suppression, watchlist, trial, not-held, wider move), :197 (closed-market choice, skip, slow-down, max skip), :198 and electron/scout-timing.cjs:43-46 (scout).
- **Subscriptions**: none of its own.
- **Saved state**: automation config keys listed in "Settings rows". Changing `alertTrial` in `configure` starts or ends the trial and writes a console line ("Watchlist alert trial started" / "Watchlist alert trial stopped") (electron/automation.cjs:210-211).
- **Notes**:
  - Trial rules in the engine (electron/automation.cjs:182): `alertTrial:'on'` is refused unless `notHeldPriceReviews==='default'`, `watchlistAlerts==='observe'` and the scope is not `paper`; while the trial is on the scope cannot change.
  - With the defaults (`watchlistAlerts:'observe'`, `notHeldPriceReviews:'default'`, electron/automation.cjs:15) the row shows "Same as holdings" with the Observe switch on (inferred from `shown` and `observeSwitch`).
  - A known limit stated in the code: under "Entry levels only" and "Never" the saved watchlist mode is kept and "still decides how holding reviews are grouped", which the screen does not show (src/price-review-rows.ts:18-20).
  - The scout slot times in the engine: 20 minutes before the Korean open, `scoutAfterOpenMinutes` after it, 240 minutes after it, 30 minutes before the U.S. open (electron/scout-timing.cjs:14-19).

### Sub-tab "Alerts"

- **Purpose**: Desktop and phone alerts, trade snapshots, the daily digest, and the list of price alerts the AI asked for.
- **Component files**: `AlertsTab` (src/EngineSettings.tsx:202).
- **What it shows**:
  1. Card "Alerts" (:207-220). Rows: "Desktop alerts" (hint "When orders fill, cancel or stop"); "Phone alerts" (hint "Sent to your webhook" when `providerStatus.pushConnected`, else "Needs a webhook in Connections"); "Snapshot on each trade" (only when phone alerts are on; hint "Portfolio chart and the reason when a buy or sell fills"); "Show amounts" (only when phone alerts and snapshots are on; hint "Won amounts and percentages" when on, "Percentages only" when off); "Daily digest" (hint "A summary of the day's reviews and orders"); "Digest time" (only when the digest is on) (:208-213).
     - Digest preview: a `pre` (aria-label "Digest preview") with the digest text, or "Preview unavailable." (:205, :215).
     - Phone test note (muted): "Test snapshot queued. It should reach your phone within a few seconds." / "Add a webhook in Connections first." (error `NO_WEBHOOK`) / "Turn on phone alerts and save first." (any other failure, e.g. `PHONE_ALERTS_OFF`) / "Could not reach the engine." (:204, :217).
     - Error notice when phone alerts are on and no webhook is connected: "Phone alerts are on, but no webhook is set. Alerts are queued, not sent." (:218).
     - Disclosure "Phone alert outbox · N" (when `state.notifications` is not empty): one line per item, "<Status> · <message>", status "Delivered" (delivered), "Expired" (attempts ≥ 99), "Failed" (attempts ≥ 5), else "Queued" (:219).
  2. Card "AI review alerts", hint "Price levels and moves the AI asked to be woken up for." (:221). List (class `watch-list`) of `state.watches`: symbol, "N% move" (the watch's percent or the saved `eventTolerancePct`), optional " · <direction> <price> KRW|USD" (KRW when the symbol is six digits) with " (triggered)" when `priceFired`, and the reason. Empty state: "Default movement threshold: N%" (:222).
- **Controls**:
  - Switches: "Desktop alerts" → `desktopAlerts`; "Phone alerts" → `mobileAlerts`; "Snapshot on each trade" → `phoneSnapshots`; "Show amounts in snapshots" → `phoneAmounts`; "Send a daily digest" → `digestEnabled` (:208-212).
  - Select aria-label "Daily digest time": 24 options "00:00 KST" … "23:00 KST" → `digestHour` (number) (:20, :213).
  - Button "Preview today's digest": calls `previewDigest()` and shows the text (:205, :214). Disabled while `busy`.
  - Button "Send a test snapshot": shown only when the draft has phone alerts on and a webhook is connected; disabled while `busy` or while the draft is dirty; calls `testPhoneSnapshot()` (:204, :216).
  - Button "Reset to default alerts" (card aside): calls `resetReviewWatches()` and passes the returned state to `onState` (:221). No confirmation step; not disabled while busy.
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method |
|---|---|---|---|
| `previewDigest()` | `runtime:digest-preview` (electron/preload.cjs:35) | electron/main.cjs:725 | `require('./daily-digest.cjs').buildDigest(automation)` (electron/daily-digest.cjs:11; "No AI or broker calls", :2) |
| `testPhoneSnapshot()` | `phone:test` (preload.cjs:36) | electron/main.cjs:554 | returns `PHONE_ALERTS_OFF` when the saved `mobileAlerts` is off, `NO_WEBHOOK` when no webhook; else `notifier.post(phone.testSnapshot({figures:figures()}))` (electron/phone-snapshot.cjs:54, title "Test snapshot", description "Snapshots will look like this after each buy or sell.") |
| `resetReviewWatches()` | `runtime:reset-watches` (preload.cjs:34) | electron/main.cjs:726 | `automation.revision++`, `automation.watches.reset(automation.watchScope())`, returns `runtimeState()` |

- **Subscriptions**: none of its own.
- **Saved state**: automation config keys `desktopAlerts`, `mobileAlerts`, `phoneSnapshots`, `phoneAmounts`, `digestEnabled`, `digestHour`. The preview text and the phone note are renderer-only state (src/EngineSettings.tsx:203). The watch reset changes the engine's watch store for the current watch scope (`scope:identity`, electron/automation.cjs:156).
- **Notes**: the test snapshot checks the SAVED `mobileAlerts` (electron/main.cjs:554), which is why the button is disabled while the draft is dirty and the fallback text says "save first" (src/EngineSettings.tsx:204, :216).

### Shared settings components (the approved card/row style)

- **Purpose**: The building blocks of every settings card: "a card of rows, each row a short title, an optional one-line hint and a control on the right" (src/SettingsUI.tsx:4).
- **Component files**: src/SettingsUI.tsx exports `Card` (:5), `Row` (:8), `Switch` (:13), `NumberField` (:16), `Limit` (:24), `Segmented` (:27). src/Note.tsx exports `Note` (:3). Used by src/EngineSettings.tsx:3, src/Guardrails.tsx:2, src/TokenSaving.tsx:2.
- **What it shows**:
  - `Card({id,title,hint,aside,label,children})`: a `section.settings-card` with `aria-label` = `label ?? title`; head with `h2` title, optional `small` hint, optional `aside` element on the right (badges or a button); then `div.setting-rows` with the children (src/SettingsUI.tsx:5-7).
  - `Row({title,hint,info,children,block})`: `span.setting-text` with bold title, optional "i" dot (`span.info-dot`, title and aria-label = `info`) and optional `small` hint; `span.setting-control` with the control. A single-control row is a `<label>` so the whole row is clickable; `block` makes it a `<div>` for rows with several controls (src/SettingsUI.tsx:8-12).
  - `Switch({label,checked,disabled,onChange})`: `input type="checkbox" role="switch" class="switch"`, `aria-label` = `label` (src/SettingsUI.tsx:13-15).
  - `NumberField({label,value,min,max,step,unit,disabled,onChange,currency})`: `input type="number"` with an optional unit suffix. A value outside `min`–`max` marks the field invalid at once and shows "Allowed {min}–{max}{unit}" (`role="alert"`) "instead of failing on save" (src/SettingsUI.tsx:19-21). With `currency` it renders `MoneyField` instead (:18). It does not clamp: the out-of-range number is still written to the draft (:21 `onChange(Number(e.target.value))`).
  - `Limit({label,unlimited,value,min,max,step,unit,disabled,onUnlimited,onValue,offLabel='No limit',currency})`: a `NumberField` (hidden while unlimited) plus a small switch (`class="switch small"`, aria-label "Unlimited {label}") with the visible text `offLabel` (src/SettingsUI.tsx:24-26).
  - `Segmented({label,value,options,disabled,onChange})`: a radio group of buttons (src/SettingsUI.tsx:27-29). Not used on the Engine settings tab (no reference in src/EngineSettings.tsx, src/Guardrails.tsx or src/TokenSaving.tsx).
  - `Note({summary,children})`: `details.note` with one always-visible summary line and the body on demand ("Progressive disclosure", src/Note.tsx:2-4).
- **Controls**: How "More" works: details are plain HTML `<details className="inline-help"><summary>More</summary>…</details>` placed after the rows they explain. They hold either bullet lists (src/EngineSettings.tsx:67, :71-75) or further `Row`s and a paragraph (:192-195, :256-262). Other disclosures use the same class with a descriptive summary: "Recent API calls" (:172), "Phone alert outbox · N" (:219), "Recent guardrail events · N" (src/Guardrails.tsx:15), "Recent reviews · tokens and cost" (src/TokenSaving.tsx:18). Long explanations use `Note` ("How extended orders work", src/EngineSettings.tsx:238). Confirmations are inline `div.notice role="dialog"` blocks, not modal windows (src/EngineSettings.tsx:65; src/ClaudeConfirm.tsx:7).
- **Calls and channels**: none.
- **Subscriptions**: none.
- **Saved state**: none; the components are controlled by their parents.
- **Notes**: conventions seen across the tab: hints are one short line and often change with the value (for example src/EngineSettings.tsx:87, :97, :182); dependent rows appear only when their parent switch is on (:102, :190, :210-213); values that are off are stored as 0 with a "No limit"/"Never stop" switch (src/Guardrails.tsx:3). Layout: rows are flex with the control on the right (src/polish.css:186), stacked under 760px (src/polish.css:245).

### Draft state and the shared runtime feed

- **Purpose**: Keep unsaved drafts across tab changes; share one runtime poll among status components.
- **Component files**: src/useDraftState.ts: `setDraft` (:6), `takeDraft` (:8), `useDraftState` (:9), `useDraftRef` (:14). src/runtimeFeed.ts: `subscribeRuntime` (:14), `refreshRuntime` (:20), `needsHistory` (:23).
- **What it shows**: nothing (helpers).
- **Controls**: none.
- **Calls and channels**: `subscribeRuntime` calls `getRuntime()` → `runtime:get` → electron/main.cjs:722 (src/runtimeFeed.ts:10).
- **Subscriptions**: `subscribeRuntime` runs one shared 2000 ms interval; the first subscriber starts it and the last one stops it; a failed request passes the last good state with `failed=true` (src/runtimeFeed.ts:2-5, :14-18). `RuntimeSettings` does not use it; it has its own 2-second timer (src/RuntimeSettings.tsx:42).
- **Saved state**: two module-level `Map`s, `values` and `refs` (src/useDraftState.ts:3-4): "Session memory only: navigation retains drafts; reload/exit discards them" (:2). Keys used by this screen: `runtime:settings:dirty`, `runtime:settings:changed`, `runtime:settings:config` (src/RuntimeSettings.tsx:38), `engine:tab` (src/EngineSettings.tsx:29), and the one-time `connections:ai-providers` set for the Connections page (:91).
- **Notes**: `needsHistory` decides when Journal and News fetch the large history: when there is none, when the version is null, or when it differs from the one seen (src/runtimeFeed.ts:21-23).

### Dry-run UI (not on this tab: Home, "AI activity")

- **Purpose**: Check a review without acting; a completed Claude dry run is what unlocks Claude for agents and for trading.
- **Component files**: `AiActivity` in src/Dashboard.tsx:56, mounted at src/main.tsx:135 (the Home page; that panel belongs to another fragment). There is no dry-run control in src/EngineSettings.tsx; the Engine settings texts point to it as "Dashboard → Dry run" (src/EngineSettings.tsx:140, :143; src/RuntimeSettings.tsx:29). Connections shows the last measured dry run (src/ProviderCards.tsx:46 "Measured dry run").
- **What it shows**: a disclosure "Dry run" (aria-label "Dry run") with "Checks a review without acting on it: nothing is proposed, submitted or changed." (src/Dashboard.tsx:87). After "Dry-run review…": an estimate line ("Estimated cost: about $X.XX (up to $Y.YY), A–B AI requests, from <basis>. Today: …"), or for Claude with no estimate "No Claude Opus 5.5 review or dry run has run yet, so there is no cost estimate." / "...has completed yet..."; the data-sharing line "This sends your holdings and values to Anthropic."; the reservation line "The first request reserves about $X (from <basis>); up to N requests can reserve up to $Y." plus, when blocked, " Your Anthropic spending limit is $Z, below the first request: raise it in Connections before running." (:87). Results: a one-line text from `dryRunText` (:53-55), "Dry run failed (<code>)." (:65), a refusal block (:52), "…answer was not accepted…" (:50), a measurement table with columns "#", "Kind", "Model", "Stop", "In / out", "Cache read / write", "Tier", "Cost", "Request" (:43), and "Assembled inputs · <time>" with the JSON (:87).
- **Controls**: "Check inputs" (`dryRun('inputs')`); "Dry-run review…" (asks the estimate); select aria-label "Dry-run model" (only when the Anthropic key is loaded): "Current model (<id>)", "Claude Opus 5.5 · medium effort"; "Run dry-run review" (primary; disabled while busy, while a review runs, or when the Claude reservation is blocked); "Cancel" (src/Dashboard.tsx:87).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method |
|---|---|---|---|
| `dryRunEstimate(model)` | `runtime:dry-run-estimate` (electron/preload.cjs:30) | electron/main.cjs:728 | `automation.dryRunEstimate({model})` (electron/automation.cjs:539) |
| `dryRun(mode,options)` | `runtime:dry-run` (preload.cjs:28) | electron/main.cjs:729 | `automation.dryRun(mode,{model})` (electron/automation.cjs:380); on failure `automation.dryRunFailure(started)` (:957) |

- **Subscriptions**: `subscribeRuntime` plus a 3-second clock (src/Dashboard.tsx:58).
- **Saved state**: dry-run records are stored by the engine in table `dry_runs` (electron/automation.cjs:957, :960). The Claude dry run sends `{openaiModel:'claude-opus-5-5',reasoningEffort:'medium'}` as a one-off override; it does not change the saved settings (src/Dashboard.tsx:65; electron/automation.cjs:382).
- **Notes**: dry-run error codes thrown at the start of `dryRun` (electron/automation.cjs:381-385): `INVALID_REQUEST`, `REVIEW_BUSY`, `INVALID_MODEL_SETTINGS`, `DRY_RUN_NEEDS_KIS` (scope is paper), `AI_NOT_CONNECTED` (provider is not `openai` or the key is missing), `DATA_SHARING_NOT_ENABLED`. The handler passes codes matching `^[A-Z_]{3,40}$`, else `DRY_RUN_FAILED` (electron/main.cjs:729). The window shows the raw code inside "Dry run failed (<code>)." (src/Dashboard.tsx:65).

### Start / stop auto trading and background AI (not on this tab)

- **Purpose**: Start and stop unattended trading with a token that proves the window showed the current settings and account; pause background AI for the session.
- **Component files**: buttons in `AiActivity` (src/Dashboard.tsx:67, :81, Home) and in `RuntimePulse` (src/WorkspaceUX.tsx:38, not mounted). Engine: electron/auto-launch.cjs exports `launchState` (:3), `start` (:10), `stop` (:45).
- **What it shows**: button text "Start auto trading" / "Stop auto trading" / "Cancel start" / "Starting…" (src/Dashboard.tsx:81); the returned message as a note (:67, :86). Background AI line: "Background AI: scout, reflections, market narrative · paused for this session." or "Trading is stopped, but background AI still runs: …" with the link button "Pause background AI" / "Resume background AI" (src/Dashboard.tsx:83).
- **Controls**: the Start/Stop button calls `stopAutoTrading()` when `launch.running` or `launch.starting`, else `startAutoTrading(launch.token)` (src/Dashboard.tsx:67). No typed phrase in the window: `start` itself passes the confirmation phrases `ENABLE LIVE|MOCK` and `ENABLE AUTO LIVE|MOCK` to the live engines (electron/auto-launch.cjs:25).
- **Calls and channels**:

| `window.portfolio` method | IPC channel | main.cjs handler line | Engine method |
|---|---|---|---|
| `startAutoTrading(token)` | `runtime:start` (electron/preload.cjs:22) | electron/main.cjs:720 | `require('./auto-launch.cjs').start(automation,token)`; returns `{ok:true,message,state}` or `{ok:false,error:error.text??error.message,state}` |
| `stopAutoTrading()` | `runtime:stop` (preload.cjs:23) | electron/main.cjs:721 | `require('./auto-launch.cjs').stop(automation)`; same reply shape |
| `setBackgroundAi(paused)` | `runtime:background-ai` (preload.cjs:27) | electron/main.cjs:730 | `automation.setBackgroundPaused(paused)` (electron/automation.cjs:342) |

- **Subscriptions**: `subscribeRuntime` (src/Dashboard.tsx:58).
- **Saved state**:
  - The token (`state.launch.token`): SHA-256 of JSON `{config, identity, environment, policies}` where `policies` holds, per selected engine, the policy fields `symbols`, `maxOrderKRW`, `maxDailyTurnoverKRW`, `maxCompanyPct`, `lossLimit` (electron/auto-launch.cjs:7). Selected engines by scope: none for `paper`, Korea and U.S. for `both`, U.S. for `us`, Korea otherwise (:2). So any saved settings change, account change or one of those policy changes makes an old token invalid.
  - `state.launch` = `{token, label, running, starting}`; label "<ENVIRONMENT> · <Paper|Korea|U.S.|Korea + U.S.>"; `running` = `enabled && autoSubmit && sessionArmed &&` (every selected engine enabled and auto-enabled, or for paper the paper account not paused) (electron/auto-launch.cjs:4-8).
  - `start` on success: for each selected engine re-applies its saved policy with `ENABLE <env>` and `enableAuto('ENABLE AUTO <env>')`; unpauses the paper account when no engine is selected; then `configure({enabled:true,autoSubmit:true})` (electron/auto-launch.cjs:25-27). On a failure the engines' `enabled`/`autoEnabled` flags are restored (:28).
  - `stop`: bumps `launchGeneration` (cancels a start in progress), `configure({enabled:false,autoSubmit:false})`, then `live.stop()`, `usLive.stop()` and pauses the paper account when the scope is paper; the engines stop even if the save throws (electron/auto-launch.cjs:44-45).
  - Background AI pause is session-only: "the saved settings are unchanged and it runs again after a restart" (electron/automation.cjs:340-342). `state.backgroundAi` = `{paused, enabled:[...]}` listing "scout", "reflections", "market narrative" for the switches `scoutEnabled`, `reflectionEnabled`, `narrativeEnabled` (electron/automation.cjs:343). A non-boolean argument throws `INVALID_REQUEST` (:342).
- **Notes**: the start checks and all messages are listed under "Error-code-to-text tables" below.

### RuntimePulse

- **Purpose**: A status strip with the scheduler label, provider and scope, a Start/Stop button, the emergency notice and a "Details" disclosure.
- **Component files**: `RuntimePulse({onNavigate,expanded})` at src/WorkspaceUX.tsx:29. It is NOT mounted anywhere: the only occurrence of the name in src/ is its definition (grep of src/ for "RuntimePulse": one match, src/WorkspaceUX.tsx:29), and src/main.tsx:26 imports only `workspaceGroups, tabGuides, HOME, navLabels` from that file.
- **What it shows** (if it were mounted; src/WorkspaceUX.tsx:34-38): "Browser preview · Runtime services require the desktop application." without the desktop API; label "Runtime connection interrupted" (stale: failed, or no state for over 6000 ms), "Review needs attention" (last error and not busy), else `state.scheduler.label`, else "Checking engine…"; prefix "Emergency · "; sub-line "<OpenAI|Claude|Local rules|External agent> · <Korea + U.S.|U.S.|Korea|Paper>", "Reconnect to check status" or "Connecting…"; "<launch.label> · Saved guidelines"; notice "Guardrail stopped auto trading today." with button "View guardrails"; emergency block "<Paper|KIS> emergency: loss-reduction review" with "Daily loss ₩/$… (N%). Reviews every minute when enabled. Existing limits and approval settings apply."; "Details" with facts "Provider", "Submission", "Last success", "Next review" ("Waiting for setup / manual action" when not monitoring), the last error with "Inspect console", and, when `expanded`, four journey buttons "1 · Connect", "2 · Configure", "3 · Practice", "4 · Verify".
- **Controls**: "Start auto trading" / "Stop auto trading" / "Cancel start" / "Working…" (tooltips "Activate the displayed portfolio and submit AI decisions automatically using saved settings" and "Stop new automatic orders; existing broker orders remain active"); "Run emergency review now"; "View guardrails" (→ "Engine settings"); "Inspect console" (→ "AI console"); journey buttons (src/WorkspaceUX.tsx:38).
- **Calls and channels**: `startAutoTrading(token)`, `stopAutoTrading()`, `reviewRuntime()` as in the tables above (src/WorkspaceUX.tsx:38).
- **Subscriptions**: `subscribeRuntime`, a 2000 ms clock, and an 8000 ms timer that clears the action message (src/WorkspaceUX.tsx:31, :33).
- **Saved state**: none (renderer-only).
- **Notes**: the same file holds the sidebar data that IS used: `workspaceGroups` (the "Settings" group lists "Connections", "Engine settings", "Fees & taxes", "Short & leverage"), `navLabels` ("Engine settings" → "Engine") and `tabGuides` ("Engine settings": "How and when the AI reviews and trades.") (src/WorkspaceUX.tsx:4, :7, :25).

## Engine settings: error-code-to-text tables

**1. Settings save: `SAVE_ERRORS`** (src/RuntimeSettings.tsx:28-30; 8 entries, complete):

| Code | Text in the window |
|---|---|
| `CLAUDE_NOT_ENABLED_FOR_TRADING` | "Claude models run dry-run reviews only for now; trading on Claude is not enabled yet." |
| `CLAUDE_TRADING_DRY_RUN` | "Trading on Claude Opus 5.5 needs a dry run on this version first: Dashboard → Dry run → Claude Opus 5.5." |
| `CLAUDE_TRADING_KEY` | "Load your Anthropic key in Connections first." |
| `CLAUDE_TRADING_CONSENT` | "Allow sharing KIS data with Anthropic in Connections first." |
| `CLAUDE_TRADING_LIMITS` | "Your Claude daily limits do not cover one review. Raise them in Engine settings." |
| `CLAUDE_TRADING_CONFIRM` | "Confirm trading on Claude Opus 5.5 first." |
| `CLAUDE_MODEL_NOT_FOR_TRADING` | "Only Claude Opus 5.5 can be the trading model." |
| `INVALID_MODEL_SETTINGS` | "A model and its effort don’t go together: GPT-6 Astra needs at least Low. Check the agents on the Agents tab." (not reachable from `runtime:configure`, see above) |

**2. `CLAUDE_DRY_RUN_REQUIRED:<agent>`** (src/RuntimeSettings.tsx:32; src/agentDraft.mjs:15-17): "<Title> is set to Claude Opus 5.5, which needs a measured dry run on this account. Run one, or choose another model for it." Titles: `scout` "Scout", `narrative` "Market narrative", `compacting` "Context compacting", `reflection` "Reflection"; unknown → "An agent".

**3. Engine-side texts of `claudeTradingRefusal`** (electron/automation.cjs:991-999; same codes as table 1; these texts are attached as `error.text` and reach the window only through `runtime:start`/`runtime:stop`, electron/main.cjs:720-721). They equal table 1 except `CLAUDE_TRADING_LIMITS`: "Your Claude daily limits do not cover one review (about $X and up to N requests). Raise them in Engine settings."

**4. Codes the `runtime:configure` handler lets through** (electron/main.cjs:724): `CLAUDE_NOT_ENABLED_FOR_TRADING`, `CLAUDE_DRY_RUN_REQUIRED:(scout|narrative|compacting|reflection)`, `CLAUDE_TRADING_DRY_RUN`, `CLAUDE_TRADING_KEY`, `CLAUDE_TRADING_CONSENT`, `CLAUDE_TRADING_LIMITS`, `CLAUDE_TRADING_CONFIRM`, `CLAUDE_MODEL_NOT_FOR_TRADING`. Everything else: `INVALID_SETTINGS`.

**5. Start auto trading: refusals thrown by `start`** (electron/auto-launch.cjs:11-24; plain sentences, no codes; complete):

| Check | Message |
|---|---|
| a start or a review is running | "A review is already running. Wait for it to finish." |
| the token differs from the current one | "Settings or account changed. Check the updated account label and try again." |
| `lossAction==='stop'` and the emergency is active | "The daily loss limit is reached and the guardrail keeps auto trading stopped today. Change Loss-limit response in Engine settings to restart." |
| provider is `external` | "Choose an AI model in Engine settings to start automatic reviews." |
| provider `openai` and the model's key is missing | "Import your <OpenAI|Anthropic> key in Connections first." (vendor name from `missingKey`) |
| scope is not paper and provider is not `openai` | "Select an AI model for broker auto trading. Local rules are for paper practice." |
| scope is not paper and the model's vendor has no consent | "Allow sharing KIS data with <vendor> in Connections." (electron/automation.cjs:909) |
| the vendor's daily budget cannot cover one reservation | "Daily API budget reached. Update your budget or wait for the next day." |
| settings or account changed during the start | "Launch canceled because settings or the account changed." |
| an engine has no snapshot or is disconnected | "Connect the selected KIS account first." |
| an engine has no funded balance | "<market>: no funded balance available. Choose a funded market in Engine settings." |
| an engine is processing an order | "An order is being processed. Try again after it completes." |

**6. Start/stop success messages** (electron/auto-launch.cjs:37-45): "Auto trading started. Markets are closed, so the first review runs at the open (HH:MM KST)." (closed markets, choice `off`); "Auto trading started. Markets are closed and the pre-open review already ran; next review at HH:MM KST."; "Auto trading started. Markets are closed, so the first review runs before the next open."; "Auto trading started. A review is due and starts shortly."; "Auto trading started. Next review at HH:MM KST, on schedule."; stop: "Auto trading stopped. Existing broker orders remain active." With the U.S. market in scope and its automatic switch on, Start appends: "U.S.: buys and sales are sent automatically, each counted against your won cash; limits: maximum order …, daily turnover …, per company …, daily loss …." (`auto-launch.cjs` `usLine`, values from the saved U.S. policy).

**7. Scheduler status labels** (`schedulerStatus`, electron/automation.cjs:218-229; shown by status components, 10 distinct labels): "Starting auto trading" / "Review in progress" / "Manual reviews only" ("Scheduled reviews are disabled in your saved settings.") / "Paused after restart" ("Your settings were restored. Use Start auto trading to resume, or run a manual review.") / "Waiting for external agent" / "API key required" / "Paper account paused" / "Data sharing required" / "Daily API limit reached" / "Monitoring" (with a closed-markets detail, or "Waiting for the next scheduled review or price-movement trigger.").

**8. Phone test** (electron/main.cjs:554; src/EngineSettings.tsx:204): `NO_WEBHOOK` → "Add a webhook in Connections first."; `PHONE_ALERTS_OFF` (and any other failure) → "Turn on phone alerts and save first."; thrown call → "Could not reach the engine."

**9. Guardrail event kinds** (src/Guardrails.tsx:5): `auto-stopped` "Auto trading stopped"; `buys-blocked` "Buys blocked"; `order-limit` "Order limit reached"; unknown kinds show the raw kind.

**10. Model names** (src/EngineSettings.tsx:18; src/claudeConfirmLines.mjs:5): `gpt-6-luna` "GPT-6 Luna", `gpt-6-sol` "GPT-6 Sol", `gpt-6-astra` "GPT-6 Astra", `claude-opus-5-5` "Claude Opus 5.5", `claude-haiku-5-5` "Claude Haiku 5.5".

**11. Start with Windows** (electron/login-item.cjs:13, :20, :21, :31, :48; electron/main.cjs:634): texts listed in the Trading tab above.

**12. Manual review** (electron/main.cjs:731): error `automation.lastError ?? 'REVIEW_FAILED'`, message `automation.lastErrorDetail ?? 'Review failed.'`. Automatic (not user-requested) reviews can throw `REVIEW_BACKOFF` and `REVIEW_PROVIDER_WAIT` (electron/automation.cjs:696-700); a user request skips both checks (:696).

## Fees & taxes

- **Purpose**: Fee and tax assumptions used for order estimates, the tax profile, and read-only ledgers: overseas capital gains, dividends and interest, and executed order costs (src/main.tsx:148).
- **Component files**: `<TradingCosts/>` then `<TaxLedger/>` (src/main.tsx:148). `TradingCosts` contains `TaxProfileCard` (src/TradingCosts.tsx:31,45). `SaleCosts` (src/TradingCosts.tsx:13) is exported from the same file but is not mounted on this tab (it takes a `CostEstimate`; where it is mounted: not determined). Shared inputs: `MoneyField` (src/MoneyField.tsx:11), `src/money.ts`, `Card`/`Row`/`NumberField` (src/SettingsUI.tsx:5-22).
- **Notes**: the tab is shown whether or not KIS is connected (src/main.tsx:148 has no `isKis` condition).

### TradingCosts (Commissions, tax inputs)

- **Purpose**: Edits the saved fee plan and the user's tax inputs; new proposals and reviews use the saved values (src/TradingCosts.tsx:19,25).
- **Component files**: `TradingCosts` (src/TradingCosts.tsx:14); types `CostSettings`, `TaxResult`, `CostEstimate`, `TaxProfile`, `TaxProfileState` (src/TradingCosts.tsx:7-11).
- **What it shows**:
  - "Loading fee settings…" until loaded (src/TradingCosts.tsx:17).
  - A draft bar (aria-label "Unsaved fee settings") when there are unsaved edits: "Unsaved changes", "New proposals use the saved rates until you save" (src/TradingCosts.tsx:23).
  - A status message: "Costs saved. New proposals and reviews use these values." or "Check the fee rates, tax year, exchange rate and acquisition costs."; toasts "Fees & taxes saved" / "Not saved: check the highlighted values" (src/TradingCosts.tsx:19,24).
  - Card "Commissions and sale fees", hint "Used to estimate every order and review.", pill "Estimates" (src/TradingCosts.tsx:25). Rows: "Korea commission" (%), "U.S. commission" (%), "U.S. sale levy" (%), "U.S. minimum sale levy" (USD) (src/TradingCosts.tsx:26); "Korea sale tax" with hint "Statutory by market and date (2026: 0.20%). Set only to override." and placeholder "Statutory" (src/TradingCosts.tsx:27). Note "These rates are editable estimates.": "Initial rates are editable assumptions, not your account’s confirmed plan. U.S. commission and levy defaults follow the published KIS schedule. Discounts, product charges and settlement rounding can differ. Missing annual gains, KRW basis or FX leave capital-gains tax unknown. Ordinary Korean listed minority-shareholder cash trades are assumed; special accounts and major-shareholder taxation are excluded." (src/TradingCosts.tsx:28). Links "KIS fee schedule ↗" and "KIS tax guide ↗" (src/TradingCosts.tsx:29).
  - The "Tax profile" card (see below).
  - Card "Korean tax on U.S. shares", hint "22% above the ₩2,500,000 yearly deduction, shared across brokers." (src/TradingCosts.tsx:32). Rows: "Tax year"; "Gains realized at other brokers" (hint "This year, losses included; 0 if none. KIS trades are added from its history"); "Cost method"; "USD → KRW settlement rate" (hint "Used when the broker hasn't reported one"); "Acquisition cost" (hint "Shares older than the KIS history, KRW per share (or add an opening lot in the ledger)") (src/TradingCosts.tsx:33-37). A list of entered acquisition costs: symbol, KRW amount, "Remove" (src/TradingCosts.tsx:38). Note "South Korean resident · individual account" with the text beginning "South Korean resident · Individual account. Estimated annual tax: 22% above the shared ₩2,500,000 deduction for eligible gains. …" (src/TradingCosts.tsx:39).
- **Controls**:
  - "Save fees & taxes" (primary; only in the draft bar; disabled while saving) sends the whole settings object (src/TradingCosts.tsx:19,23). No confirmation.
  - Four number inputs (min 0, max 100, step 0.00001) for the commission rows; an out-of-range value shows "Allowed 0–100<unit>" at once (src/TradingCosts.tsx:26; src/SettingsUI.tsx:20-21).
  - "Korea sale tax override" number input (step 0.01, min 0, max 100); empty means null = statutory (src/TradingCosts.tsx:27).
  - "Tax year" number input (min 2023, max 2100) (src/TradingCosts.tsx:33).
  - "Gains realized at other brokers (KRW)": a `MoneyField` in KRW, placeholder "Unknown"; empty means null (src/TradingCosts.tsx:21,34).
  - "Tax cost method" select: "Moving average (KIS default)" / "First in, first out" (src/TradingCosts.tsx:35).
  - "Indicative USD to KRW settlement rate": a plain number input, step 0.01, unit "KRW", placeholder "Unknown"; empty means null (src/TradingCosts.tsx:21,36).
  - Acquisition cost: text input "Acquisition cost stock" (upper-cased; default "NASD:AAPL"), `MoneyField` "Acquisition cost per share (KRW)" (placeholder "KRW per share"), button "Set". "Set" is disabled unless the symbol matches `NASD|NYSE|AMEX:TICKER` and a non-negative amount is entered; it adds to the draft (not saved until "Save fees & taxes") (src/TradingCosts.tsx:15,37). "Remove" per entry also edits the draft (src/TradingCosts.tsx:38).
  - The two links open through `openNews(url)` (src/TradingCosts.tsx:20).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getCosts()` | `costs:get` | main.cjs:326 | `costs.saved()` (electron/trading-costs.cjs:95): saved settings over `DEFAULT_COSTS` |
| `saveCosts(value)` | `costs:save` | main.cjs:327 | `costs.save(value)` (electron/trading-costs.cjs:113) → `validateCosts` (electron/trading-costs.cjs:8-18); throws `INVALID_COST_SETTINGS` |
| `openNews(url)` | `runtime:open-news` | not read (not determined) | not determined |

- **Subscriptions**: none; settings are read once on mount and ignored if a draft is dirty (src/TradingCosts.tsx:16).
- **Saved state**: SQLite table `trading_cost_settings`, row id 1, payload `{settings:{…}}` (electron/trading-costs.cjs:95,113). Unsaved edits live in session drafts `costs:settings`, `costs:dirty`, `costs:symbol`, `costs:basis` (src/TradingCosts.tsx:15), so they survive a tab change but not a reload (src/useDraftState.ts:2).
- **Notes**: `validateCosts` rejects any unknown key (electron/trading-costs.cjs:9). The save handler does not catch the error; the renderer shows the "Check the fee rates…" message (main.cjs:327; src/TradingCosts.tsx:19). The engine comment gives the statutory Korean sale taxes for 2026 (KOSPI 0.05% + 0.15% rural special tax, KOSDAQ 0.20%) from `electron/tax-rules.cjs`, and the U.S. levy as the SEC Section 31 fee, USD 20.60 per million (electron/trading-costs.cjs:2-4).

### TaxProfileCard (Tax profile)

- **Purpose**: Says who the tax figures are for; an answer outside the supported profile turns the affected estimates off (src/TradingCosts.tsx:43-44).
- **Component files**: `TaxProfileCard` (src/TradingCosts.tsx:45); rendered inside `TradingCosts` (src/TradingCosts.tsx:31).
- **What it shows**: card "Tax profile", hint "Decides whether the ordinary rules apply.", pill "Confirmed" (all three answers given and the account type set) or "Assumed" (src/TradingCosts.tsx:53). Rows "Tax residency", "Lived in Korea 5 of the last 10 years", "Major shareholder of a Korean listed company", and, only for a connected live account, "This account" with hint "The connected KIS live account" (src/TradingCosts.tsx:54-57). Note "Why these questions": "Estimates cover an ordinary taxable account of a Korean resident individual. ISA, pension, RIA and corporate accounts, non-residents and major shareholders follow other rules that are not implemented: their estimates show as not supported rather than wrong. No identifiers are stored." (src/TradingCosts.tsx:58). Renders nothing until loaded (src/TradingCosts.tsx:48).
- **Controls**: four selects; each change saves at once (no Save button, no confirmation) and shows toast "Tax profile saved" or "Not saved" (src/TradingCosts.tsx:50-57). Options: residency "Not confirmed" / "Korean resident" / "Non-resident"; long-term resident "Not confirmed" / "Yes" / "No"; major shareholder "Not confirmed" / "No" / "Yes"; account type "Not confirmed" / "Ordinary brokerage" / "ISA" / "Pension / IRP" / "RIA" / "Corporate" / "Other" (src/TradingCosts.tsx:54-57). Choosing "Not confirmed" for the account removes its entry; any other choice saves `{type, linked:true}` (src/TradingCosts.tsx:57).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getTaxProfile()` | `costs:tax-profile` | main.cjs:334 | `costs.profile.get()` (electron/tax-profile.cjs:46) plus `{accountKey: ownerAccount(...), environment}` of the connected account |
| `saveTaxProfile(value)` | `costs:save-tax-profile` | main.cjs:335 | `costs.profile.save(value)` (electron/tax-profile.cjs:47) → `validateProfile` (electron/tax-profile.cjs:7-14); throws `INVALID_TAX_PROFILE` |

- **Subscriptions**: none (one read on mount, src/TradingCosts.tsx:47).
- **Saved state**: SQLite table `tax_profile`, row id 1 (electron/tax-profile.cjs:45-47).
- **Notes**: effects of the answers are decided by `applicability` (electron/tax-profile.cjs:19-36): non-resident, a non-ordinary account type, under 5 of 10 years (U.S. market), or major shareholder (Korean market) give status `unsupported` with reasons such as "non-resident taxation is not implemented", "ISA account rules are not implemented", "residents of under 5 of the last 10 years follow different overseas-gain rules", "major-shareholder taxation of Korean shares is not implemented". Unanswered questions give `estimated` with assumptions such as "Korean tax resident individual (not confirmed)" and "ordinary taxable brokerage account (not confirmed)". Mock and paper accounts are always `estimated` "as if an ordinary taxable account; not in the tax ledger" (electron/tax-profile.cjs:22). The account key shown to the renderer has the ":US" suffix removed (`ownerAccount`, electron/tax-profile.cjs:16).

### TaxLedger (Overseas capital gains, Dividends and interest, Executed order costs)

- **Purpose**: Read-only tax and cost ledgers with a few record-keeping inputs (src/TaxLedger.tsx:15-66).
- **Component files**: `TaxLedger`, type `TaxSummary` (src/TaxLedger.tsx:11,15); mounted at src/main.tsx:148.
- **What it shows**:
  - Section "Overseas capital gains · <year>" with a sub-line "<First in, first out|Moving average> cost · KRW at settlement-date rates · realized by settlement date · <n account(s)|no live account yet> · file and pay 1–31 May <year+1>" (src/TaxLedger.tsx:26). Three figures: "Net gains this year" (sub-line "Known records <KRW>" or "App <KRW> · outside <KRW>"); "Basic deduction left" ("of <KRW>" + " · plus <KRW> of losses"); "Estimated tax (20% + 2% local)" (value, or "Not supported"; sub-line "Filed and paid in May next year", the unsupported reasons, or "Missing: …" + " · known records alone <KRW>, not a bound") (src/TaxLedger.tsx:28-30). Unknown amounts read "Unknown" (src/TaxLedger.tsx:12).
  - Table "Overseas sales": columns "Settled", "Stock", "Shares", "Proceeds", "Cost", "Gain", "Source"; an estimated settlement date has " *"; the Source cell reads "<fx source> (provisional) · broker rate <r> · fees <source> · <basis source>" (src/TaxLedger.tsx:32). Empty: "No U.S. sales settle in <year> yet." (src/TaxLedger.tsx:32).
  - A reconciliation notice: "<symbol>: KIS holds <n>, records show <m> · … . Tax on these shares stays unknown until an opening lot or record explains the difference." (src/TaxLedger.tsx:33).
  - Disclosure "Opening lots · <n>": "Shares bought before KIS history covers them, in KRW at the settlement-date rate."; a list "<symbol> · <qty> · <date>" (+ " · excl. fees"), the KRW cost and "Remove" (src/TaxLedger.tsx:34-36).
  - Disclosure "KRW cost of held shares · <n>": table "Overseas cost basis" with columns "Stock", "Shares", "KRW cost", "Per share" (src/TaxLedger.tsx:39).
  - Note "Assumptions · <n>" listing the assumptions and "Rules <version>." (src/TaxLedger.tsx:40). Note "About dates, exchange rates and the rate" (text at src/TaxLedger.tsx:41, ending "Not tax advice; dividends and special accounts are not included.").
  - Section "Dividends and interest · <year>" (only when `state.income` exists), sub-line "Separate from capital gains · withholding is not the final annual tax" (src/TaxLedger.tsx:43). Figures: "Gross income" ("Recorded <KRW> · elsewhere <KRW|not declared>"), "Tax withheld" ("Net received <KRW>"), "Comprehensive taxation" ("Review" when the known total is over ₩20,000,000, "Unknown", or "Below"; sub-line from the engine) (src/TaxLedger.tsx:45-47). Table "Income payments": columns "Paid", "Stock", "Kind", "Gross", "Withheld", "Net", "Check", and a "Remove" column; Kind adds " · from detected cash" for a detected flow; Check reads "Gross − tax = net", "Differs by <amount>" or "Incomplete" (src/TaxLedger.tsx:49).
  - Disclosure "Record a payment" and disclosure "Korean ETF tax class · <n>" with "From the issuer's documents. Domestic-equity ETFs: sale gains untaxed. Others: 15.4% on the lower of the gain and the taxable-NAV increase." and a list "<code> · Domestic equity|Taxable · Remove" (src/TaxLedger.tsx:50-58).
  - Section "Executed order costs": sub-line "Checked <date time>" or "Checked every 15 minutes", plus " · mock account: KIS reports U.S. trade costs only for live accounts" on a mock account (src/TaxLedger.tsx:61). Table columns "Day", "Order", "Commission", "Tax / levy", "Net cash", "Source"; Commission adds " · est. <amount>" beside a broker figure; Source reads "Broker-reported" or one of "Waiting for broker", "Not offered for this account", "Estimate (could not match trades)", "Estimate" (src/TaxLedger.tsx:14,62). Empty: "No executed broker orders yet." (src/TaxLedger.tsx:62). An error line "Last check: <code>" (src/TaxLedger.tsx:63). Note "Where fee and tax figures come from": "Korean orders use the fee-and-tax total KIS reports for the order; the 0.20% sale tax (none for ETFs and ETNs) is shown separately and the rest as commission. U.S. orders use KIS settled trade history: fees, settlement amount and exchange rate." (src/TaxLedger.tsx:64).
  - The whole component renders nothing until the first summary arrives (src/TaxLedger.tsx:18).
- **Controls**:
  - Opening lot form: "Opening lot stock" (placeholder "NASD:AAPL", upper-cased), "Opening lot shares" (number, min 1, placeholder "Shares"), "Opening lot acquired on" (date), `MoneyField` "Opening lot KRW cost" (placeholder "Total KRW cost"), checkbox "incl. fees" (default on), button "Add" (disabled unless the symbol matches `NASD|NYSE|AMEX:TICKER`, shares ≥ 1, a date and a cost are entered) (src/TaxLedger.tsx:37). "Remove" per lot (src/TaxLedger.tsx:36). No confirmation on remove.
  - Record a payment: "Income stock" (placeholder "NASD:AAPL or 005930"), select "Income kind": "Dividend" / "Fund distribution" / "Interest"; "Income paid on" (date); select "Income currency": "USD" / "KRW" (also sets country US/KR) (src/TaxLedger.tsx:51). Five `MoneyField`s with placeholders "Gross", "Foreign tax", "Korean tax", "Local tax", "Net received", in the chosen currency; button "Add" (disabled without a symbol, a date and at least gross or net) (src/TaxLedger.tsx:52). "Remove" per payment row (src/TaxLedger.tsx:49).
  - "Interest and dividends received elsewhere in <year> (KRW)": `MoneyField` "Financial income elsewhere", placeholder "Not declared", `commitOnBlur`: it saves when the field loses focus; empty saves null (src/TaxLedger.tsx:53).
  - Korean ETF tax class: "ETF code" (placeholder "069500"), select "ETF tax class": "Domestic equity" / "Taxable (overseas, bond, commodity…)", button "Set" (disabled unless the code matches one digit plus five digits or capitals); "Remove" per entry (src/TaxLedger.tsx:57-58).
  - "Check broker costs" ("Checking…"; disabled while busy or `state.refreshing`) (src/TaxLedger.tsx:61).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getTaxSummary()` | `costs:tax-summary` | main.cjs:667 | `costs.taxSummary()` (electron/trading-costs.cjs:257) plus `refreshedAt`, `error`, `refreshing`, `environment` |
| `refreshCharges()` | `costs:refresh-charges` | main.cjs:668 | `refreshCharges()` (main.cjs:660-663): `engine.refreshCharges()` for the Korea and U.S. engines, `importTaxTrades()` (main.cjs:655-659), then missing FX rates via `providerService.request('fx-rates')` and `costs.saveRates` |
| `addOpeningLot(value)` | `costs:add-opening-lot` | main.cjs:332 | `costs.addOpeningLot(value)` (electron/trading-costs.cjs:227-232); returns `costs.taxSummary()` |
| `removeOpeningLot(id)` | `costs:remove-opening-lot` | main.cjs:333 | `costs.removeOpeningLot(id)` (electron/trading-costs.cjs:233) |
| `addIncome(value)` | `costs:add-income` | main.cjs:328 | `costs.addIncome(value)` (electron/trading-costs.cjs:123) → `income.add` → `validate` (electron/income-events.cjs:9-15,32) |
| `removeIncome(id)` | `costs:remove-income` | main.cjs:329 | `costs.income.remove(id)` (electron/income-events.cjs:33) |
| `declareIncome(year,value)` | `costs:declare-income` | main.cjs:330 | `costs.income.declare(year,value)` (electron/income-events.cjs:37) |
| `setFundClass(symbol,value)` | `costs:fund-class` | main.cjs:331 | `costs.setFundClass(symbol,value)` (electron/trading-costs.cjs:118-119) |

- **Subscriptions**: polls `getTaxSummary()` every 60000 ms (src/TaxLedger.tsx:17). The main process refreshes charges every 15 minutes and once 2 minutes after start (main.cjs:664-666).
- **Saved state**: SQLite tables `tax_opening_lots` (electron/trading-costs.cjs:226,231), `income_events` and `income_declarations` (electron/income-events.cjs:32,37), `fund_tax_class` (electron/trading-costs.cjs:117-119), `fx_rates` (electron/trading-costs.cjs:126). The form fields are component state only (src/TaxLedger.tsx:16).
- **Notes**:
  - Failures of these calls are swallowed in the renderer: no message is shown, the form just stays filled (src/TaxLedger.tsx:19-22). Engine error codes: `INVALID_OPENING_LOT` (symbol format, integer quantity 1–10,000,000, a date not after today, cost 0–1e13, boolean flag), `KIS_NOT_CONNECTED` (opening lot without an account; income without a live account), `INVALID_INCOME_EVENT`, `INVALID_FUND_CLASS` (electron/trading-costs.cjs:118-119,123,228-229; electron/income-events.cjs:11-13,37).
  - `chargesError` codes shown after "Last check:": any upper-case code from the engines, else `CHARGES_FAILED` or `TAX_IMPORT_FAILED` (main.cjs:661-663).
  - Tax trade import runs only for a live account (main.cjs:655).

### MoneyField and money.ts (how money inputs behave)

- **Purpose**: The one input for an amount of money (src/MoneyField.tsx:1-5).
- **Component files**: `MoneyField` (src/MoneyField.tsx:11); pure helpers in `src/money.ts`. `NumberField` switches to it when given a `currency` (src/SettingsUI.tsx:18).
- **What it shows**: a text input (`inputMode="decimal"`) showing the amount grouped with commas while typing, with the caret kept in place (src/MoneyField.tsx:27-28,53; src/money.ts:34-41). An optional unit label (src/MoneyField.tsx:56). Under it a read-back line: for KRW "₩3,000,000 · 300만 원" (Korean units 조/억/만), for USD "$1,234.50" (src/money.ts:48-55; src/MoneyField.tsx:51,57). When a problem occurs the line shows it instead: "Whole won only", "Two decimals at most", "Too large", or "Couldn’t read “<text>”: numbers only" (the quoted text is cut at 24 characters) (src/money.ts:60-61). When `min`/`max` are given and the value is outside: "Allowed <min>–<max> <unit>" (src/MoneyField.tsx:50,58). With `accountValue` given and the amount over ten times it, the line adds " · over 10× this account — check the amount" (never blocking) (src/money.ts:73-74; src/MoneyField.tsx:51).
- **Controls**:
  - Typing: KRW accepts whole won only; USD at most two decimals; at most 15 integer digits; a refused character never appears and the field stays unchanged (src/money.ts:6-20; src/MoneyField.tsx:34-36).
  - Paste: reads "3,000,000", "₩3,000,000", "3 000 000", "3000000원", "$1,234.50", "1,234.50 USD"; a zero fraction on KRW is accepted; commas must sit between thousands; anything else is refused whole, never cut (src/money.ts:21-33; src/MoneyField.tsx:40-41).
  - Backspace/Delete next to a comma removes the digit beyond the comma (src/money.ts:42-47; src/MoneyField.tsx:45).
  - Ctrl/Cmd+Z, Ctrl+Shift+Z and Ctrl+Y: its own undo/redo of up to 50 steps (src/MoneyField.tsx:27,43-44).
  - Arrow Up/Down are ignored (src/MoneyField.tsx:46).
  - Korean IME: nothing is regrouped while composing; the composed text is then read like a paste (src/MoneyField.tsx:47-49).
  - `commitOnBlur`: the value is given back only when the field loses focus and there is no problem (src/MoneyField.tsx:55).
  - `quick`: buttons "+10만", "+100만", "+1,000만" (KRW) or "+$100", "+$1,000", "+$10,000" (USD) that add to the amount; aria-labels "Add ₩100,000" / "Add $100.00" style (src/money.ts:69-71; src/MoneyField.tsx:60-61). Not used on the Fees & taxes tab (no `quick` prop at src/TradingCosts.tsx:21,37 or src/TaxLedger.tsx:37,52,53).
- **Calls and channels**: none.
- **Subscriptions**: none.
- **Saved state**: none; it returns the plain value ("3000000", "1234.5", or '' for blank) to its parent (src/money.ts:2-3; src/MoneyField.tsx:4-5).
- **Notes**: a change of currency re-reads the shown text and reports a problem (and gives back '') if the new currency cannot hold it (src/MoneyField.tsx:21-23). A value set from outside replaces what is shown, except that an outside 0 does not overwrite an empty box (src/MoneyField.tsx:17-20).

## Short & leverage

- **Purpose**: Per-account switches and caps for leveraged/inverse ETFs, margin buying and short selling, plus manual product classification (src/ShortLeverage.tsx:56-72).
- **Component files**: `ShortLeverage` (src/ShortLeverage.tsx:56) with internal `MarketCard` (src/ShortLeverage.tsx:27); types `ExposureState`, `ExposureReply` (src/ShortLeverage.tsx:14-15). Mounted at src/main.tsx:141 (no `isKis` condition).
- **What it shows**:
  - "Loading…" until the first reply (src/ShortLeverage.tsx:59).
  - A top note with summary "Off by default. The AI proposes within your caps; the notices under each type say what applies now." and body "These settings let the AI propose leveraged or short exposure within your caps. It never changes them. Each type is off by default and, unless you turn on automatic submission, every such order waits for your approval. Closing positions is never blocked by the daily loss limit; selling and repaying a margin loan go through the app, while covering a short is done in the KIS app until the app can confirm how KIS names the short lot being repaid. KIS may require investor education, a credit agreement or a minimum deposit before your account can use them." (src/ShortLeverage.tsx:62).
  - A notice: "Saved.", an error text, "The change could not be saved." or "Could not reach the engine."; toasts "Short & leverage settings saved", "Not saved: <reason>" (src/ShortLeverage.tsx:60,63).
  - Card "Korea" and card "U.S." (src/ShortLeverage.tsx:64-65). Without an account or policy: "Connect this account to configure leveraged products." (src/ShortLeverage.tsx:29). Otherwise a state pill for the saved leveraged-ETF setting: "automatic", "propose only" or "off" (src/ShortLeverage.tsx:20,34). A facts line: "Leveraged <pct> of account · effective exposure <pct>" and, with credit data, " · margin loans <KRW> · collateral <n>%" (src/ShortLeverage.tsx:35).
  - Sections per card: Korea shows all three, the U.S. only the first (src/ShortLeverage.tsx:30). Titles: "Leveraged & inverse ETFs", "Margin buying (신용매수)", "Short selling (대주매도)"; each title is followed by the saved status (src/ShortLeverage.tsx:23-25,37).
  - For margin and short when the account is not live: "Live accounts only · KIS does not offer credit orders on mock accounts." (src/ShortLeverage.tsx:36,38).
  - For margin and short, credit-path notices: "Opening:" and "Repaying:" (margin), "Opening:" and "Covering:" (short), each "<Not available. ><label> Why: <reason>." (src/ShortLeverage.tsx:39). Labels come from the engine: "Automatic credit openings temporarily disabled pending validation." (openings) and "Requires approval—not automatic protection." (closings) (electron/credit-paths.cjs:51-52,57). All four paths are currently `executable:false` with a recorded reason (electron/credit-paths.cjs:45-50).
  - For leveraged ETFs with the switch saved on and eligibility not confirmed: "Not offered to the AI until you confirm eligibility." (src/ShortLeverage.tsx:43). Note "Why the app asks" (text at src/ShortLeverage.tsx:44, about the KRW 10 million basic deposit and investor education).
  - Each section's switch row carries a risk hint (src/ShortLeverage.tsx:23-25,40): leveraged "Daily-reset products: over weeks their return can differ sharply from the multiple of the index return."; margin "Borrowed money magnifies gains and losses; if the collateral ratio falls below the broker's maintenance level, KIS can sell holdings (반대매매). Loans mature (usually within 90–150 days)."; short "Losses on a short are unlimited if the price keeps rising. Borrowed shares must be repaid by the deadline, and availability depends on the lending pool.".
  - Table "<name> leveraged positions" (when any non-standard product is held): columns "Holding", "Product" ("2x", "1x inverse" …), "Held" ("<n> d" + " · over limit" past the draft's day limit) (src/ShortLeverage.tsx:19,50).
  - Table "<name> margin loans": columns "Loan" ("<symbol> · <qty> sh · <loan date>"), "Amount", "Matures" ("<date> (<n> d)"), "Interest (est.)" (src/ShortLeverage.tsx:51).
  - Table "<name> short positions": columns "Short", "Sold at", "Now", "Move", "Repay in", "Fee (est.)" (src/ShortLeverage.tsx:52).
  - A list of credit warnings, each `role="alert"` (src/ShortLeverage.tsx:53).
  - Card "Product classification", hint "Fix a product the app misread. Use a negative multiple for inverse." (src/ShortLeverage.tsx:66); table "Product overrides" with columns "Symbol", "Multiple" and "Remove" (src/ShortLeverage.tsx:68); note "How products are classified": "Products are classified from the KIS symbol list (for example 레버리지, 인버스2X, UltraPro, Bear 3X) and a list of common U.S. tickers." (src/ShortLeverage.tsx:69).
- **Controls**:
  - Per section: switch "Allow <leveraged and inverse ETFs | margin buying | short selling>" (src/ShortLeverage.tsx:40). Turning it off also sets `auto` to false in the draft (src/ShortLeverage.tsx:31).
  - Leveraged only: select "My KIS account can buy these products" (hint "KIS requires a basic deposit and investor education."): "Not confirmed" / "Yes" / "No" (src/ShortLeverage.tsx:42).
  - Switch "Submit automatically" (hint "Off: each order waits for your approval"); disabled while the section is not allowed (src/ShortLeverage.tsx:46).
  - Number fields, shown only while the section is allowed in the draft (step 0.1): see the Settings rows table (src/ShortLeverage.tsx:23-25,47). Source selects "Loan source" / "Stock loan source": "KIS own (자기)" / "KSFC distribution (유통)" (src/ShortLeverage.tsx:47).
  - Button "Save Korea settings" / "Save U.S. settings" (primary; disabled while busy or when nothing changed; "Unsaved changes" beside it). It sends only the sections shown for that market (src/ShortLeverage.tsx:32,49). No confirmation step or typed phrase.
  - Product classification: text input "Override symbol" (placeholder "122630 or NASD:TQQQ", upper-cased and trimmed), number input "Override multiple" (step 0.5, placeholder "2, 3, −1"), button "Set multiple" (disabled while busy or when either is empty); "Remove" per override (src/ShortLeverage.tsx:67-68).
- **Calls and channels**:

| window.portfolio method | IPC channel | main.cjs handler | Engine call |
|---|---|---|---|
| `getExposure()` | `exposure:get` | main.cjs:323 | `exposureAction(()=>{})` → `exposureState()` (main.cjs:319-321): per market `exposure.policy(account)`, `exposure.summary(...)`, and for Korea `exposure.creditRisk(...)` and `creditPaths` from `require('./credit-paths.cjs').pathStatus(k,{approved: automation.config.creditProtectionApproved===true})`; plus `exposure.overrides()` and `environment` |
| `saveExposurePolicy(market,value)` | `exposure:save-policy` | main.cjs:324 | throws `KIS_NOT_CONNECTED` without an account; throws `FEATURE_UNAVAILABLE` if `market==='US'` and the value has `margin` or `short`; else `exposure.savePolicy(account,value)` (electron/exposure.cjs:54-63) |
| `setProductOverride(symbol,factor)` | `exposure:set-override` | main.cjs:325 | `exposure.setOverride(symbol,factor)` (electron/exposure.cjs:47-51) |

  Every reply is `{ok, error?, state}`; a non-code error becomes `REQUEST_FAILED` (main.cjs:322).
- **Subscriptions**: none. The state is read once on mount and replaced by each reply (src/ShortLeverage.tsx:58,60). `MarketCard` resets its draft whenever the saved policy changes (src/ShortLeverage.tsx:28).
- **Saved state**: SQLite table `exposure_policy` (one row per account key; the U.S. account key is the Korean key + ":US", main.cjs:319) and table `product_overrides` (symbol → factor) (electron/exposure.cjs:34,50,62). Unsaved edits are component state and are lost on leaving the tab (src/ShortLeverage.tsx:28,57).
- **Notes**:
  - Error texts (src/ShortLeverage.tsx:16): `KIS_NOT_CONNECTED` → "Connect the KIS account first."; `INVALID_SETTINGS` → "Check the limits: percentages 1–100, days 1–365."; `INVALID_REQUEST` → "Enter a valid symbol and a non-zero multiple between −5 and 5."; `FEATURE_UNAVAILABLE` → "KIS does not offer margin or short selling for U.S. stocks."; any other code → "The change could not be saved." (src/ShortLeverage.tsx:60).
  - The engine's number check is `v>0` and `v<=100` (or `<=365` for keys ending "Days", `<=1000` for `minCollateralPct`) (electron/exposure.cjs:59). The on-screen minimums (1, 100, 0.1) are only shown as "Allowed min–max" hints by `NumberField` (src/SettingsUI.tsx:20-21); the engine accepts any value above 0. `maxHoldingDays` and `maxDays` end with "Days", so their engine maximum is 365 (electron/exposure.cjs:59).
  - `savePolicy` forces `auto=false` for any section that is not enabled (electron/exposure.cjs:61).
  - Policy errors thrown at order time by this module: `LEVERAGED_NOT_ENABLED`, `LEVERAGED_EXPOSURE_LIMIT` (electron/exposure.cjs:80,82), `MARGIN_NOT_ENABLED`, `MARGIN_LIMIT`, `SHORT_NOT_ENABLED`, `SHORT_LIMIT`, `INSUFFICIENT_CAPACITY`, `INVALID_ORDER` (electron/exposure.cjs:93-104). A buy of a product the security master cannot classify waits for approval (electron/exposure.cjs:78).
  - Credit warnings (shown here and as "Needs you" items, main.cjs:618), from `creditRisk` (electron/exposure.cjs:108-118): "Margin loan on <symbol> (<date>) matures in <n> days; repay or extend." (7 days or less); "Estimated collateral ratio <n>% is below your <floor>% floor; the broker may force a sale below its maintenance ratio."; "Short <symbol> is <n>% above its sale price, past your <stop>% stop; consider covering."; "Short <symbol> (<date>) must be repaid within <n> days.".
  - Product classification order: user override ("Your setting"), the known U.S. ticker list (`US_KNOWN`, 47 tickers such as TQQQ 3, SQQQ −3, SOXL 3, SVXY −0.5), the security master type (non-ETF/ETN = standard), then the product name (Korean "인버스" / "레버리지" with an optional "<n>X"; English "inverse", "bear", "ultrashort", "ultrapro", "<n>x") (electron/exposure.cjs:4,16-31,38-46).
  - KIS credit type codes per path and source are in `CREDIT_TYPES` (electron/exposure.cjs:10).
  - `creditPaths` depends on the automation config flag `creditProtectionApproved` (main.cjs:320); no control for it exists on this tab (src/ShortLeverage.tsx, whole file). Where it is set: not determined.

---

# 3. Settings table

Every user-facing setting found, grouped by where it is saved. Columns: screen and card; exact label; control type; the key written and which store holds it; default; allowed values; the module that enforces it.

Where settings live, in short:

| Store | Written through | Persisted in | Sub-section |
|---|---|---|---|
| Automation config | `configureRuntime` → `runtime:configure` → `Automation.configure` (`electron/automation.cjs`) | table `automation_settings` | 3.2 (Engine settings), 3.3 (News sources), part of 3.1 (provider sharing and limits) |
| Live policy, Korea and U.S. | `liveAction('configure')` / `usAction('configure')` → `live:configure` / `us:configure` → `LiveEngine.configure` (`electron/live-engine.cjs`) | table `live_policy`, per account | 3.4 |
| Paper limits | `configurePaperCaps`, `configurePaperLoss` → `paper:caps`, `paper:loss` (`electron/paper-engine.cjs`) | see 3.4 | 3.4 |
| Watchlist | `updateWatchlist` → `discovery:watch` | see 3.4 | 3.4 |
| Costs and tax profile | `saveCosts`, `saveTaxProfile` → `costs:save`, `costs:save-tax-profile` (`electron/trading-costs.cjs`, `electron/tax-profile.cjs`) | see 3.5 | 3.5 |
| Exposure policy and product overrides | `saveExposurePolicy`, `setProductOverride` → `exposure:save-policy`, `exposure:set-override` (`electron/exposure.cjs`) | see 3.5 | 3.5 |
| App-level settings | `setTheme`, `setSecContact`, `saveUpdateSettings`, `setLoginItem`, file imports | `settings` table, `app_update_settings` table, Windows login items | 3.1 |
| Cash-flow records (not settings, listed for completeness) | `addCashFlow` → `performance:add-flow` | `cash_flows` | 3.6 |

## 3.1 Shell, Connections and app-level settings

| Screen | Label on screen (exact) | Control type | Key written (store) | Default | Allowed values | Enforced by |
|---|---|---|---|---|---|---|
| Top bar | "Dark mode" (aria-label; icon "☾" / "☀") | switch button | `settings` row `theme` | `dark` (anything but `light` reads as dark) | `dark`, `light` | `electron/storage.cjs:14-15` `getTheme` / `setTheme`; main.cjs `'theme:set'` |
| Connections · KIS brokerage | "Credential file" / "Import credentials and connect" | file dialog | `settings` row `connection-file:kis` (absolute path only) | none | an absolute path, at most 32768 characters | `electron/remembered-files.cjs` `remember`; main.cjs:95-100 `connectKisFile` |
| Connections · Market calendar | "Live key for the calendar" / "Import live key" | file dialog | `settings` row `connection-file:calendar` | none | as above; must be a live key (`CALENDAR_NEEDS_LIVE_KEY` otherwise) | `electron/remembered-files.cjs`; main.cjs:90-94 `connectCalendarFile` |
| Connections · AI, news and alert keys | "Provider file" / "Import provider JSON" | file dialog | `settings` row `connection-file:providers`; also sets automation config `provider` to `openai` when the file has an AI key | none | as above | `electron/remembered-files.cjs`; main.cjs:78-82 `connectProviderFile` |
| Connections · OpenAI | "Share KIS data with OpenAI" | switch, applies at once | `shareKisWithOpenAI` (automation config) | `false` (see 3.2 "Data sharing" row) | boolean | `electron/automation.cjs` `configure` |
| Connections · Anthropic | "Share KIS data with Anthropic" | switch, applies at once | `shareKisWithAnthropic` (automation config) | `false` (see 3.2) | boolean | `electron/automation.cjs` `configure` |
| Connections · OpenAI | "Calls per day" + "No limit" | number + mini-switch; "Save limits" | `maxCallsPerDay`, `unlimitedCalls` (automation config) | `20`, `false` | UI range 1–200 (`src/ProviderCards.tsx` `Limit min={1} max={200}`); engine: integer 1–200 (3.2, "Daily AI budget" row) | `electron/automation.cjs` `configure` |
| Connections · OpenAI | "Spending per day" + "No limit" | money (USD) + mini-switch; "Save limits" | `maxUSDPerDay`, `unlimitedBudget` (automation config) | `1`, `false` | 0.01–100 USD (UI step 0.01; engine range per 3.2) | `electron/automation.cjs` `configure` |
| Connections · Anthropic | "Calls per day" + "No limit" | as above | `anthropicCallsPerDay`, `anthropicUnlimitedCalls` (automation config) | `10`, `false` | UI range 1–200 | `electron/automation.cjs` `configure` |
| Connections · Anthropic | "Spending per day" + "No limit" | as above | `anthropicUSDPerDay`, `anthropicUnlimitedBudget` (automation config) | `1`, `false` | UI range 0.01–100 USD | `electron/automation.cjs` `configure` |
| Connections · SEC EDGAR | "Contact email" | email input + "Save" / "Clear" | setting `sec-contact-email` | none (falls back to `secContactEmail` from the provider file) | must match `SEC_EMAIL` (main.cjs ≈696); empty clears | main.cjs `'sec:set'` |
| Connections · App updates | "Check for updates every 6 hours" | checkbox, applies at once | `checkAutomatically` (table `app_update_settings`) | `true` | boolean only; any other key is refused with `INVALID_SETTINGS` | `electron/app-updates.cjs` `saveSettings`, `tick` (`CHECK_EVERY_MS` = 6 h) |
| Engine settings · Trading | "Start with Windows" | switch, applies at once | none in the app: the Windows login item for this exe | Windows' own state | boolean; installed app only | `electron/login-item.cjs` `createLoginItem` |

Defaults for the provider sharing and limit keys are taken from the Engine settings rows in 3.2 ("Data sharing" and "Daily AI budget"), which cite `DEFAULTS` in `electron/automation.cjs:15`.

## 3.2 Engine settings (automation config)

All keys below are in the automation config (`automation.config`, table `automation_settings`, electron/automation.cjs:171) and are written through `configureRuntime` → `runtime:configure` (electron/main.cjs:724) → `Automation.configure` (electron/automation.cjs:172), unless the row says otherwise. Defaults are from `DEFAULTS` (electron/automation.cjs:15), `COND_DEFAULTS` (electron/agent-desk.cjs:5), `AGENT_DEFAULTS` (electron/agent-models.cjs:13) and `TIMING_DEFAULTS` (electron/scout-timing.cjs:21). A saved profile is merged over the defaults at start (electron/automation.cjs:123). "configure:NNN" means the validation line in electron/automation.cjs.

| Screen | Label on screen (exact) | Control type | Config key written | Default | Allowed range/values | Enforced by |
|---|---|---|---|---|---|---|
| Engine · Trading · Agent guidelines | "Agent guidelines" | textarea (maxLength 6000) | `guidelines` | `''` | string, at most 6000 characters | automation.cjs configure:177 |
| Engine · Trading · Trading | "Portfolio" | select | `scope` | `'paper'` | `paper`, `kis`, `us`, `both` | automation.cjs configure:180 |
| Engine · Trading · Trading | "Decision maker" | select | `provider` | `'local'` | `local`, `openai`, `external` (UI disables `local` unless scope is paper; the engine's `configure` does not, and `start` refuses non-`openai` for a broker scope, auto-launch.cjs:16) | automation.cjs configure:177; auto-launch.cjs `start` :14-16 |
| Engine · Trading · Trading | "Scheduled reviews" | switch | `enabled` | `false` | boolean (off disarms the session; on never arms it, Start does) | automation.cjs configure:179 |
| Engine · Trading · Trading | "Place orders automatically" | switch | `autoSubmit` | `false` | boolean | automation.cjs configure:179 |
| Engine · Trading · Trading | "Risk per trade" | number, % | `sizingRiskPct` | `1` | 0.1–20 (finite number) | automation.cjs configure:202 |
| Engine · Trading · Trading | "Stop distance" | number, × ATR | `sizingAtrMultiple` | `2` | 0.5–5 (finite number) | automation.cjs configure:202 |
| Engine · Trading · Trading | "Data sharing" | read-only text + link "Open Connections" | shows `shareKisWithOpenAI`, `shareKisWithAnthropic` (set in Connections) | `false`, `false` | boolean | automation.cjs configure:180 |
| Engine · Trading · Trading | "Start with Windows" | switch, applies at once | none: Windows login item (other: OS setting) | Windows' state | boolean; only in the installed app | electron/login-item.cjs `createLoginItem` set :37 |
| Engine · Trading · Extended hours | "Korea · Nextrade (NXT)" | switch | `sessionKrNxt` | `false` | boolean | automation.cjs configure:197 |
| Engine · Trading · Extended hours | "U.S. · KIS daytime session" | switch | `sessionUsDaytime` | `false` | boolean | automation.cjs configure:197 |
| Engine · Trading · Extended hours | "U.S. · Pre-market" | switch | `sessionUsPre` | `false` | boolean | automation.cjs configure:197 |
| Engine · Trading · Extended hours | "U.S. · After-market" | switch | `sessionUsAfter` | `false` | boolean | automation.cjs configure:197 |
| Engine · Trading · Extended hours | "Largest extended-session order" | number, % | `extendedMaxOrderPct` | `5` | 0.5–50 | automation.cjs configure:197 |
| Engine · Trading · Guardrails | "When a daily loss limit is hit" | select | `lossAction` | `'review'` | `review`, `block-buys`, `stop` | guardrails.cjs `validateGuardrails` :5 (`LOSS_ACTIONS` :3) |
| Engine · Trading · Guardrails | "Automatic orders per day" (+ "No limit") | number + switch | `maxAutoOrdersPerDay` (0 = no limit) | `0` | integer 0–100 (UI: 1–100, or 0 by the switch; switching the limit on starts at 10) | guardrails.cjs `validateGuardrails` :5 |
| Engine · Trading · Guardrails | "Stop after failed reviews in a row" (+ "Never stop") | number + switch | `maxConsecutiveFailures` (0 = never) | `0` | integer 0–20 (UI: 1–20, or 0; switching on starts at 3) | guardrails.cjs `validateGuardrails` :5 |
| Engine · Trading · Order execution | "Follow the best price" | switch | `orderTracking` | `true` | boolean | automation.cjs configure:182 |
| Engine · Trading · Order execution | "Several open orders" | switch with inline confirmation ("Turn on" / "Cancel") | `severalOpenOrders` | `false` | boolean | automation.cjs configure:201 |
| Engine · Trading · Order execution | "Orders per review" | number | `ordersPerReview` | `1` | integer 1–22 (`ORDERS_PER_REVIEW_MAX`, automation.cjs:13); the used value is capped by the model's ceiling and the review universe | automation.cjs configure:201; `orderLimits` :1068; ai-models.cjs `orderCeiling` :54 |
| Engine · Trading · Conditional orders | "Let the AI set conditional orders" | switch | `conditionalOrders` | `false` | boolean | automation.cjs configure:203 |
| Engine · Trading · Conditional orders | "Submit them automatically" | switch | `conditionalAutoSubmit` | `false` | boolean | automation.cjs configure:203 |
| Engine · Trading · Conditional orders | "Let stops trail" | switch | `trailingStops` | `false` | boolean | automation.cjs configure:203 (side effects :206-209) |
| Engine · Trading · Conditional orders | "Armed at once" | number | `conditionalMaxActive` | `5` | integer 1–10 | automation.cjs configure:203 |
| Engine · Trading · Conditional orders | "Largest order" | number, % | `conditionalMaxOrderPct` | `10` | 1–50 | automation.cjs configure:203 |
| Engine · Trading · Conditional orders | "Price drift allowed" | number, % | `conditionalMaxSlippagePct` | `2` | 0.1–10 | automation.cjs configure:203 |
| Engine · Trading · Conditional orders | "Longest life" | number, h | `conditionalMaxHours` | `168` | 1–336 (finite number) | automation.cjs configure:203 |
| Engine · Agents · Trading review | "Model" | select | `openaiModel` | `'gpt-6-luna'` | `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `claude-opus-5-5` (Claude only under the trading-on-Claude conditions) | ai-models.cjs `settings` :30, `assertTradingModel` :28; automation.cjs `claudeTradingRefusal` :990 |
| Engine · Agents · Trading review | "Reasoning effort" | select | `reasoningEffort` | `'none'` | OpenAI: `none`, `low`, `medium`, `high` (not `none` with GPT-6 Astra); Claude: `low`, `medium`, `high` | ai-models.cjs `settings` :30 (`EFFORTS` :16) |
| Engine · Agents · AI scout | "Model" | select | `scoutModel` | `'same'` | `same`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, `claude-opus-5-5` (Claude only after a completed Claude dry run on the account) | agent-models.cjs `validate` :31-45 |
| Engine · Agents · AI scout | "Effort" | select | `scoutEffort` | `'same'` | `same`, `low`, `medium`, `high` (`none` refused) | agent-models.cjs `validate` :36-38 |
| Engine · Agents · Market narrative | "Scheduled narrative" | switch | `narrativeEnabled` | `true` | boolean | automation.cjs configure:202 |
| Engine · Agents · Market narrative | "Model" | select | `narrativeModel` | `'same'` | as scout | agent-models.cjs `validate` |
| Engine · Agents · Market narrative | "Effort" | select | `narrativeEffort` | `'same'` | `same`, `low`, `medium`, `high` (`none` refused) | agent-models.cjs `validate` :37 |
| Engine · Agents · Context compacting | "Model" | select | `routineModel` | `'gpt-6-luna'` | `same`, the three GPT models, `claude-opus-5-5`, `claude-haiku-5-5` (Haiku only here) | agent-models.cjs `validate` :40, :44 |
| Engine · Agents · Context compacting | "Effort" | select | `routineEffort` | `'none'` | `same`, `none`, `low`, `medium`, `high` (not `none` with Astra or Claude) | agent-models.cjs `validate`; ai-models.cjs `settings` |
| Engine · Agents · Reflection | "Post-trade reflection" | switch | `reflectionEnabled` | `false` | boolean | automation.cjs configure:179 |
| Engine · Agents · Reflection | "Model" | select | `reflectionModel` | `'same'` | as scout | agent-models.cjs `validate` |
| Engine · Agents · Reflection | "Effort" | select | `reflectionEffort` | `'same'` | `same`, `none`, `low`, `medium`, `high` (not `none` with Astra or Claude) | agent-models.cjs `validate`; ai-models.cjs `settings` |
| Engine · Agents · Reflection | "Reflection calls" (+ "No limit") | number + switch | `reflectionCallsPerDay`, `reflectionUnlimitedCalls` | `5`, `false` | integer 1–200; boolean | automation.cjs configure:178, :179 |
| Engine · Agents · Reflection | "Reflection spending" (+ "No limit") | money field (USD) + switch | `reflectionUSDPerDay`, `reflectionUnlimitedBudget` | `1`, `false` | 0.01–100; boolean | automation.cjs configure:178, :179 |
| Engine · Agents · Daily AI budget | "OpenAI", "Anthropic" (usage lines) | read-only | shows `maxCallsPerDay`, `maxUSDPerDay`, `unlimitedCalls`, `unlimitedBudget`, `anthropicCallsPerDay`, `anthropicUSDPerDay`, `anthropicUnlimitedCalls`, `anthropicUnlimitedBudget` (set in Connections) | `20`, `1`, `false`, `false`, `10`, `1`, `false`, `false` | calls: integer 1–200; USD: 0.01–100; booleans | automation.cjs configure:177, :179, :181 |
| Engine · Schedule · Schedule | "Let the AI choose the interval" | switch | `autoReviewInterval` | `false` | boolean | automation.cjs configure:179 |
| Engine · Schedule · Schedule | "Review interval (minutes)" / "Initial review interval (minutes)" | number, min | `intervalMinutes` | `10` | integer 1–1440 | automation.cjs configure:177 |
| Engine · Schedule · Schedule | "When markets are closed" | select | `closedMarketReviews` | `'pre-open'` | `pre-open`, `off`, `keep` | automation.cjs configure:197 |
| Engine · Schedule · Schedule | "Holdings: price move trigger" | number, % | `eventTolerancePct` | `3` | 0.1–50 | automation.cjs configure:177 |
| Engine · Schedule · Schedule | "Stocks you don’t hold" | select (one choice over two keys) | `notHeldPriceReviews` and `watchlistAlerts` (mapping in src/price-review-rows.ts:21-25) | `'default'` and `'observe'` (shown as "Same as holdings") | `notHeldPriceReviews`: `default`, `levels`, `never`; `watchlistAlerts`: `off`, `observe`, `on` | automation.cjs configure:182; not-held.cjs `CHOICES` :7 |
| Engine · Schedule · Schedule | "Wider move" | number, % | `watchlistMovePct` | `null` (shown as 2 × the holdings trigger) | `null` or 0.1–50 | automation.cjs configure:182 |
| Engine · Schedule · Schedule (More) | "Observe watchlist alerts" | switch | `watchlistAlerts` (`observe` / `off`) | `'observe'` | `off`, `observe`, `on` | automation.cjs configure:182 |
| Engine · Schedule · Schedule (More) | "Watchlist alert trial" | select Off/On | `alertTrial` | `'off'` | `off`, `on`; `on` only with `notHeldPriceReviews:'default'`, `watchlistAlerts:'observe'`, scope not `paper`, and no scope change while on | automation.cjs configure:182 (start/end :210-211) |
| Engine · Schedule · Schedule | "Review after an order update" | switch | `orderUpdateReviews` | `false` | boolean | automation.cjs configure:179 |
| Engine · Schedule · AI scout runs | "Scheduled scout runs" | switch | `scoutEnabled` | `false` | boolean | automation.cjs configure:198 |
| Engine · Schedule · AI scout runs | "Reviews can ask for a scout run" | switch | `scoutAiRequests` | `true` | boolean | automation.cjs configure:198 |
| Engine · Schedule · AI scout runs | "Before Korea opens" | switch | `scoutBeforeKrOpen` | `false` | boolean | scout-timing.cjs `validate` :44 |
| Engine · Schedule · AI scout runs | "After Korea opens" | switch | `scoutAfterKrOpen` | `true` | boolean | scout-timing.cjs `validate` :44 |
| Engine · Schedule · AI scout runs | "Korea midday" | switch | `scoutKrMidday` | `true` | boolean | scout-timing.cjs `validate` :44 |
| Engine · Schedule · AI scout runs | "Before the U.S. opens" | switch | `scoutBeforeUsOpen` | `false` | boolean | scout-timing.cjs `validate` :44 |
| Engine · Schedule · AI scout runs (More) | "After Korea opens: minutes after the open" | number, min | `scoutAfterOpenMinutes` | `60` | integer 10–240 (`OFFSET`, scout-timing.cjs:25) | scout-timing.cjs `validate` :45 |
| Engine · Schedule · Token saving | "Skip unchanged reviews" | switch | `skipUnchanged` | `true` | boolean | automation.cjs configure:197 |
| Engine · Schedule · Token saving | "Review gate" | select | `reviewGate` | `'observe'` | `off`, `observe`, `on` | automation.cjs configure:182 |
| Engine · Schedule · Token saving | "Skip research known to be unavailable" | select Off/On | `researchSuppression` | `'off'` | `off`, `on` | automation.cjs configure:182 |
| Engine · Schedule · Token saving | "Routine review scope" | select | `routineReviews` | `'full'` | `full`, `focused` | automation.cjs configure:182 |
| Engine · Schedule · Token saving | "Longest stretch of skips" | number, min | `maxSkipMinutes` | `120` | integer 15–720 | automation.cjs configure:197 |
| Engine · Schedule · Token saving | "Slow down near the budget" | switch | `degradeNearBudget` | `true` | boolean | automation.cjs configure:197 |
| Engine · Alerts · Alerts | "Desktop alerts" | switch | `desktopAlerts` | `false` | boolean | automation.cjs configure:179 |
| Engine · Alerts · Alerts | "Phone alerts" | switch | `mobileAlerts` | `false` | boolean | automation.cjs configure:179 |
| Engine · Alerts · Alerts | "Snapshot on each trade" | switch | `phoneSnapshots` | `true` | boolean | automation.cjs configure:179 |
| Engine · Alerts · Alerts | "Show amounts" | switch | `phoneAmounts` | `true` | boolean | automation.cjs configure:179 |
| Engine · Alerts · Alerts | "Daily digest" | switch | `digestEnabled` | `false` | boolean | guardrails.cjs `validateGuardrails` :5 |
| Engine · Alerts · Alerts | "Digest time" | select (24 hours, KST) | `digestHour` | `16` | integer 0–23 | guardrails.cjs `validateGuardrails` :5 |

Not a saved setting but related: the save-only flag `claudeTradingConfirmed` (true only after "Trade with Claude"; never stored, automation.cjs:174, :196); the session-only background AI pause (automation.cjs:342); the session-only open tab (`engine:tab`).

Automation config keys in `DEFAULTS` that have no control on this tab (electron/automation.cjs:15): `creditProtectionApproved` (false), `newsURL` (''), `newsTrigger` ('disclosures'; values `off`, `disclosures`, `all`, electron/news-events.cjs:5), `newsFeeds` ([]), `kisNews` (true), `usTickerNews` (true), and the provider consent and limit keys shown read-only above. `newsURL` and `newsTrigger` are saved by the News mode of the same component (src/RuntimeSettings.tsx:49).

## 3.3 News sources (automation config)

| Screen | Label on screen (exact) | Control type | Config key written (and which config) | Default | Allowed range/values | Enforced by (module file + identifier) |
|---|---|---|---|---|---|---|
| News > Sources and review triggers | "News-triggered reviews" | select: "Off", "Important disclosures for my symbols", "Any news about my symbols" (src/NewsView.tsx:5, :19) | `newsTrigger` (automation config), saved by "Save news settings" (src/RuntimeSettings.tsx:49) | `'disclosures'` (electron/automation.cjs:15) | `off`, `disclosures`, `all` (electron/news-events.cjs:5 `MODES`) | electron/automation.cjs:183 (`MODES.includes(next.newsTrigger)`, else `INVALID_SETTINGS`); used at electron/automation.cjs:1992 and main.cjs:242 |
| News > Manage sources | "Public RSS / Atom feed" | url input (src/NewsView.tsx:21) | `newsURL` (automation config), saved by "Save news settings" (src/RuntimeSettings.tsx:49) | `''` (electron/automation.cjs:15) | a string of at most 1000 characters (electron/automation.cjs:177); fetched only if https, no credentials, not a local/private host (electron/news.cjs:17) | electron/automation.cjs:177 (configure validation); electron/news.cjs:17 `fetchFeed` |
| News > Manage sources | "Feeds · n/10" (list, "Add feed", "Remove", suggested links, "Add all") | list editor, saved at once (src/NewsSources.tsx:11-18) | `newsFeeds` (automation config): array of `{url,label?}` | `[]` (electron/automation.cjs:15) | at most 10 entries; each `url` a string starting `https://`, at most 500 characters; `label` a string of at most 60 characters (electron/automation.cjs:202). The window also requires `^https://\S+$` and blocks an 11th feed (src/NewsSources.tsx:12, :17) | electron/automation.cjs:202 (configure validation); electron/news.cjs:17 `fetchFeed` |
| News > Manage sources | "KIS market headlines, tagged with stock codes" (switch label "KIS market headlines") | switch, saved at once (src/NewsSources.tsx:19) | `kisNews` (automation config) | `true` (electron/automation.cjs:15) | boolean (electron/automation.cjs:202) | electron/automation.cjs:202; used at main.cjs:116 and main.cjs:242 |
| News > Manage sources | "Headlines for U.S. stocks you hold or watch (up to 5)" (switch label "U.S. ticker headlines") | switch, saved at once (src/NewsSources.tsx:20) | `usTickerNews` (automation config) | `true` (electron/automation.cjs:15) | boolean (electron/automation.cjs:202) | electron/automation.cjs:202; used at main.cjs:115 |
| Journal > Lessons (per lesson) | "Review again in" | select: 7, 30, 90, 180, 365 days (src/LearningPanel.tsx:15) | not a config key: `days` in the lesson review, stored as `expiresAt` in the lesson lifecycle (other: learning memory) (electron/learning-memory.cjs:84) | window: 90 for an approved lesson, else `reviewDays` or 30 (src/LearningPanel.tsx:13); engine fallback 90 (electron/learning-memory.cjs:79) | integer 1 to 365 (electron/learning-memory.cjs:80) | electron/learning-memory.cjs:75 `review` |
| Journal > Lessons (per lesson) | "Reviewed lesson" / "When to apply" | textareas (src/LearningPanel.tsx:15) | not a config key: `note`, `applicability` in the lesson lifecycle (other: learning memory) | the lifecycle's current values (src/LearningPanel.tsx:13) | note at most 2000 characters; applicability non-empty, at most 1000 (electron/learning-memory.cjs:80) | electron/learning-memory.cjs:75 `review` |

No other control on these screens writes a saved setting: the Journal and Console filters are session drafts, and the Replay and experiment forms are parameters of one-off actions (src/JournalView.tsx:43; src/AiConsole.tsx:61; src/ReplayPanel.tsx:29; src/LessonTrials.tsx:8).

## 3.4 Trading tabs, Paper, Discover (live policy, U.S. policy, paper limits, watchlist)

| Screen | Label on screen (exact) | Control type | Config key written (and which config) | Default | Allowed range/values | Enforced by (module file + identifier) |
|---|---|---|---|---|---|---|
| KIS trading | "Stocks the AI may trade" | text input, comma-separated | `symbols` (and derived `anyStock`) — live policy (`live_policy` row of the KR account) | no saved policy until first activation; form starts blank; blank = `anyStock:true` (LE:45) | up to 20 six-digit codes | renderer LT:24; `electron/live-engine.cjs` `configure` (LE:35), `validSymbol` (LE:13); used by `propose` (LE:116) and `send` (LE:148) |
| KIS trading | "Emergency loss trigger" | select: "Off" / "KRW amount" / "Percent" | `lossLimit.mode` — live policy | form default "off" (LT:17); engine default when absent `{mode:'off',value:0}` (LE:37) | off, amount, percent | `electron/loss-policy.cjs` `validateLoss` |
| KIS trading | "Trigger at (KRW)" / "Trigger at (%)" | MoneyField / number input | `lossLimit.value` (derived `maxDailyLossKRW`) — live policy | blank | amount: whole number 1–1,000,000,000; percent: >0 to 100 | renderer LT:25; `electron/loss-policy.cjs` `validateLoss`; amount derived at LE:45 |
| KIS trading | "Maximum order (KRW)" | MoneyField (in "Caps · optional") | `maxOrderKRW` — live policy | null (no cap) | blank, or whole number 1–1,000,000,000 | renderer LT:25; `electron/optional-caps.cjs` `optionalCaps`; applied in `propose` (LE:117, `ORDER_SIZE_LIMIT`) and `send` (LE:148) |
| KIS trading | "Daily turnover (KRW)" | MoneyField | `maxDailyTurnoverKRW` — live policy | null | blank, or whole number 1–1,000,000,000 | `optionalCaps`; applied in `send` (LE:150, `DAILY_TURNOVER_LIMIT`) |
| KIS trading | "Maximum company allocation (%)" | number input | `maxCompanyPct` — live policy | null | blank, or >0 to 100 | `optionalCaps`; applied in `send` (LE:198, `CONCENTRATION_LIMIT`) |
| KIS trading | "Enable trading for this LIVE/MOCK account" + "Activate for this session" | switch + button | engine flag `enabled` (memory only, not saved); the switch itself is a renderer draft `<draftKey>:consent` | off at every app start (LE:14) | on/off; needs phrase `ENABLE LIVE`/`ENABLE MOCK` | `LiveEngine.configure` (LE:33, LE:47); off via `stop` (LE:65) |
| KIS trading | "Allow automatic LIVE/MOCK orders" + "Enable automatic execution" / "Stop automatic execution" | switch + button | engine flag `autoEnabled` (memory only, not saved) | off at every app start (LE:14) | on/off; needs phrase `ENABLE AUTO LIVE`/`ENABLE AUTO MOCK` and an enabled session | `LiveEngine.enableAuto` (LE:66); off at main:712; checked by `autoSubmit` (LE:569, `AUTO_KIS_DISABLED`) |
| U.S. stocks | "Stocks the AI may trade" | text input | `symbols` / `anyStock` — US policy (`live_policy` row of the `<accountKey>:US` account, main:266) | as KR | up to 20 symbols `NASD:`/`NYSE:`/`AMEX:` + ticker | renderer LT:24; LE:13, LE:35 |
| U.S. stocks | "Emergency loss trigger" | select: "Off" / "USD amount" / "Percent" | `lossLimit.mode` — US policy | "off" | off, amount, percent | `validateLoss` |
| U.S. stocks | "Trigger at (USD)" / "Trigger at (%)" | MoneyField / number input | `lossLimit.value` (derived `maxDailyLossKRW`, in USD) — US policy | blank | whole number 1–1,000,000,000; percent >0 to 100 | renderer LT:25; `validateLoss`; LE:45 |
| U.S. stocks | "Maximum order (USD)" | MoneyField | `maxOrderKRW` (USD value) — US policy | null | blank, or whole number 1–1,000,000,000 | `optionalCaps`; LE:117, LE:148 |
| U.S. stocks | "Daily turnover (USD)" | MoneyField | `maxDailyTurnoverKRW` (USD value) — US policy | null | blank, or whole number 1–1,000,000,000 | `optionalCaps`; LE:150 |
| U.S. stocks | "Maximum company allocation (%)" | number input | `maxCompanyPct` — US policy | null | blank, or >0 to 100 | `optionalCaps`; LE:198 |
| U.S. stocks | "Enable trading for this LIVE/MOCK account" + "Activate for this session" | switch + button | `usLive.enabled` (memory only) | off at start | as KR | `LiveEngine.configure` on `usLive` (main:336) |
| U.S. stocks | "Allow automatic LIVE/MOCK orders: buys and sales the AI decides are sent without asking you" + "Enable automatic execution" | switch + button | `usLive.autoEnabled` (memory only); covers U.S. buys and sales | off at start | as KR | `LiveEngine.enableAuto` (main:336) |
| Paper trading | "Simulation running" (switch; text "Simulation paused"/"Simulation running") | switch | `account.paused` — paper (`paper_account`) | paused at first run and at every app start (`electron/paper-engine.cjs:16-17`) | boolean | `electron/paper-engine.cjs` `setPaused` (:86) |
| Paper trading | "Maximum order (KRW)" | MoneyField (in "Optional execution caps") | `maxOrderKRW` — paper (`paper_caps`) | null (no cap) when nothing saved (:22) | blank, or whole number 1–1,000,000,000 | `electron/paper-engine.cjs` `configureCaps` (:23) → `optionalCaps`; applied in `check` (:52) |
| Paper trading | "Daily turnover (KRW)" | MoneyField | `maxDailyTurnoverKRW` — paper (`paper_caps`) | null | blank, or whole number 1–1,000,000,000 | `configureCaps`; `check` (:54) |
| Paper trading | "Maximum company allocation (%)" | number input | `maxCompanyPct` — paper (`paper_caps`) | null | blank, or >0 to 100 | `configureCaps`; `check` (:58) |
| Paper trading | "Limit unit" | select: "Not set" / "KRW amount" / "Percentage" | `mode` — paper (`paper_loss_policy`) | `off` (:21) | off, amount, percent | `electron/paper-engine.cjs` `configureLoss` (:24) → `validateLoss` |
| Paper trading | "Maximum daily loss" | MoneyField / number input | `value` — paper (`paper_loss_policy`) | 0 (off); the form presets 500000 for amount and 5 for percent (`src/PaperTrading.tsx:75`) | amount: whole number 1–1,000,000,000; percent: >0 to 100 | `validateLoss` (`electron/loss-policy.cjs:1`) |
| Discover | Watchlist "Add" / "Remove" | buttons | watchlist entry — other (`watchlist` table, scope = KIS accountKey) | empty | at most 30 entries; symbol must be in the symbol list | `electron/discovery.cjs` `Watchlist.add` (:13-20), `remove` (:22) |
| Discover | Watchlist "Pin" / "Unpin" (AI entries) | button | `pinned` on the entry — other (`watchlist` table) | AI entries unpinned; user entries pinned (:20) | boolean | `electron/discovery.cjs` `Watchlist.pin` (:23) |
| Discover | Driver "Hide" / "Show" (What's driving the market) | button | hidden flag of a narrative driver — other (narrative store) | shown | boolean | main:402 `automation.narratives.hide` (store module not read) |
| Macro | (no settings) | | | | | |

Not saved (renderer drafts only, so not settings): Discover market tab, search market, screener Market / Exchange / Ranking / Security type (D:26-29); Paper ticket fields and activity tab (`src/PaperTrading.tsx:23`); the order ticket on the trading tabs (LT:19).

## 3.5 Fees & taxes, Short & leverage, Home, Holdings (costs, tax profile, exposure policy)

| Screen | Label on screen (exact) | Control type | Config key written (and which config) | Default | Allowed range/values | Enforced by (module file + identifier) |
|---|---|---|---|---|---|---|
| Fees & taxes | "Korea commission" | number, unit % | `krCommissionPct` (costs) | 0.015 (electron/trading-costs.cjs:5) | 0–100 (UI min 0, max 100, step 0.00001) | electron/trading-costs.cjs `validateCosts` (line 11); used by `estimateCosts` (line 33) |
| Fees & taxes | "U.S. commission" | number, unit % | `usCommissionPct` (costs) | 0.25 | 0–100 | electron/trading-costs.cjs `validateCosts` (line 11) |
| Fees & taxes | "U.S. sale levy" | number, unit % | `usSellFeePct` (costs) | 0.00206 | 0–100 | electron/trading-costs.cjs `validateCosts` (line 11) |
| Fees & taxes | "U.S. minimum sale levy" | number, unit USD | `usSellFeeMinimum` (costs) | 0.01 | 0–100 | electron/trading-costs.cjs `validateCosts` (line 11) |
| Fees & taxes | "Korea sale tax" (input aria-label "Korea sale tax override") | number, unit %, blank = statutory | `krSellTaxOverridePct` (costs) | null (statutory rules from electron/tax-rules.cjs) | null or 0–100 | electron/trading-costs.cjs `validateCosts` (line 12); statutory rates in `krSaleTaxes` (line 26) |
| Fees & taxes | "Tax year" | number | `taxYear` (costs) | the current calendar year (`new Date().getFullYear()`) | integer 2023–2100 | electron/trading-costs.cjs `validateCosts` (line 14) |
| Fees & taxes | "Gains realized at other brokers" | MoneyField KRW, blank = unknown | `annualRealizedKRW` (costs) | null | null or a finite number with absolute value ≤ 1e13 (the field itself accepts only non-negative whole won, src/money.ts:17-20) | electron/trading-costs.cjs `validateCosts` (line 13) |
| Fees & taxes | "Cost method" | select | `taxMethod` (costs) | 'moving-average' | 'moving-average', 'fifo' | electron/trading-costs.cjs `validateCosts` (line 16) |
| Fees & taxes | "USD → KRW settlement rate" | number, unit KRW, blank = unknown | `usdKRW` (costs) | null | null or > 0 and ≤ 1e13 | electron/trading-costs.cjs `validateCosts` (line 13); also read by `automation.fx` as the fallback rate (main.cjs:299) |
| Fees & taxes | "Acquisition cost" | symbol text + MoneyField KRW + "Set"/"Remove" | `taxBasisKRW[symbol]` (costs) | {} | keys `NASD|NYSE|AMEX:TICKER`, at most 100 entries, values 0–1e13 | electron/trading-costs.cjs `validateCosts` (lines 14-15) |
| Fees & taxes | "Tax residency" | select (saves at once) | `residency` (tax profile) | null ("Not confirmed") | null, 'resident', 'non-resident' | electron/tax-profile.cjs `validateProfile` (line 10); effect in `applicability` (line 19) |
| Fees & taxes | "Lived in Korea 5 of the last 10 years" | select (saves at once) | `longTermResident` (tax profile) | null | null, true, false | electron/tax-profile.cjs `validateProfile` (line 10); `applicability` (line 33) |
| Fees & taxes | "Major shareholder of a Korean listed company" | select (saves at once) | `majorShareholder` (tax profile) | null | null, true, false | electron/tax-profile.cjs `validateProfile` (line 10); `applicability` (line 34) |
| Fees & taxes | "This account" (live account only) | select (saves at once) | `accounts[<accountKey>] = {type, linked:true}` (tax profile) | no entry | 'ordinary', 'isa', 'pension', 'corporate', 'ria', 'other'; at most 20 accounts | electron/tax-profile.cjs `validateProfile` (lines 11-12), `ACCOUNT_TYPES` (line 5); `taxpayerAccounts` (line 40) |
| Fees & taxes | "Opening lots" (form: stock, shares, date, KRW cost, "incl. fees") | form + "Add"/"Remove" | rows in table `tax_opening_lots` (other: tax ledger records) | none | symbol `NASD|NYSE|AMEX:TICKER`; integer quantity 1–10,000,000; date not after today; cost 0–1e13; boolean | electron/trading-costs.cjs `addOpeningLot` (line 229) |
| Fees & taxes | "Interest and dividends received elsewhere in <year> (KRW)" (field "Financial income elsewhere") | MoneyField KRW, saves on blur | `income_declarations[year].externalKRW` (other: income records) | not declared (null) | null or 0–1e13 | electron/income-events.cjs `declare` (line 37) |
| Fees & taxes | "Korean ETF tax class" (code + class) | text + select + "Set"/"Remove" | rows in table `fund_tax_class` (other: tax classification) | none | code: one digit then five digits/capitals; class 'domestic-equity' or 'taxable' | electron/trading-costs.cjs `setFundClass` (lines 118-119) |
| Fees & taxes | "Record a payment" (income form) | form + "Add"/"Remove" | rows in table `income_events` (other: income records; a record, not a behaviour switch) | none | category dividend / fund-distribution / interest; currency KRW/USD; amounts null or 0–<1e13; gross or net required | electron/income-events.cjs `validate` (lines 9-15) |
| Short & leverage | "Allow leveraged and inverse ETFs" (Korea and U.S. cards) | switch | `leveragedEtps.enabled` (exposure policy, per account) | false (electron/exposure.cjs:9) | boolean | electron/exposure.cjs `savePolicy` (line 59), `check` (line 80), `leveragedAccess` (line 13) |
| Short & leverage | "My KIS account can buy these products" | select | `leveragedEtps.brokerEligible` (exposure policy) | null ("Not confirmed") | true, false, null | electron/exposure.cjs `savePolicy` (line 59), `leveragedAccess` (lines 13-14) |
| Short & leverage | "Submit automatically" (leveraged) | switch | `leveragedEtps.auto` (exposure policy) | false | boolean; forced false when not enabled | electron/exposure.cjs `savePolicy` (lines 59,61), `check` (line 83) |
| Short & leverage | "Max share of account" (%) | number | `leveragedEtps.maxPctOfEquity` (exposure policy) | 20 | UI 1–100; engine > 0 and ≤ 100 | electron/exposure.cjs `savePolicy` (line 59), `check` (line 82, `LEVERAGED_EXPOSURE_LIMIT`) |
| Short & leverage | "Warn after holding" (days) | number | `leveragedEtps.maxHoldingDays` (exposure policy) | 10 | UI 1–365; engine > 0 and ≤ 365 | electron/exposure.cjs `savePolicy` (line 59), `context` warnings (line 123) |
| Short & leverage | "Allow margin buying" (Korea only) | switch | `margin.enabled` (exposure policy) | false | boolean; refused for the U.S. (`FEATURE_UNAVAILABLE`, main.cjs:324) | electron/exposure.cjs `savePolicy` (line 59), `checkCredit` (line 97, `MARGIN_NOT_ENABLED`); path gate electron/credit-paths.cjs `pathStatus` |
| Short & leverage | "Submit automatically" (margin) | switch | `margin.auto` (exposure policy) | false | boolean | electron/exposure.cjs `savePolicy` (lines 59,61), `checkCredit` (line 100); openings are never automatic per electron/credit-paths.cjs `pathStatus` (lines 57-58) |
| Short & leverage | "Max loans" (% of net assets) | number | `margin.maxLoanPctOfEquity` (exposure policy) | 30 | UI 1–100; engine > 0 and ≤ 100 | electron/exposure.cjs `savePolicy` (line 59), `checkCredit` (line 98, `MARGIN_LIMIT`) |
| Short & leverage | "Warn below collateral ratio" (%) | number | `margin.minCollateralPct` (exposure policy) | 140 | UI 100–1000; engine > 0 and ≤ 1000 | electron/exposure.cjs `savePolicy` (line 59), `creditRisk` (line 113) |
| Short & leverage | "Loan source" | select | `margin.source` (exposure policy) | 'self' | 'self' ("KIS own (자기)"), 'distribution' ("KSFC distribution (유통)") | electron/exposure.cjs `savePolicy` (line 59), `CREDIT_TYPES` (line 10), `checkCredit` (line 100) |
| Short & leverage | "Annual loan interest" (%) | number | `margin.interestPct` (exposure policy) | 9 | UI 0.1–30; engine > 0 and ≤ 100 | electron/exposure.cjs `savePolicy` (line 59), `creditRisk` estimate (line 111) |
| Short & leverage | "Allow short selling" (Korea only) | switch | `short.enabled` (exposure policy) | false | boolean; refused for the U.S. | electron/exposure.cjs `savePolicy` (line 59), `checkCredit` (line 102, `SHORT_NOT_ENABLED`); path gate electron/credit-paths.cjs `pathStatus` |
| Short & leverage | "Submit automatically" (short) | switch | `short.auto` (exposure policy) | false | boolean | electron/exposure.cjs `savePolicy` (lines 59,61), `checkCredit` (line 105) |
| Short & leverage | "Max short positions" (% of net assets) | number | `short.maxGrossPctOfEquity` (exposure policy) | 20 | UI 1–100; engine > 0 and ≤ 100 | electron/exposure.cjs `savePolicy` (line 59), `checkCredit` (line 104, `SHORT_LIMIT`) |
| Short & leverage | "Stop warning at adverse move" (%) | number | `short.stopLossPct` (exposure policy) | 15 | UI 1–100; engine > 0 and ≤ 100 | electron/exposure.cjs `savePolicy` (line 59), `creditRisk` (line 115) |
| Short & leverage | "Repay within" (days) | number | `short.maxDays` (exposure policy) | 90 | UI 1–365; engine > 0 and ≤ 365 | electron/exposure.cjs `savePolicy` (line 59), `creditRisk` (line 114) |
| Short & leverage | "Stock loan source" | select | `short.source` (exposure policy) | 'distribution' | 'self', 'distribution' | electron/exposure.cjs `savePolicy` (line 59), `CREDIT_TYPES` (line 10) |
| Short & leverage | "Annual borrowing fee" (%) | number | `short.feePct` (exposure policy) | 5 | UI 0.1–30; engine > 0 and ≤ 100 | electron/exposure.cjs `savePolicy` (line 59), `creditRisk` estimate (line 116) |
| Short & leverage | "Set a daily multiple" (symbol + multiple) | text + number + "Set multiple"/"Remove" | table `product_overrides` (other: product classification) | none | symbol six digits or `NASD|NYSE|AMEX:TICKER`; multiple non-zero, absolute value ≤ 5 | electron/exposure.cjs `setOverride` (lines 47-51), `classify` (line 39) |
| Holdings | "Sector" / "Region / exposure label" (classification editor) | two text inputs + "Save classification" | table `instrument_metadata` (other: portfolio view metadata) | sector "Unclassified"; region "South Korea (listing)" / "United States (listing)" (electron/portfolio-view.cjs:6) | each at most 100 characters, no control characters | electron/portfolio-view.cjs `PortfolioView.save` (line 24) |
| Home | (none saved) | n/a | Home has no saved settings: the trend period, allocation grouping and chart options are in-memory session drafts (src/Home.tsx:96,167; src/AllocationChart.tsx:6; src/useDraftState.ts:2) | n/a | n/a | n/a |
| Home (AI activity) | "Pause background AI" / "Resume background AI" | link button | `automation.setBackgroundPaused(paused)` (main.cjs:730); on-screen text says "paused for this session" (src/Dashboard.tsx:83) | not determined | boolean | electron automation `setBackgroundPaused` (file and persistence not determined) |

## 3.6 Charts, Performance, Activity

None of these screens writes a saved setting (automation config, live/US/exposure policy, paper, costs, tax profile or app update settings). Every control is either a view choice kept in renderer session memory, a one-off action, or a data record. For completeness, the user inputs that are saved as records:

| Screen | Label on screen (exact) | Control type | Config key written (and which config) | Default | Allowed range/values | Enforced by (module file + identifier) |
|---|---|---|---|---|---|---|
| Performance · Deposits & withdrawals | "Date" | date input | `day` of a `cash_flows` record (other: performance history store; a record, not a setting) | today (Seoul) (src/AccountPerformance.tsx:44) | valid `YYYY-MM-DD`, not after today (Seoul) | electron/performance.cjs:70 `addFlow` |
| Performance · Deposits & withdrawals | "Account" | select | `market` of the record (`currency` derived) | "KR" (src/AccountPerformance.tsx:44) | `KR`, `US` | electron/performance.cjs:70 `addFlow` |
| Performance · Deposits & withdrawals | "Type" | select | sign of `amount` | "deposit" (src/AccountPerformance.tsx:44) | Deposit (+), Withdrawal (−) | src/AccountPerformance.tsx:89 |
| Performance · Deposits & withdrawals | "Amount" | money field with quick buttons | `amount` (KRW rounded to whole won, USD to cents) | empty | finite, non-zero, absolute value ≤ 1e12; the button needs > 0 | electron/performance.cjs:70, :73 `addFlow`; src/AccountPerformance.tsx:89 |
| Performance · Deposits & withdrawals | "Note" | text input | `note` (trimmed) | empty | string, at most 200 characters | electron/performance.cjs:70 `addFlow`; `maxLength` at src/AccountPerformance.tsx:88 |

View choices that are NOT persisted (session memory keys, lost on reload): `company:symbol`, `company:query`, `src/CandleChart.tsx:view|range|average|volume`, `technical:frame`, `performance:series|period|chart|flow`, `report:<mode>:start|end|query|side|status` (src/CompanyView.tsx:10; src/CandleChart.tsx:15; src/TechnicalSummary.tsx:11; src/AccountPerformance.tsx:43-44; src/ActivityReport.tsx:42-51; src/useDraftState.ts:2).

---

# 4. Cross-cutting conventions

## 4.1 The settings card and row style

The shared building blocks are in `src/SettingsUI.tsx` (comment at line 4: "a card of rows, each row a short title, an optional one-line hint and a control on the right"):

| Component | What it renders | Props that matter |
|---|---|---|
| `Card` | `<section class="settings-card">` with a head (`<h2>` title, optional `<small>` hint, optional `aside` such as a status pill) and a `setting-rows` body | `id` (anchor), `title`, `hint`, `aside`, `label` (aria-label) |
| `Row` | one row: bold title, optional small hint, control on the right. A single-control row is a `<label>` so the whole row is clickable; `block` makes it a `<div>` for rows with several controls | `title`, `hint`, `info` (an "i" dot with a tooltip), `block` |
| `Switch` | `<input type="checkbox" role="switch" class="switch">` with an aria-label | `label`, `checked`, `disabled` |
| `NumberField` | number input with a unit; when the value is outside `min`–`max` it shows "Allowed <min>–<max><unit>" at once (`role="alert"`). It warns but does not clamp: the out-of-range value stays in the draft. With `currency` it becomes a `MoneyField` | `min`, `max`, `step`, `unit`, `currency` |
| `Limit` | a `NumberField` plus a mini-switch labelled "No limit" (prop `offLabel`); the number is hidden while unlimited | `unlimited`, `onUnlimited`, `onValue` |
| `Segmented` | a `radiogroup` of buttons | `options` |

Where it is used: Engine settings (all four sub-tabs), Connections, AI provider cards, Fees & taxes, Short & leverage, and parts of Performance (imports seen in `src/EngineSettings.tsx`, `src/Connections.tsx`, `src/ProviderCards.tsx`, `src/TradingCosts.tsx`, `src/ShortLeverage.tsx`, `src/AccountPerformance.tsx`).

Copy rule visible in the code: short titles, one-line hints, and the long explanation behind a disclosure. `src/WorkspaceUX.tsx:8` says it directly: "One short sentence per page; the details live next to the controls they explain."

## 4.2 "More" details (progressive disclosure)

Three forms appear:
- `Note` (`src/Note.tsx`): `<details class="note">` with a one-line `summary` always visible and the full explanation inside (comment: "one short line is always visible; the full explanation opens on demand").
- `<details class="inline-help">` with a summary such as "Credential file format", "Provider JSON format", "Release notes", "Setup command" (`src/Connections.tsx`, `src/AppUpdates.tsx`).
- Per-card "More" disclosures inside Engine settings and other screens; each is listed with its exact summary text in that screen's Controls list in section 2.
- Row tooltips: the "i" info dot on a `Row` (`info` prop), and `title` attributes on buttons and on "Needs you" rows (the item's `detail`).

## 4.3 Drafts (`src/useDraftState.ts`)

- `useDraftState(key, initial)` behaves like `useState` but mirrors the value into a module-level `Map`, so a tab's unsaved inputs and view choices survive leaving and returning to the tab. Comment at line 2: "Session memory only: navigation retains drafts; reload/exit discards them." Nothing is written to disk.
- `useDraftRef(key, initial)` is the same idea for a mutable ref.
- `setDraft(key, value)` and `takeDraft(key)` pass a one-time value from one page to another; `takeDraft` clears it. Example: Engine settings → Trading sets `connections:ai-providers`, and Connections scrolls its AI providers section into view once (`src/Connections.tsx:21`). Other keys (which AI conversation to open, which Journal view to show) are listed in the screens that use them.
- Draft keys that depend on the connection include its id (`kis:<connectionId>`, `us:<connectionId>`, `src/main.tsx:147,149`), so a draft for one account is never shown for another.
- Two save patterns exist side by side:
  1. **Draft, then save**: Engine settings (an "Unsaved changes" bar with save and discard), Fees & taxes ("Save fees & taxes"), the provider limits ("Save limits" / "Discard").
  2. **Applies at once**: the theme, "Share KIS data with …", "Start with Windows", "Check for updates every 6 hours", tax-profile selects, and the session switches on the trading tabs.
  Each screen's Saved state entry says which pattern a control follows.

## 4.4 How errors and codes become words

The main process returns short capital-letter codes; handlers pass a thrown message through only when it matches `^[A-Z_]{3,40}$` and otherwise substitute a generic code (for example main.cjs `updateAction` → `UPDATE_FAILED`; `'replay:run'`; `'sec:test'` → `SEC_UNAVAILABLE`). The renderer maps codes to sentences with small per-screen tables. A code with no entry usually shows raw, or falls to a generic sentence. The tables found:

| Table | Where | Used by | Count / notes |
|---|---|---|---|
| `feedLabel`, `failureLine`, `REQUEST` | `src/Shell.tsx:12-20` | Market feed chip | section 1.6 |
| shell error sentences | `src/main.tsx` | top-level alert | section 1.8 |
| `kisErrors` | `src/Connections.tsx:11` | KIS brokerage card | 9 codes, listed under Connections |
| `SEC_ERRORS` | `src/Connections.tsx:110` | SEC EDGAR card | 6 codes |
| `BLOCKED`, `ERRORS` | `src/AppUpdates.tsx:5-6` | App updates | 3 + 5 codes |
| key-test texts | `electron/key-test.cjs` (`text`, `RESULTS`, `VENDORS`) | provider "Test" | made in the main process; contents not determined |
| `SAVE_ERRORS` and the Claude dry-run sentences | `src/RuntimeSettings.tsx:28-32`, `src/agentDraft.mjs` | Engine settings save | listed under Engine settings → "Error-code-to-text tables" (twelve tables there, including start/stop messages from `electron/auto-launch.cjs` and scheduler labels) |
| `dryRunText` | `src/Dashboard.tsx` | Home → AI activity (dry run) | listed under Home |
| U.S. and Korea order errors | `src/usErrors.ts`; a 21-code table in `src/LiveTrading.tsx`; `electron/us-errors.cjs` (`publicUSCode`), `electron/broker-errors.cjs` | Korea and U.S. trading tabs, Holdings | listed under the trading screens |
| `errors` | `src/ActivityReport.tsx:19` | Activity and Performance reports | 10 codes |
| `NOT_SENT` | `electron/activity-today.cjs:8-36` | Activity → Today strip ("order not sent" reasons) | about 73 keys, listed under Activity |
| origin labels ("From") | `electron/order-origin.cjs` | Activity | listed under Activity |
| `REASONS` | `src/ResearchPanel.tsx:9` | Charts → research panel | 15 codes |
| replay `ERRORS`, `failureText` | `src/ReplayPanel.tsx` | Journal → Replay | 9 codes |
| `trailText`, order pill, provider and purpose labels | `src/AgentDesk.tsx`, `src/JournalView.tsx`, `src/AiConsole.tsx` | Journal, AI console | listed there |
| guardrail event kinds | `src/Guardrails.tsx:5` | Engine settings | 3 kinds |
| Discover and Macro error tables | in `src/Discover.tsx` and its panels, `src/MacroView.tsx` | Discover, Macro | two small tables, listed under those screens |
| Start with Windows sentences | `electron/login-item.cjs` | Engine settings → Trading | made in the main process |
| start notice sentences | `electron/start-notice.cjs` | "Needs you", desktop and phone alerts | section 5.5 |

Known gaps the reading passes recorded (details in the screens): a settings save refused for range or type returns `INVALID_SETTINGS`, which has no entry in `SAVE_ERRORS`, so the raw code shows; several order-engine codes have no sentence and show raw on Korea or as a generic `US_REQUEST_FAILED` sentence on U.S. (partly inferred); paper-trading risk reasons show as raw codes.

## 4.5 Toasts (`src/Toast.tsx`)

- `toast(text, tone)` dispatches a window event `app-toast`; the single `Toaster` mounted by the shell (`src/main.tsx:152`) shows it at the bottom of the window (`role="status"`, `aria-live="polite"`).
- At most three at once; a toast with the same text replaces the older one. "ok" toasts ("✓") last 3 seconds, "error" toasts ("!") last 6 seconds.
- Purpose (comment, line 2): a save is acknowledged wherever its button is on the page. Callers seen: `ProviderCards`, `LiveTrading`, `PaperTrading`, `TradingCosts`, `ShortLeverage`, `UnifiedPortfolio`, `RuntimeSettings` (imports of `./Toast`).
- Other feedback forms: inline `notice` paragraphs (`role="status"` or `role="alert"`), per-card messages, and the chip result note.

## 4.6 Themes

- Two themes, `dark` and `light` (`type Theme`, `src/main.tsx:32`). The shell sets `document.documentElement.dataset.theme` (`src/main.tsx:71-73`); `src/themes.css` defines the colour variables per `[data-theme='light']` / `[data-theme='dark']` (`src/themes.css:2`, `:20`).
- The choice is saved in the `settings` table (key `theme`) and broadcast to all windows (section 1.6). The window background before first paint follows the saved theme (main.cjs:188, :217).
- Reduced motion is respected (`@media(prefers-reduced-motion:reduce)` in `src/themes.css:30`, `src/polish.css:98`, `:170`, `:492`, `src/research.css:58`, `src/technical.css:29`).

## 4.7 Narrow-window behaviour

The main window cannot be narrower than 760 px or shorter than 600 px (main.cjs:188); the chart window not below 560×480 (main.cjs:217). Breakpoints found (CSS `max-width` rules):

| Width at or below | What changes | Where |
|---|---|---|
| 1180 px | one rule in `src/polish.css:536` (target not read: not determined) | `src/polish.css:536` |
| 1100 px | `.grid` becomes one column, the allocation chart centres, metric figures shrink to 22 px, `main` padding 25 px | `src/style.css:1` |
| 1100 px | `.dashboard-row` ("Needs you" + AI activity) and `.paper-grid` become one column; paper stats two columns | `src/polish.css:97` |
| 1100 px | Home metrics three columns; `.home-bottom` one column; `.home-row` (trend + calendar) one column; trend stats two columns | `src/polish.css:357`, `:479` |
| 1100 px | further rules in `src/themes.css:59`, `src/polish.css:570`, `src/technical.css:26` (targets not read) | as cited |
| 1000 px | rules in `src/themes.css:61`, `:78`, `:158`, `src/polish.css:144`, `:310` (targets not read) | as cited |
| 900 px | rule in `src/themes.css:146` (target not read) | as cited |
| 860 px | Home metrics one column; trade ticket fields one column; holding-movement grid one column | `src/polish.css:358`, `:415`, `:571` |
| 800 px | sidebar narrows to 170 px (`aside{width:170px}`, `--side-w:170px`) and `main` shifts with it; the toaster re-centres | `src/style.css:1`, `src/polish.css:275`, `:454` |
| 760 px | each settings row stacks its text above its control; selects take the full width | `src/polish.css:245` |
| 700 px, 650 px | rules in `src/themes.css:112`, `:78` (targets not read; below the window's minimum width of 760 px, so they can only apply to the 560 px chart window) (inferred) | as cited |

The Engine settings unsaved bar is fixed at the bottom right with width `min(520px, 100vw - 240px)` (`src/polish.css:247`, from the Engine settings pass). The sidebar never collapses to icons; it only narrows (inferred from the two rules above).

## 4.8 Money, time and number formats

- KRW amounts use `Intl.NumberFormat('ko-KR', {style:'currency', currency:'KRW', maximumFractionDigits:0})` (for example `src/Connections.tsx:10`). Money inputs use `MoneyField` with `src/money.ts` (grouping, decimals by currency, a read-back line); behaviour is described under Fees & taxes in section 2.
- Clock times are shown in Korea time with the suffix "KST" (`toLocaleTimeString('en-GB', {timeZone:'Asia/Seoul'})`, for example `src/Shell.tsx:6`). The App updates "checked" stamp is the exception: it uses the computer's local time (`toLocaleString()`, `src/AppUpdates.tsx`).

## 4.9 Polling and shared feeds

- `subscribeRuntime` (`src/runtimeFeed.ts`): one shared 2-second `getRuntime` poll for all status components; the first subscriber starts the timer, the last stops it; a failed request is passed on with the last good state. `refreshRuntime()` asks at once after an action. `needsHistory` decides when Journal and News fetch the large history (`runtime:history`).
- Not every screen uses it: `Connections` and `SavedConnections` run their own 2-second `getRuntime` timers (`src/Connections.tsx:22`).
- Broadcasts from the main process: `market:changed`, `events:changed`, `theme:changed`, `update:changed`, `chart:tick` (`electron/preload.cjs:16,20,91-109`).
- `SectionBoundary` (`src/SectionBoundary.tsx`) wraps sections so one failing section does not blank the page (described under Home).

## 4.10 The "Needs you" list

The list is `AttentionPanel` on Home (`src/Dashboard.tsx`), fed by `attentionState()` in main.cjs (≈602-627) every 5 seconds. The full table of the 20 item kinds, their exact titles, what creates each and where each button leads is under Home → AttentionPanel in section 2. In short, items can be: cash-change checks (three forms), "Connect your KIS account", orders waiting for approval (Korea, U.S.), optional learning notes, a tripped guardrail, the daily loss limit (emergency), loss check unavailable, late opening value, review back-off after repeated failures, a provider waiting on credit or limits, the last review failed, margin or short warnings, important disclosures, a stop order that cannot read its purchase, the first Claude review not run, a purchase with no stop order, the restart notice, and a downloaded update. Only the restart notice can be dismissed (`workspace:dismiss`; held in memory, so it returns after the next restart if still relevant). The same state supplies the sidebar badge counts (section 1.4).

---

# 5. First run, connections, updates, Start with Windows, alerts

## 5.1 First run

There is no wizard or separate onboarding screen. What a new user sees, from the code:

1. The app opens on Home (`src/main.tsx:43`). With no KIS connection the Home portfolio parts are not drawn (`isKis` false, `src/main.tsx:135`); the empty state "Connect your portfolio" with "Connect account" and "Open paper trading" shows (`src/main.tsx:136`).
2. "Needs you" shows the item "Connect your KIS account" with the button "Open Connections" (main.cjs `attentionState`, item `connect`; see Home in section 2).
3. The account chip reads "Not connected" with a "Connect" button (`src/Shell.tsx:54`). The market feed chip is hidden. The engine chip reads "Manual" once the runtime state arrives.
4. On Connections, the "Credential file format" disclosure is open by default while no file is remembered (`src/Connections.tsx:63`).
5. Defaults at first run that matter to the user: theme dark (`electron/storage.cjs:14`); automation scope `paper`, decision maker `local`, scheduled reviews off, automatic orders off (section 3.2); update checks on (`electron/app-updates.cjs` `settings`); no start notice on a first start (`electron/start-notice.cjs` `startNotice`: "none on a first start").
6. Paper trading works without any connection (`src/main.tsx:146` has no `isKis` condition).

An older four-step guide ("1 · Connect", "2 · Configure", "3 · Practice", "4 · Verify") exists in `RuntimePulse` (`src/WorkspaceUX.tsx:38`) but is not mounted (section 1.4).

## 5.2 Connecting (credential files)

No credential file was opened for this description; it is taken from the import code and the on-screen format examples only.

Flow for each of the three files (KIS account, provider keys, calendar key):

1. The user presses the import button on Connections. The main process opens a native file dialog limited to `.json` (titles: "Import KIS credentials", "Import provider configuration", "Import a live KIS key for the market calendar"; main.cjs `'kis:import'`, `'runtime:providers'`, `'calendar:import'`). Cancelling changes nothing.
2. The remembered path of that kind is forgotten first, then the chosen path is handed to the matching worker service with an `import` request (`kisService`, `providerService`, `calendarService`; main.cjs:78-100). The renderer never receives the file contents or the path, only a file name and a status (`remembered.state()`: `remembered`, `name`, `status`, `error`; `electron/remembered-files.cjs`).
3. On success the absolute path is saved in the `settings` table under `connection-file:<kind>` and the status becomes `connected`. For KIS, the first balance snapshot becomes the app's KIS state and the market state is broadcast (main.cjs:97-99). For providers, the returned flags (`aiConnected`, `openaiConnected`, `anthropicConnected`, `dartConnected`, `pushConnected`, and others such as `ecosConnected`, `fredConnected`, `secConnected` read by the UI) become `automation.providerStatus`, and an AI key selects the `openai` decision provider (main.cjs:80).
4. On failure the service is disconnected, the status becomes `error`, and a fixed sentence is stored for the card (section 2, Connections → Notes). For KIS the account error code comes from `kisErrorCode(error)` and is shown through `kisErrors`.
5. At every start the app reopens all remembered files (`remembered.restore`, main.cjs:860; skipped in verification runs). The on-screen note adds: "Trading and scheduled reviews still start paused."
6. "Disconnect" (KIS only) ends the session but keeps the remembered path; "Forget & disconnect" deletes the path and disconnects; "Reconnect" re-imports from the remembered path.

Connecting or disconnecting KIS stops both live engines first (`live.stop()`, `usLive?.stop()`; main.cjs:96, `'kis:disconnect'`, `'connections:forget'`).

Expected file shapes shown to the user (placeholders only): the KIS file has `environment`, `appKey`, `appSecret`, `accountNumber`, `accountProductCode`; the provider file has optional `openaiApiKey`, `anthropicApiKey`, `dartApiKey`, `ecosApiKey`, `fredApiKey`, `secContactEmail`, `pushWebhookURL` (`src/Connections.tsx:63`, `:79`).

## 5.3 In-app updates

UI: the "App updates" section at the bottom of Connections (section 2). Behaviour (`electron/app-updates.cjs`; wiring at main.cjs:638-648):

- Updates exist only for installer builds: the app must be packaged and have `app-update.yml` in its resources. Otherwise the status is `disabled` and the section says "Updates work in the installed app only."
- Source: GitHub Releases through `electron-updater`. `autoDownload`, `autoInstallOnAppQuit`, pre-releases and downgrades are all off.
- Automatic check: 30 seconds after start and then tested every 10 minutes; a check runs when the setting is on, the status is `idle`, `up-to-date` or `error`, and the last check is at least 6 hours old (`tick`, `CHECK_EVERY_MS`).
- The user starts the download ("Download <version>") and the install ("Restart and install"). Install calls `quitAndInstall(false, true)`.
- Install is refused while auto trading is armed, a review is running, or a broker order is open (`canInstall`, main.cjs:640). The reason shows under the button.
- A downloaded update also appears in "Needs you": "Version <x> is ready to install", button "Install" → Connections.
- State changes reach every window through `update:changed`.
- Errors are reduced to five codes so no URL or path reaches the UI (`publicError`).

## 5.4 Start with Windows

- UI: the switch "Start with Windows" in Engine settings → Trading (`src/EngineSettings.tsx:241-270`). It applies at once and is not part of the settings draft. Hint: "Opens the app when you sign in to Windows. After a restart at night it opens only once you sign in. It starts paused." (text as recorded in the Engine settings pass, `src/EngineSettings.tsx:269-270`).
- Calls: `getLoginItem` → `system:login-item`; `setLoginItem(on)` → `system:set-login-item` (main.cjs:632-634) → `electron/login-item.cjs` `createLoginItem`.
- The state is read from Windows each time (`app.getLoginItemSettings` with the quoted exe path), never from a saved copy. Only the installed app can set it; a development run answers "Available in the installed app." and the switch is disabled. Test runs use an in-memory fake.
- Other sentences: "Windows did not answer. Try again later."; "Set for all users of this PC; turn it off in Windows Startup apps."; "Turned off in Windows Startup apps."; "Windows did not accept the change."; "Invalid request."
- Turning it on first removes every existing per-user Run value for this exe, then adds one; machine-wide values are left alone (`set`, `electron/login-item.cjs`).

## 5.5 Alerts shown to the user

There are four channels: in-window (toasts, notices, "Needs you", chips), Windows desktop notifications, phone messages through a webhook, and phone snapshots. There is no tray icon.

**Desktop notifications** (`Notifications`, `electron/notifications.cjs`; created at main.cjs:338): a Windows notification titled "Financial Portfolio Manager" with the message as body, shown when the setting "Desktop alerts" (`desktopAlerts`) is on and the platform supports it.

**Phone messages**: when "Phone alerts" (`mobileAlerts`) is on, the same messages are queued in the table `notification_outbox` and sent by the provider service's `push` request to the webhook from the provider file (`pushWebhookURL`). Delivery: one message per tick, up to 5 attempts with a growing delay (30 s doubling, at most 1 hour); undelivered messages expire after 12 hours (`tick`, `EXPIRE_MS`). Nothing is sent while no webhook is connected.

What produces a message:

| Source | Message | Where |
|---|---|---|
| Order status change (paper, Korea, U.S.) to Accepted, Partially filled, Filled, Risk stopped, Canceled, Uncertain or Rejected | "<MOCK / LIVE / PAPER> <status>: <side> <symbol>, <filled>/<quantity> shares. <reason>" (default reason "Broker order update." or "Simulated execution.") | `observe`, `electron/notifications.cjs`; fed at main.cjs:239. Orders created before this app start are not announced on first sight |
| Guardrail event | "Guardrail: <detail>" | `electron/automation.cjs:324` |
| Detected cash flow | id `flow-<id>` | `electron/automation.cjs:301` (text not read: not determined) |
| Reconciliation health | id `reconcile-<market>-<since>` | `electron/automation.cjs:308` (text not read) |
| AI provider outage / recovery / stall | ids `ai-outage:…`, `ai-recovered:…`, `ai-stalled:…` | `electron/automation.cjs:636`, `:678`, `:682` (texts not read) |
| Claude review not started | "Claude review not started: <reason>" | `electron/automation.cjs:705` |
| Claude dry run advised | id `claude-dry-run-advised` | `electron/automation.cjs:717` (text not read) |
| Watchlist alert trial ended | "Watchlist alert trial ended. <why>" | `electron/automation.cjs:1370` |
| Stop loss rejected | "Stop loss for <symbol> was rejected: <outcome> The position is not protected until a new one is armed." | `electron/automation.cjs:1435` |
| Stop order cannot read its purchase | "The stop order for <symbol> cannot read its purchase record; it stays armed and keeps trying." | `electron/automation.cjs:1465` |
| Purchase with no stop order | "The purchase of <qty> <symbol> has no stop order: <reason>" | `electron/automation.cjs:1635` |
| Daily digest | the digest text, id `digest:<day>` | `electron/daily-digest.cjs:51`; settings "Send a daily digest" and its hour in Engine settings → Alerts |
| Start notice | see below | main.cjs:342-343 |

Each message has an id, and the outbox ignores a repeated id (`INSERT OR IGNORE`), so one event is sent to the phone once.

**Start notice** (`electron/start-notice.cjs`; main.cjs:340-343): on a start after a previous run, if stop orders are armed, trailing stops are armed, or auto trading was running, the app raises one alert 3 seconds after start (desktop and phone, by the same two settings) and adds the "Needs you" item `restart-notice`. The message is built from: how the app last stopped ("The app was closed by a Windows restart or shutdown at <time>." / "The app stopped unexpectedly after <time>." / "The app was closed at <time>."), "The app started and auto trading is paused.", "<n> stop order(s) is/are not being watched." (or "Stop orders are not being watched."), the trailing-stop sentence ("<n> trailing stop(s) will catch up from daily highs when you press Start, and it/one may sell at once if its new level is at or above the price."), and "Open the app and press Start auto trading." Item titles: "Auto trading paused after a restart", "Paused: <n> stop order(s) not watched", "Paused: stop orders not watched".

**Windows session end** (main.cjs:193-198): when Windows restarts, shuts down or signs out, the app records the stop and, if phone alerts are on and a webhook is connected, sends one message straight to the webhook: "Windows is closing the app (restart or shutdown). <n> stop order(s) will not be watched until you open it again." (or "Stop orders will not be watched until you open it again." / "Auto trading stops until you open it again and press Start."). Nothing is sent when no stop is armed and auto trading is not running (`sessionEndMessage`).

**Phone snapshots** (`electron/phone-snapshot.cjs`; wiring main.cjs ≈542-554): with "Phone alerts" and "Snapshot on each trade" (`phoneSnapshots`) on, a completed fill is sent as a snapshot (a Discord embed with portfolio figures and a chart image) instead of the one-line alert; partial fills stay one-line. "Show amounts" (`phoneAmounts`) controls whether amounts appear. The chart is drawn when the post is sent (`electron/chart-image.cjs` `renderChart`); a snapshot older than 30 minutes is sent as text only. Snapshots never go to desktop alerts. The only UI is in Engine settings → Alerts: the switches and a test button that calls `testPhoneSnapshot` → `phone:test`, answering `PHONE_ALERTS_OFF` or `NO_WEBHOOK` when it cannot send (texts under Engine settings). The snapshot's exact fields: not determined here (`electron/phone-snapshot.cjs` was not read in full).

**In-window**: toasts (4.5), the top-level alert (1.8), the engine chip's states (1.6), `EmergencyBanner` on every tab (described under Home), "Needs you" (4.10) and the sidebar badges (1.4).

---

# 6. Not determined

Collected from every reading pass. Items are grouped by the pass that recorded them. Where another section of this part answers an item, that is said.

## 6.1 Shell, Connections, updates, alerts

- Where the `#console` hash is set (only the read at `src/main.tsx:43` was found).
- Whether any component reads the `next` / `target` fields of `tabGuides`.
- The exact items of Electron's standard Edit and Window menus (roles only are in the code).
- What the KIS, provider and calendar worker services keep in memory after an `import`, and how they validate the file (worker files not read; credential files never opened).
- The texts in `src/providerText.mjs` (`ANTHROPIC_NOTE`, `providerUses`) and in `electron/key-test.cjs`.
- `kisErrorCode` (which errors map to which of the nine codes).
- The CSS targets of the breakpoints marked "target not read" in 4.7.
- The texts of the alerts marked "text not read" in 5.5, and the full content of a phone snapshot and of the daily digest.
- The body of `runtimeState()` beyond the fields named.
- Whether `SavedConnections` is mounted anywhere (no mount found in `src/*.tsx`; `.mjs` files were not searched).

## 6.2 Home, Holdings, Fees & taxes, Short & leverage

Answered elsewhere in this part: `runtime:open-news` (News); `ValueChart` (Performance, PerfCharts); start/stop messages and `launch` (Engine settings); background AI pause (Engine settings and Home).

- Which function fills `runtimeState().exposure` (read by `ExposurePanel`); only that `movesTogether` appears in `electron/portfolio-risk.cjs`.
- Whether `UnifiedPortfolio` is mounted anywhere in `overview` mode, and where `SaleCosts` (src/TradingCosts.tsx:13) is mounted.
- The handler line and behaviour of `runtime:open-news` (used for the two KIS links on Fees & taxes).
- Whether "Pause background AI" is persisted, its default, and the module that holds `setBackgroundPaused`.
- Where the automation config flag `creditProtectionApproved` is set (it changes the credit-path notices on Short & leverage).
- The full text table in `src/usErrors` (U.S. error codes shown on Holdings) and the reasons produced inside `electron/valuation.cjs` (`valuation.combined.reasons`, shown under "Details" on Home).
- The contents of `runtimeState()` (fields `launch`, `scheduler`, `providerWait`, `calendar`, `backgroundAi`) beyond how these screens read them; the texts of `launch.label` and the start/stop messages from `electron/auto-launch.cjs`.
- The "Comprehensive taxation" sub-line text (`income.comprehensiveReview`) and the tax assumptions text, which come from the engine (electron/income-events.cjs, electron/tax-ledger.cjs), not read in full.
- Narrow-window behaviour: it is in the CSS files (src/style.css, src/polish.css), which were not read.
- `src/ValueChart` (in src/PerfCharts) hover behaviour on the Home account-value chart.

## 6.3 Charts, Performance, Activity

Answered elsewhere: the `portfolio:get` handler (Home, Holdings); `Card` / `Row` / `Note` markup (4.1, 4.2).

- The main.cjs handler line for `portfolio:get` and the shape of its `rows` (outside the assigned handlers).
- Which renderer code calls `getHistory` / `market:history`; none of the assigned Charts files do (grep in src found only the type declaration in src/main.tsx:38 and src/market.mjs:1, :62, not read).
- The internals of `kis-evidence.cjs` `fetchEvidence` / `fetchBars` (bar counts, which KIS endpoints), and of `research-service.cjs` `profile` (per-section sources, cache times); only the function names were established.
- The exact texts of performance "unavailable" reasons, correction kinds (`correctionItems.kind`), the `provisional` reasons, and the `note` strings of the Factors / Fair value / Holdings research sections: they are produced in engine files not assigned here (`performance.cjs`, research modules).
- How `benchmarkFor(kind)` maps KRW/USD to an index (defined in electron/performance.cjs, imported at main.cjs:456; not read). The screen only names KOSPI and S&P 500 (src/AccountPerformance.tsx:24).
- The list of `INDEXES` beyond the first five entries seen (KOSPI, KOSDAQ, KOSPI200, SPX, COMP, NDX…; electron/performance.cjs:4 was truncated in the search output).
- The possible `status` strings of KIS order rows (the status select is built from the data; they come from the KIS worker).
- `activity-chains.cjs` `markChains` rules (only its call site and the `chainOverfill` / `chainId` fields were read).
- The texts of scoreboard conflict `reason` strings and lesson `applicability` (engine data).
- The exact count of `NOT_SENT` codes was not machine-counted (about 73 keys including the two lower-case aliases); the table above lists every key read.
- CSS details of `research.css` for narrow windows: only one `@media` rule exists there (reduced motion); `.research-scroll` overflow behaviour was not read.
- Whether `Card`, `Row`, `Note` (src/SettingsUI.tsx, src/Note.tsx) add any visible text of their own.

## 6.4 Korea, U.S., Paper, Discover, Macro

Answered elsewhere: `MarketStatus` (Home); `SaleCosts` is defined in `src/TradingCosts.tsx`; `src/LiveTrading.tsx` imports from `./TradingCosts`, so it is probably mounted on the trading tabs (inferred).

- Narrow-window behaviour of all four screens (no CSS was read).
- `MarketStatus` and `SaleCosts` contents (other files; not assigned).
- The engine threshold behind `PRICE_MOVED` (the UI text says 2%), and the full set of checks between LE:157 and LE:204 (read only by error code).
- What `automation.refreshUS()` reads (the `us:refresh` path) beyond its name.
- Where the paper universe (`domain.holdings`) and its simulated quotes (`marketCache.snapshot()`) come from.
- The storage behind `automation.narratives.hide` and `MacroStore` (table names).
- The exact text of the narrative/scout `blocked` strings (produced in `electron/automation.cjs`, not read).
- `research:company` section contents used by `OrderQuote` and `QuickLook` (handler at main:446 not traced).
- Whether `EXTENDED_SIZE_LIMIT` ever reaches the KR tab with its own text: it is absent from the allow-list at main:707, so the conclusion that it shows as `KIS_ORDER_FAILED` is inferred.
- `src/scout.css` details.

## 6.5 Engine settings

Answered elsewhere: `MoneyField` behaviour (Fees & taxes).

- `runtimeState()` in electron/main.cjs: its body was not read; that it wraps `automation.getState()` is inferred.
- The body of the `runtime:providers` handler (electron/main.cjs:732) and of `automation.approveLesson`: not read (other screens).
- Where each setting takes effect at run time beyond its validation (for example which module reads `sizingRiskPct`, `orderTracking`, `degradeNearBudget`, `closedMarketReviews`): not traced; the "Enforced by" column names the validator, plus the run-time function only where it was read.
- `MoneyField` (src/MoneyField.tsx), used by `NumberField` when `currency` is set: not read; its formatting and range behaviour for "Reflection spending" are not determined.
- The value of `CLAUDE_FORMS_SINCE` and the body of `versionAtLeast` (electron/automation.cjs:978-979): not read.
- The exact contents of the digest text (`buildDigest` beyond its first lines, electron/daily-digest.cjs:11-14) and of the test snapshot figures (`figures()` in main.cjs): not read.
- `automation.dryRunEstimate` (electron/automation.cjs:539) and the rest of `dryRun` after line 391: not read; only the entry checks are documented.
- `automation.watches.reset` (what "default alerts" restores) : not read.
- What links to the card anchor ids `eng-*`: not determined.
- Whether `claudeReservation` uses the numbers shown in the `CLAUDE_TRADING_LIMITS` check exactly as the Connections card shows them: not traced (electron/automation.cjs:943 not read past its first line).
- CSS details of the cards beyond the lines cited (src/polish.css:173-271, src/themes.css:75) were not read in full.

## 6.6 Journal, AI console, News

Answered elsewhere: `Scoreboard` (Performance section, "Scoreboard"); `Note` markup (4.2); some narrow-window rules (4.7).

- The full body of the `runtime:lesson-trial` handler (main.cjs:741): which error codes it returns to the window after `LOCAL_EVALUATION_FAILED` / `INVALID_TRIAL` (the line was longer than the bounded read).
- The bodies of `automation.replay` and `replayPlan` (electron/automation.cjs:1697-1698) and `ReplayStore` (electron/replay.cjs): how many runs are kept, the engine-side limits for `limit`, `capUSD` and `instructions`, and where `REPLAY_NO_CHANGE`, `REPLAY_NOTHING`, `REPLAY_BUSY` are raised.
- The full body of `automation.approveLesson` beyond its first statements (electron/automation.cjs:1999).
- The period of the main-process tick that hosts the news refresh check (main.cjs:242).
- How `newsEvents.ingest` decides `importance` and matched `symbols`, and what `newsEvents.pending(mode)` selects (electron/news-events.cjs was read only for `MODES`).
- What `Scoreboard` shows (another agent's screen).
- The exact markup of `Note` (src/Note.tsx:3): treated here as a disclosure with a summary (inferred from its `summary` prop).
- Whether any main-process code other than `interaction` (main.cjs:101) and `demo:run` (main.cjs:852) appends events; the search for `appendEvent` in electron/ found only those two callers and the definition (electron/storage.cjs:20).
- Narrow-window behaviour of these screens (CSS was not read).
- Where the `#console` hash is set by the main process (a search of src/ and electron/ for "#console" found only src/main.tsx:43).

