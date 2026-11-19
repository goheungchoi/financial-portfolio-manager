# Part 2 — Orders, the broker layer, money and risk rules

Read from the code on 2026-11-19. Read-only: nothing was run, no KIS call, no database read.

**Which code this describes.** Written from `9c89338` and amended with the removal of the automatic U.S. buy block
(9.1). Line numbers are those of `9c89338`; the removal moved `live-engine.cjs` lines by +1 from line 5, +4 from
about line 60 and +6 after `autoSubmit`. Every citation also names a searchable identifier, so use that when a line
has moved.

Conventions: "(inferred)" marks a conclusion not read from one line. "Not determined" means I did not find or read it.
"Audit" is `artifacts/reviews/2026-11-19-order-rule-audit/audit.md`; "implementer note" is `implementer-note.md` beside
it. Where I repeat one of their readings without re-reading the line myself, it says "(audit, not re-read)".

File names that differ from the brief: the paper engine is `electron/paper-engine.cjs` (there is no `paper.cjs`).
There is no `order-tracker.cjs` or `order-batch.cjs`: the tracker is `Automation.trackOrders` and the batch is
`Automation.placeBatch`, both in `electron/automation.cjs`.

---

## 1. The picture in plain words

- An **order** starts as a *proposal* in one of two engines (`LiveEngine`, one for Korea and one for the U.S.), saved
  with status `Ready`. It comes from one of three places: an AI review, a conditional order that fired (a stop, a take
  profit, an entry), or the user's own order ticket.
- A proposal is **sent** either by the user (pressing "Approve LIVE order" / "Approve MOCK order"; the button sends
  the confirmation phrase `PLACE LIVE ORDER` / `PLACE MOCK ORDER`, which the engine checks; nothing is typed) or automatically (`autoSubmit`), if the
  market's automatic switch is on. Both go through the same `send()` function, which runs every check again.
- Sending has two KIS steps: a **check** ("prepare": session, price, KIS's own buying power, other open orders) that
  returns a 15-second **ticket**, and the **placement** with that ticket.
- All KIS requests run in a separate **worker process**, one at a time, through one **queue**. An order holds the
  queue between its check and its placement.
- Every **buy** must also fit a **funding ledger** shared by both markets, because Korean won can pay for U.S. buys.
- After sending, the app **reconciles** each open order with KIS's order history every 30 seconds, and a **tracker**
  moves open orders to the best bid or ask every 3 seconds.
- Orders are **limit orders only**, 1 to 10,000 shares, in both markets (`live-engine.cjs:111` `propose`;
  `kis-client.cjs:312` `ORD_DVSN` '00'; `kis-overseas.cjs:137` `ORD_DVSN:'00'`).

---

## 2. Broker layer

### 2.1 The service and its queue — `electron/kis-service.cjs`

Plain words: the main process never talks to KIS itself. `KisService` starts a utility process
(`kis-worker.cjs`), posts one message per request, and waits for the reply.

- **One class, three workers.** `KisService` also runs the AI provider worker and the calendar worker; only the KIS
  worker's requests are tagged and recorded (`kis-service.cjs:7`, `:27` `isKis`, `:36-41`).
- **Queue.** `request()` → `enqueue()` chains each request on `this.queue`, so one runs at a time
  (`kis-service.cjs:42-49`). The worker itself answers `BUSY` to a second message while one is running
  (`kis-worker.cjs:9`).
- **Timeout.** A KIS request that gets no reply in 90 s disconnects the worker and fails with `REQUEST_FAILED`
  (`kis-service.cjs:72`).
- **Cooldown.** When a failure carries `retryAt` (a rate limit), the service remembers it (`cooldownUntil`,
  `kis-service.cjs:19`). Until then every request is refused before it is sent, as `RATE_LIMITED` with
  `notSent:true` (`kis-service.cjs:43`).
- **Generation.** `disconnect()` raises `generation`, empties the queue and kills the worker; a request queued under an
  older generation fails with `BROKER_UNAVAILABLE` (`kis-service.cjs:43`, `:77`). A worker that exits rejects everything
  pending with `BROKER_UNAVAILABLE` (`:21-23`).
- **Hold.** `hold(fn,{label,limitMs=30000})` lets one order keep the queue from its check to its placement: the hold
  is taken in turn; requests made inside `fn` go straight to the worker; everything else waits. After 30 s the hold is
  released anyway and `onHoldLimit` is told (`kis-service.cjs:55-67`). `main.cjs:263` logs "KIS queue released by its
  limit". `ahead()` lists what a new request would wait behind (`kis-service.cjs:53`).
- **Failures record.** Every failed KIS request leaves a record: time, operation, the app's code, KIS's code, how long
  it waited and ran, and whether it was refused before sending (`noteFailure`, `kis-service.cjs:28-32`). The service
  keeps the last 200 in memory; `main.cjs:261-262` stores them in the table `kis_failures` and trims it to 200 rows. No
  payload and no account data are kept. The error also gets `kisOperation`, so a failed review can name the request
  (`kis-service.cjs:40`; used at `automation.cjs:868`).

### 2.2 The worker — `electron/kis-worker.cjs`

Operations the order path uses (the engine names on the left; the U.S. engine's broker adds the `us-` prefix,
`main.cjs:258` `usBroker`):

| Engine request | Korea (worker) | U.S. (worker) | What it does |
|---|---|---|---|
| `live-context` | `live-context` `kis-worker.cjs:44-53` | `us-context` `:31` | Balance, up to 20 quotes, the session now |
| `prepare-order` | `:54-59` | `us-prepare-order` `:37` | The check; returns a ticket |
| `place-order` | `:60-65` | `us-place-order` `:38` | Places with the ticket |
| `revise-order` | `:66-68` | `us-revise-order` `:36` | Revise price or cancel |
| `orders` | `:72-74` (`getActivity`) | `us-orders` `:33` | The day's order history |
| `charges` | `:69-71` | `us-charges` `:34` | Fees KIS reports |
| — | `refresh`/`import` `:105-109` | `us-balance` `:40` | Balance alone |

- The worker computes the tradable session itself (`market-sessions.tradableNow`) from the switches the app passes in
  `data.sessions` (`kis-worker.cjs:30`, `:48`, `:56`).
- **Error codes leave the worker through one function**, `relayCode` (`kis-worker.cjs:112`, `worker-codes.cjs:13-16`).

### 2.3 Error codes — `worker-codes.cjs`, `us-errors.cjs`, `broker-errors.cjs`

- **Korea**: only the codes in `KR_ALLOWED` pass; anything else becomes `REQUEST_FAILED` (`worker-codes.cjs:5-8`,
  `:16`).
- **U.S.**: `publicUSCode` passes the `BASE` codes, the `US_(BALANCE|CASH|QUOTES)_*` stage codes, and — only for the
  three order operations — `PRICE_MOVED`, `INSUFFICIENT_CAPACITY`, `OPEN_BROKER_ORDERS`, `INVALID_ORDER`,
  `ORDER_UNCERTAIN`. Anything else becomes `US_REQUEST_FAILED` (`us-errors.cjs:1-7`). This is the fix of audit item 3,
  committed in `9c89338`; I confirmed it in the code.
- **Not sent.** For the four sending operations, an error marked `notSent` is relabelled `ORDER_NOT_SENT`, except an
  expired ticket, which keeps `TICKET_EXPIRED` (`worker-codes.cjs:9-14`).
- **HTTP level.** `broker-errors.cjs:2` `responseError`: KIS code `EGW00201` or HTTP 429 → `RATE_LIMITED`; 401/403 →
  `AUTH_FAILED`; 5xx → `SERVER_ERROR`; else `REQUEST_FAILED`.
- **What a failed order request means** (`kis-client.cjs:8-10` `orderError`): KIS refused it → `BROKER_REJECTED`;
  refused locally before sending → `ORDER_NOT_SENT`; anything else → `ORDER_UNCERTAIN` (it may be at KIS).
- **Classification for conditional orders** (`broker-errors.cjs:11-17` `classify`): `temporary`, `broker`,
  `uncertain`, `check`, or `internal` (a fault in the app, with file and line).

### 2.4 The HTTP client and rate limiting — `kis-client.cjs`

- Requests are serialised again inside the worker (`httpQueue`) and spaced: 650 ms apart on a live account, 1,500 ms
  on mock (`kis-client.cjs:66-69`). Most calls also wait 550 ms first (`:181`, `:225`, `:240`).
- A GET that fails with a network error, timeout or server error is retried once after 1.2 s; a POST (an order) is
  never retried (`kis-client.cjs:73`).
- A rate limit from KIS sets a local back-off: 60 s, doubling with each one inside 10 minutes, at most 300 s
  (`kis-client.cjs:73` `rateLimitedUntil`). During it, requests are refused locally with `notSent` (`:71`).
- Each request times out after 15 s (`kis-client.cjs:79`).
- The account key is an HMAC of environment + account number + product code; the U.S. key is the same with `:US`
  appended (`kis-client.cjs:187`, `:246`).

### 2.5 Korea — the check and the placement (`kis-client.cjs`)

`prepareOrder` (`kis-client.cjs:263-293`), in order:

1. Shape: six-digit code, Buy/Sell, 1–10,000 shares, whole-won price → else `INVALID_ORDER` (`:265`).
2. Credit orders: live accounts only (`FEATURE_UNAVAILABLE`), never in an extended session (`:264`, `:266-269`).
3. `checkSession` (`:248-262`): outside the app's window → `SESSION_CLOSED`. Live accounts also ask KIS's holiday
   calendar once a day (`CTCA0903R`); mock accounts use weekdays only.
4. Quote (`FHKST01010100`; the Nextrade feed `NX` in an NXT session): the price must be on the tick unit and the stock
   not halted → else `INVALID_ORDER` (`:271-273`).
5. The limit must be within **2%** of the quote → else `PRICE_MOVED` (`:274`).
6. Balance, then KIS's own capacity:
   - cash buy: `inquire-psbl-order` (`TTTC8908R`); refused when quantity is above `nrcvb_buy_qty` or
     `limit × quantity × 1.02` is above `nrcvb_buy_amt` → `INSUFFICIENT_CAPACITY` (`:286-288`);
   - sale: quantity above the holding's orderable quantity → `INSUFFICIENT_CAPACITY` (`:289`);
   - credit: KIS's credit capacity or the matching loan/short lot (`:277-284`).
7. The day's order history, then the open-order guard (2.9) → `OPEN_BROKER_ORDERS` (`:290-291`).

It returns the balance, the price, and `capacityRaw` (KIS's figures, stored in `broker_capacity`).

`placeOrder` (`kis-client.cjs:309-319`): `order-cash`, limit order, exchange `KRX` or `NXT` from the session's route.
A reply without an order number is `ORDER_UNCERTAIN`. A credit order goes to `placeCreditOrder` (`:295-307`), which
first refuses any credit path that is not executable (`CREDIT_PATH_UNVERIFIED`).

`reviseOrder` (`:322-332`): `order-rvsecncl` for all unfilled shares; `exchange` defaults to `'KRX'`. **The engine never
passes an exchange** (`live-engine.cjs:530`), so a revise or cancel always names KRX, also for an NXT order. In practice
the engine refuses to revise any extended-session order first (`live-engine.cjs:506`), so the NXT case is not reached
through the app (inferred).

### 2.6 U.S. — the check and the placement (`kis-overseas.cjs`)

`prepare` (`kis-overseas.cjs:133`), in order:

1. Shape: `NASD|NYSE|AMEX:TICKER`, 1–10,000 shares, price at least $1 in whole cents → `INVALID_ORDER`.
2. Not in an extended session and the regular session closed → `SESSION_CLOSED`.
3. Quote (the daytime feed in the daytime session); limit more than **2%** from it → `PRICE_MOVED`.
4. Balance. A sale above the orderable quantity → `INSUFFICIENT_CAPACITY`.
5. A buy: KIS's buying-power query (`TTTS3007R`). If KIS's integrated figure is larger than its foreign-currency
   figure, integrated margin is taken as on (`buying-power.cjs:10` `integratedOn`) and the integrated figures are used.
   Refused when quantity is above KIS's quantity or `quantity × limit × 1.02` is above KIS's amount →
   `INSUFFICIENT_CAPACITY`.
6. The day's order history and the open-order guard → `OPEN_BROKER_ORDERS`.

`place` (`:135-137`): the regular `order` endpoint (also used for pre- and after-market); the KIS daytime session has
its own endpoint, live accounts only. `revise` (`:140-145`) works only while the regular session is open
(`SESSION_CLOSED` otherwise).

U.S. order history: live accounts query `NASD` only and the worker maps the daytime and three-letter exchange codes
back to the regular ones; rows of other markets are dropped and counted (`kis-overseas.cjs:3-7`, `:66-71`).

### 2.7 The 15-second ticket — `order-tickets.cjs`

The check stores `{command, session, expiresAt: now+15 s}` under a random ticket id (`kis-worker.cjs:37`, `:57`).
`takeTicket` deletes the ticket and refuses one that is missing, of the other market, or older than 15 s, with
`TICKET_EXPIRED` marked `notSent` (`order-tickets.cjs:6-10`). So the placement always sends exactly the command that
was checked, once. The ticket's age is returned (`ticketAgeMs`) and kept on the order's `timings`.

At placement of an extended-session order the worker checks that the same session is still open, else
`SESSION_CLOSED` (`kis-worker.cjs:38`, `:63`). A Korean regular-session order is **not** re-checked for the session at
placement by the worker (`kis-worker.cjs:63` only covers non-regular sessions); the U.S. client does re-check
(`kis-overseas.cjs:135`).

### 2.8 Sessions, hours and calendars

**Regular windows the app trades in**

| Market | Exchange hours | App's order window | Source |
|---|---|---|---|
| Korea | 09:00–15:30 Seoul | 09:00–15:20 | `kr-hours.cjs:18` `OPEN`, `APP_END`; `market-sessions.cjs:25` |
| U.S. | 09:30–16:00 New York (13:00 on early-close days) | until 10 minutes before the close | `kis-overseas.cjs:23` (`<(early?780:960)-10`); `market-sessions.cjs:34` |

**Extended sessions** (all off by default; live accounts only — `market-sessions.cjs:42` `tradability`):

| Session | Hours (local) | Setting | Route | Automatic? |
|---|---|---|---|---|
| NXT pre-market | 08:00–08:50 | `sessionKrNxt` | NXT limit | yes, with the size cap |
| NXT after-market | 15:30–20:00 | `sessionKrNxt` | NXT limit | yes, with the size cap |
| U.S. pre-market | 04:00–09:30 | `sessionUsPre` | regular order endpoint | **no: always waits for approval** |
| U.S. after-market | 16:00–20:00 (13:00–17:00 early) | `sessionUsAfter` | regular order endpoint | **no: always waits for approval** |
| KIS daytime (Blue Ocean) | 20:00 (previous day)–04:00 | `sessionUsDaytime` | daytime endpoint | yes, with the size cap |
| KRX pre-open, KRX after close | 08:30–08:40, 15:40–16:00 | none | — | shown, "Not supported by the app yet" |

Sources: `market-sessions.cjs:22-41` (`KR_SESSIONS`, `US_SESSIONS`, `TOGGLES`, `ROUTES`), `automation.cjs:244`
`sessionOptions`, defaults `automation.cjs:15`. Extended orders stop 5 minutes before their session ends; when several
sessions are open the regular one wins, then Nextrade (`market-sessions.cjs:64-72` `tradableNow`). The KRX after-hours
single-price session ended on 2026-09-14 and is kept only so screens can say so (`ENDED_SESSIONS`, `:29-30`).

**Dated exceptions.** `kr-hours.cjs` holds Korean days with other hours, kept by hand. One entry: 2026-11-19 (college
entrance exam day), everything one hour later: regular 10:00–16:30, the app's last order 16:20, no NXT pre-market
(`kr-hours.cjs:9-16`). `krWindow(day)` and `sessionOn(day,row)` are read by `market-hours.cjs:7`,
`market-sessions.cjs:47` and `kis-client.cjs:252`, so the scheduler, the session list and the order-time guard agree.

**Calendars.**
- Korea: `calendar-worker.cjs` holds a live key for one purpose, KIS's holiday calendar; `main.cjs:83-89` stores it in
  `kr_calendar(day, open, fetchedAt)`; the comment at `main.cjs:83` says every 6 hours. Without it: weekdays, plus days
  the app learns are closed when KIS says so during a session check (`automation.cjs:259-260` `noteSessions`).
- U.S.: holidays and early closes are computed in code (`kis-overseas.cjs:12-25` `usSession`; the same rules in
  `business-days.cjs:12-18`).
- `market-hours.cjs` is the scheduler's clock (which markets accept orders now, the next open, the pre-open review 10
  minutes before; `PRE_OPEN_MS`, `:4`).

### 2.9 The open-order guard — `broker-open-orders.cjs`

From the day's KIS order history (any channel, the user's own orders in KIS included):

- "Several open orders" **off**: any open order in that market refuses the check (`OPEN_BROKER_ORDERS`).
- **On**: only an open order of the **same stock** refuses it; the others are returned so the engine can count them
  (`broker-open-orders.cjs:13-16`). A U.S. stock is compared by ticker, whatever exchange code it is filed under
  (`sameStock`, `:11-12`).

### 2.10 Quotes and the feed — `kis-stream.cjs`, `kis-market.cjs`

- Korean prices stream over a WebSocket (`H0STCNT0` trade frames) for up to 20 symbols: holdings first, then the
  symbols open on Charts (`kis-worker.cjs:6`, `kis-stream.cjs:42-48`). Frames are validated and de-duplicated
  (`parseTradeFrame`, `TradeDeduplicator`).
- No message for 120 s, an error or a close → reconnect with a delay doubling from 1 s to 60 s; status
  `reconnecting` (`kis-stream.cjs:70`, `:92-98`).
- `buildKisMarket` builds the Market view: a quote is stale when it is over 60 s old; the feed is `error`, `stale` or
  `connected`, and on error names the request, the time and KIS's code (`kis-market.cjs:6-12`).
- U.S. prices are not streamed; they come with each `us-context` read. How often that runs is in `main.cjs`
  (`automation.refreshUS`, `main.cjs:291`); `trailing-stops.cjs:14` says "about once a minute". Exact timer: not
  determined.

---

## 3. The engines

### 3.1 One engine per market — `electron/live-engine.cjs`

`main.cjs:249` creates the Korean engine (`live`) on `kisService`; `main.cjs:266` creates the U.S. engine (`usLive`)
on `usBroker` with `{market:'US'}`. Differences set in the constructor (`live-engine.cjs:12`): the trading day (Seoul
date for Korea, New York date for the U.S.), the symbol format, and the price grid (whole won; cents).

Two switches per engine, both in memory only, so both are **off after every app start**:

- `enabled` — trading for this market is on. Set by `configure(limits, 'ENABLE LIVE'|'ENABLE MOCK')`
  (`live-engine.cjs:29-47`), cleared by `stop()` (`:61`) and, with several open orders off, by an unclear order reply
  (`:236`).
- `autoEnabled` — automatic sending is on. Set by `enableAuto('ENABLE AUTO LIVE'|'ENABLE AUTO MOCK')` (`:62`).

"Start auto trading" on Home (`auto-launch.cjs:10-29` `start`) runs `configure` and `enableAuto` for each engine in
scope with the saved limits, and saves `enabled:true, autoSubmit:true` in the app's settings. "Stop"
(`auto-launch.cjs:45`) turns everything off; existing broker orders stay.

### 3.2 The order record (table `live_intents`, one JSON payload per order)

Written by `save()` in one transaction with the funding commitment (`live-engine.cjs:27`).

| Field | Meaning | Set at |
|---|---|---|
| `id`, `accountKey`, `market`, `currency`, `environment`, `source:'kis'` | identity | `propose` `:126` |
| `symbol`, `side`, `quantity`, `limitPrice`, `notional` | the order; `notional` = quantity × price, raised by a revision | `:126`, `:529`, `:536` |
| `status`, `reason` | see 3.3; `reason` is the refusal code | throughout |
| `createdAt`, `expiresAt` (= created + 120 s), `day` | times; `day` is the market's trading day | `:126` |
| `costPerShare`, `costSettings`, `costEstimate`, `resultCosts`, `reportedCosts`, `fillPrice` | cost estimate, then KIS's figures | `:114`, `:196`, `:426-428`, `refreshCharges` `:459-494` |
| `product`, `requiresApproval`, `approvalReason` | product class (leveraged, inverse, unclassified) and the hold | `:126`, `holdForApproval` `:295-297` |
| `credit`, `restriction` | Korean credit kind, KIS credit type, loan date | `:126` |
| `session` | extended session id, when not regular | `:179` |
| `madeBy` | `'review'`, `'conditional'` or `'ticket'` | `automation.cjs:1171`, `:1507`; `main.cjs:334`, `:712` |
| `reviewId`, `conditionalId` | where it came from | same lines |
| `sentBy` | `'auto'` or `'you'`, written when it is marked Submitting | `:220` |
| `tracking` | the AI's bounds: `{bound, cancelAfter, cancelIf}` | `automation.cjs:1171`, `:1507` |
| `timings` | `otherMarketMs`, `aheadOfCheck`, `holdWaitMs`, `checkMs`, `checksMs`, `fundingMs`, `aheadOfPlace`, `placeMs`, `ticketAgeMs`, `holdReleasedByLimit` | `:152-231` |
| `brokerOrderId`, `organization`, `acceptedAt` | KIS's reply | `:222` |
| `brokerOrderIds`, `currentBrokerOrderId`, `currentOrganization`, `currentPrice`, `chain`, `revisions`, `cancelRequestedAt` | the order's chain of KIS numbers | `:428-429`, `:535-536` |
| `pendingRevision`, `unconfirmed`, `trackingStopped`, `handsOff` | a revision in flight; one whose reply was lost; tracking paused; the user took it over in KIS | `:529`, `:538-539`, `:429` |
| `filled`, `filledObservedAt`, `reconciledAt`, `closedReason` | fills from KIS history | `:428-429`, `:449` |
| `notSentCause`, `retryAt`, `notSentAt`, `brokerCode` | why it did not go out | `:232-233`; `automation.cjs:1600` |

`madeBy` and `sentBy` exist only on orders made from 2026-11-19; older orders make no claim (`order-origin.cjs:1-9`).

### 3.3 Order statuses

| Status | Meaning | Comes from | Goes to |
|---|---|---|---|
| `Ready` | A proposal. Nothing at KIS. Expires 120 s after creation | `propose` `:126` | `Submitting`; stays `Ready` when held for approval or refused before KIS; `Rejected` via `endUnsent` |
| `Submitting` | Saved just before the placement request | `:220` | `Accepted`, `Rejected`, `Uncertain` |
| `Accepted` | KIS gave an order number | `:222`; `linkUncertain` `:575` | `Partially filled`, `Filled`, `Canceled`, `Rejected` (reconcile) |
| `Partially filled` | Some shares filled, still open | `applyHistory` `:428`; `order-chain.cjs:31` | `Filled`, `Canceled` |
| `Filled` | All shares filled | `order-chain.cjs:31` | final |
| `Canceled` | Cancelled at KIS, expired unfilled, or left open from an earlier day | `order-chain.cjs:30-31`; `reconcile` `:449` | final |
| `Rejected` | KIS refused it (`BROKER_REJECTED`), or it never left the app (`ORDER_NOT_SENT`, `SESSION_CLOSED`, `CREDIT_PATH_UNVERIFIED`, or any refusal code via `endUnsent`) | `:232-233`; `automation.cjs:1599-1600` | final |
| `Uncertain` | KIS's reply was unclear; the order may be there | `:233` | settled by reconcile, or by the user with `linkUncertain` (`:571-576`, phrase `LINK BROKER ORDER`) |
| `Cancellation uncertain` | Listed as an open status in many checks (`live-engine.cjs:143`, `funding-ledger.cjs:20`, `credit-paths.cjs:27`) | **No code in `electron/` assigns it** (searched `status:'Cancellation uncertain'`); a cancellation with no clear reply is recorded as `trackingStopped` + `unconfirmed` instead (`:538-539`) | — |

How the screen words them (`activity-today.cjs:41-50` `stateOf`): Filled; "Rejected by KIS"; "Not sent" + reason;
"Partly filled (n of m)"; "Open"; "Waiting for your approval" (a `Ready` order not yet expired); a `Ready` order past
its 120 s reads "Not sent: it expired unapproved" (or its own reason); Canceled.

Paper statuses are separate: proposals `Ready`/`Rejected`/`Submitted`; orders `Pending`, `Partially filled`,
`Filled`, `Canceled`, `Risk stopped` (`paper-engine.cjs:69`, `:82`, `:100`, `:105`, `:119`).

### 3.4 `propose` — making the proposal (`live-engine.cjs:106-127`)

Refuses, in order: a malformed command (`INVALID_ORDER`); a credit order on a non-live account
(`FEATURE_UNAVAILABLE`); trading off (`KIS_TRADING_DISABLED`); a stock not on the allowlist when one is set
(`INSTRUMENT_NOT_ALLOWED`); notional above the order cap (`ORDER_SIZE_LIMIT`); the product rules (`exposure.check`:
`LEVERAGED_NOT_ENABLED`, `LEVERAGED_EXPOSURE_LIMIT`; a buy's base unreadable: `RISK_DATA_UNAVAILABLE` from
`exposureBase`, `:412-413`); a credit path that cannot be sent (`CREDIT_PATH_UNVERIFIED`); a closing order larger than
its lot (`EXCEEDS_LOT`, `NO_SUCH_LOT`); the credit rules (`MARGIN_*`, `SHORT_*`).

It records whether the product rule requires approval (`requiresApproval`) and saves the order `Ready`. No KIS request
is made here.

### 3.5 `send` — the checks at sending (`live-engine.cjs:132-240`)

`submit(id, phrase)` is the user's send (`automatic:false`); `autoSubmit(id)` is the automatic one (`:131`, `:565`).
Both call `send`. One order at a time per engine: a second call gets `KIS_ORDER_BUSY` (`:133`).

In order:

1. Not `Ready` → returned as it is (no error) (`:136`).
2. Credit path not executable → `CREDIT_PATH_UNVERIFIED` (`:138`).
3. Wrong confirmation phrase (`PLACE LIVE ORDER` / `PLACE MOCK ORDER`) → `APPROVAL_REQUIRED` (`:140`).
4. Trading off, or more than 120 s since the proposal → `DISABLED_OR_EXPIRED` (`:141`).
5. Other open orders: with several open orders **off**, any order of this account that is Submitting, Uncertain,
   Accepted, Partially filled, or any Uncertain/Submitting order in the database → `RECONCILIATION_REQUIRED` (`:143`).
   **On**: only `openBlock` (`:249-255`) — order history unreadable while something is open, or an order of the same
   stock whose state is unknown.
6. Allowlist or order cap changed → `LIMIT_CHANGED` (`:144`).
7. Daily turnover: today's orders in the statuses Submitting, Uncertain, Accepted, Partially filled, Filled **and
   Canceled**, each at its full notional, plus this one, above the limit → `DAILY_TURNOVER_LIMIT` (`:145-146`).
8. For a buy, the **other market's balance** is read now, before the KIS check (`:153`).
9. The order takes the **hold** on the KIS queue (`:155-156`).
10. **KIS check** (`prepare-order`, 2.5/2.6). Its refusals: `SESSION_CLOSED`, `INVALID_ORDER`, `PRICE_MOVED`,
    `INSUFFICIENT_CAPACITY`, `OPEN_BROKER_ORDERS`, `FEATURE_UNAVAILABLE`.
11. Lot re-check on the fresh balance (`EXCEEDS_LOT`); another account connected → `ACCOUNT_CHANGED` (`:161-162`).
12. KIS's capacity answer is recorded (`broker_capacity`), never blocking (`:168-169`).
13. **Extended session**: U.S. pre/after-market + automatic → `EXTENDED_APPROVAL_REQUIRED`; this order plus the app's
    other open extended-session orders above `extendedMaxOrderPct` % of the base → `EXTENDED_SIZE_LIMIT` (`:175-179`).
14. The balance is observed for the loss check; the day's policy must be today's → `DAILY_SESSION_SETUP_REQUIRED`
    (`:183-185`).
15. Credit re-check (`LIMIT_CHANGED`, `FEATURE_UNAVAILABLE`) (`:186`).
16. **Product approval as the rules are now** (`approvalNow`, `:280-286`): an automatic send that needs approval is
    held (`holdForApproval`); a manual one only runs the check for its refusals (`:190`).
17. **Company share**: (held + the stock's other open buys + this order) × limit ÷ base above `maxCompanyPct` →
    `CONCENTRATION_LIMIT` (buys only) (`:193-194`).
18. Stopped or expired meanwhile → `DISABLED_OR_EXPIRED` (`:195`).
19. **Cash**: the cost with fees above available cash → `INSUFFICIENT_CAPACITY`. Korea: the smaller of deposit and
    settled (D+2) cash. U.S.: `buyingPower(...).usd` (section 4.2) (`:199-200`).
20. **Funding ledger** `admit` (section 4.1): `ACCOUNT_CHANGED`, `FUNDING_BALANCE_STALE`, `FX_STALE`,
    `FUNDING_OVERCOMMITTED`, `INSUFFICIENT_CAPACITY`; on success the amount is reserved (`:206`).
21. Last synchronous re-checks, releasing the reservation when they fail: `notSendable` (`DISABLED_OR_EXPIRED`,
    `ACCOUNT_CHANGED`, `LIMIT_CHANGED`, `:300-304`); approval again (`:211-212`); for an automatic **opening** order the
    loss restriction (`DAILY_LOSS_RESTRICTED`, `:218`, `:291-293`).
22. Saved `Submitting` with `sentBy` (`:220`).
23. **Placement** (`place-order` with the ticket) (`:222`). Outcomes:
    - order number → `Accepted`;
    - `ORDER_NOT_SENT`, `TICKET_EXPIRED`, or a local `RATE_LIMITED` → `Rejected`, reason `ORDER_NOT_SENT`,
      `notSentCause` `'ticket-expired'` or `'rate-limit'`; trading stays on (`:232`);
    - `SESSION_CLOSED`, `CREDIT_PATH_UNVERIFIED` → `Rejected` with that reason (`:233`);
    - `BROKER_REJECTED` → `Rejected`, with KIS's code (`brokerCode`);
    - anything else → `Uncertain`, reason `ORDER_UNCERTAIN`. With several open orders off this also turns the
      market's trading **off** (`:236`).

Sales are never held back by the funding ledger, the loss restriction or the company-share rule.

### 3.6 `autoSubmit` and `holdForApproval`

`autoSubmit(id)` (`live-engine.cjs:565` at `9c89338`):

- automatic switch off → `AUTO_KIS_DISABLED`;
- a U.S. buy is treated as any other order: the market's automatic switch governs buys and sales alike (the block on
  automatic U.S. buys, `INTEGRATED_MARGIN_AUTOMATION_BLOCKED`, was removed in 1.5.69; see 9.1);
- the proposal already needs approval → returned with reason `APPROVAL_REQUIRED`, nothing sent;
- otherwise `send(..., {automatic:true})`. `EXTENDED_APPROVAL_REQUIRED` and `PRODUCT_APPROVAL_REQUIRED` are caught and
  returned as an order waiting for approval; every other error is thrown to the caller.

`holdForApproval` (`:295-297`) writes `requiresApproval:true`, `approvalReason` and reason `APPROVAL_REQUIRED` on the
`Ready` order and throws `PRODUCT_APPROVAL_REQUIRED`. It does **not** extend `expiresAt`. The user's approval is
`submit`, which refuses anything older than 120 s with `DISABLED_OR_EXPIRED` (`:141`). So an order "waiting for your
approval" can be approved only within two minutes of its creation (audit item 7; confirmed). `approvalReason` is stored
but not shown (implementer note, item 8: no reference in `src/`; not re-read).

### 3.7 `reconcile` — bringing orders up to date (`live-engine.cjs:442-455`)

- `main.cjs:240` runs it for each market at most every 30 s when the KIS queue and the engine are idle; a review runs
  it first (`automation.cjs:561`, `:294-296`).
- For each day with an open order it reads the day's history, stores every row in `broker_orders`
  (`recordHistory`, `:438-439`), and applies it to each open order through `order-chain.resolve`.
- **Chain** (`order-chain.cjs:15-35`): a revision at KIS gets a new order number linked by the original number; the
  chain follows every link, sums fills across them, and takes the status from the last link. Numbers are compared
  without leading zeros.
- A link the app did not create means the user changed the order in KIS: `handsOff` is set and the tracker leaves it
  alone (`:429`; `revise` refuses with `ORDER_TAKEN_OVER`, `:505`).
- An order still `Accepted`/`Partially filled` from an **earlier day** is saved `Canceled`, "expired at the session
  end" (`:449`).
- `reconcileHealth` counts failed reads. After 3, one alert: "Order status could not be confirmed with KIS…"
  (`automation.cjs:304-309`). While it has failures and something is open, the review context says so
  (`orderReconciliation`, `:431-435`) and, with several open orders on, no new order is sent (`openBlock`, `:250`).
- An order whose placement was unclear cannot be matched by reconcile, because it has no KIS number
  (`order-chain.cjs:16` returns null without `brokerOrderId`). It stays `Uncertain` until the user links it with
  `linkUncertain`, which demands the same symbol, side, quantity and price (`BROKER_ORDER_MISMATCH` otherwise)
  (`:571-576`) (inferred from the two functions).

### 3.8 `revise` and cancel (`live-engine.cjs:502-541`)

Refusals: not open (`ORDER_NOT_OPEN`), taken over (`ORDER_TAKEN_OVER`), paused (`TRACKING_STOPPED`), an
extended-session order (`FEATURE_UNAVAILABLE`), a bad price (`INVALID_ORDER`).

Raising a buy's price is new exposure, so `revisionStop` (`:543-564`) applies the saved limits again:
`DISABLED_OR_EXPIRED`, `ACCOUNT_CHANGED`, `DAILY_SESSION_SETUP_REQUIRED`, `INSTRUMENT_NOT_ALLOWED`,
`ORDER_SIZE_LIMIT`, `DAILY_LOSS_RESTRICTED`, `DAILY_TURNOVER_LIMIT`, `CONCENTRATION_LIMIT`, the product rule
(`APPROVAL_REQUIRED`), and the ledger checks the increase (`admitRevision`). Lower prices, sale revisions and
cancellations are never held back.

Before the request a `pendingRevision` marker is saved, so a lost reply leaves the higher price committed. KIS
refusing, or the request limit refusing before sending, restores the order. Any other failure pauses tracking
(`trackingStopped`, `unconfirmed`) until history shows the link (`applyHistory`, `:416-424`). At start-up, a revision
interrupted by a restart is treated the same way (`:21`).

There is no user-facing "cancel" call on the engine other than `revise(id,{cancel:true})`; whether a screen calls it is
not determined (no `live:revise` or `live:cancel` IPC handler appears in the list at `main.cjs:706-715`).

### 3.9 The order tracker — `Automation.trackOrders` (`automation.cjs:1206-1236`)

Runs every 3 seconds while the app runs, auto trading on or not, unless `orderTracking` is off
(`automation.cjs:1964`; default on, `:15`).

- Every 60 s while a market's session is open it reads and stores the day's KIS order history.
- For each of today's open, regular-session app orders (not taken over, not paused, not cancelling):
  - its stop time passed or a cancel condition is met → cancel;
  - otherwise read the order book; move the order to the best bid (sale) or ask (buy) when that is **0.2% or more**
    from its price, never past the AI's bound (`order-pricing.cjs:6`, `:17-21`).
- Failures (`trackFailed`, `:1227-1234`): a logged note at most every 5 minutes; KIS refusing a change triggers a
  reconcile.

### 3.10 Order pricing — `order-pricing.cjs`

Review and conditional orders are never sent at the AI's price. They are priced from a fresh order book: read by the
app within the last 10 s and two-sided (`usableBook`, `:9-10`). The limit is the best ask for a buy and the best bid
for a sale, held at the AI's bound when the market is beyond it (`target`, `:17-19`). Without a usable book the app
retries every 3 s for a minute, then places nothing and asks for a review (`automation.cjs:1198-1204`
`placementPrice`). Korean prices sit on the exchange tick (`agent-desk.cjs:221` `krTick`); U.S. prices on cents.

### 3.11 Several open orders and batches

**The switch.** `severalOpenOrders` (Engine settings, default off; `automation.cjs:15`; `main.cjs:273`). Off: one open
order per market, and the KIS check refuses when anything is open. On:

- only the same stock blocks (`openBlock`, the open-order guard);
- every limit counts the other open orders: the app's own at their unfilled shares and highest possible price, and
  the user's own orders at KIS at their full quantity (`pendingOrders`, `:270-277`; `othersOpen`, `:259-264`);
- the user's own open buys must also fit the funding check beside the new order (`alsoOpen`, `:204-206`);
- an unclear reply no longer stops the market (`:236`).

**Orders per review.** `ordersPerReview` (default 1) applies only when the switch is on in every engine in scope; it
is capped by the model's ceiling and by 20 stocks per market (`automation.cjs:1057-1065`).

**`placeBatch`** (`automation.cjs:1078-1105`): closing orders first (sales, repayments, covers), then openings, each
through `placeOrder`. Before each order it checks for a stop: settings or account changed (`STALE_DECISION`), the
switch turned off (`SEVERAL_OPEN_OFF`), auto trading stopped (`AUTO_TRADING_STOPPED`), or more than 5 minutes since the
decision (`BATCH_LIMIT`; `BATCH_LIMIT_MS`, `:13`).

**ORDER vs STOP** (`order-outcomes.cjs`): every code the order path can throw is in one of two sets.

- **ORDER** (`:12-16`): a refusal of this order only. In a batch the rest go on. For a single order the review
  **completes** and records "Not sent: … reason" or "Rejected by KIS: …" (`automation.cjs:844-847`, `refusedNote`
  `:10-12`). Exceptions: `ORDER_UNCERTAIN` and `BROKER_ORDER_MISMATCH` still fail the review (`UNKNOWN_AT_KIS`, `:9`).
- **STOP** (`:17-21`): the account, settings, engine or broker is in question. The rest of the batch is not sent and
  the review fails; its failure line names the code in words (`automation.cjs:867`).
- A code in neither set stops the batch and fails the review as unknown (`classOf`, `:23`).
- **A batch uses the same words as a single order** (since 1.5.69): an order refused for itself reads "Not sent: …:
  <reason>" or "Rejected by KIS: … (KIS code)" (`refusedNote`); one whose state at KIS is unknown reads "Not
  confirmed: …: <reason>"; a STOP reads "Not sent: …: <reason>; the orders after it in this review were not sent",
  and each later order "…: an earlier order in this review failed (<reason>)". The Console titles are "Order not
  sent", "Order rejected by KIS", "Order not confirmed" and "Order not sent · batch stopped". Only the follow-up
  review's request keeps the codes. `tests/order-outcomes.test.cjs` pins the words for every ORDER and STOP code.

After a failed batch or an unpriced order, one follow-up review is requested, at most one per symbol every 15 minutes
(`automation.cjs:1101`, `:1260`).

### 3.12 Limits (the "policy") — table `live_policy`

Per account and market, set with `configure` (`live-engine.cjs:29-47`; validated by `optional-caps.cjs` and
`loss-policy.cjs`):

| Setting | Field | Unit | Default | Refusal |
|---|---|---|---|---|
| Allowed stocks | `symbols` (≤ 20; empty = any stock) | — | any | `INSTRUMENT_NOT_ALLOWED` |
| Largest order | `maxOrderKRW` | the market's currency, despite the name (inferred: compared with `notional`, `:113`) | none | `ORDER_SIZE_LIMIT` |
| Daily turnover | `maxDailyTurnoverKRW` | same | none | `DAILY_TURNOVER_LIMIT` |
| Per-company share | `maxCompanyPct` | % of the base | none | `CONCENTRATION_LIMIT` |
| Daily loss limit | `lossLimit {mode: off / amount / percent, value}` | | off | see 5.3 |

Each cap is optional: blank means no limit (`optional-caps.cjs:1`). `configure` also needs a funded account
(`NO_FUNDED_BALANCE`; a U.S. account with no dollars counts as funded when won can fund it, `:59-60`).

The row also carries the day's loss basis (`day`, `baseline`, `baselineHigh`, `valuation`, `baselineAt`,
`dayPeakEquity`, `baselinePending`, `baselineLate`, `baselineSnapshot`), which editing limits never changes
(`LIMIT_FIELDS`, `:9`; `:37-46`).

**The base for percentages** (`exposureBase`, `:408-413`): the smaller of KIS's total and the app's own valuation low
bound; for the U.S., plus the won that can fund U.S. buys (`integratedFunding`, `:59`). A buy whose valuation cannot be
read is refused (`RISK_DATA_UNAVAILABLE`); a sale falls back to KIS's total.

### 3.13 What the AI is given — `context()` (`live-engine.cjs:79-92`)

Per market: `environment:'kis'`, `executionEnabled`, `automaticExecutionEnabled`, `market`, `currency`,
`marketSession` (open, status, the session and when it ends), `equity`, `cash` (settled cash where known),
`depositCash`, `pendingSaleProceeds`, `positions` (quantity and total cost), `universe` and `quotes` (≤ 20), `orders`
(open ones with status and last confirmation), `orderReconciliation` (when open-order statuses are unconfirmed),
`risk` (the policy, with the baseline adjusted for deposits and withdrawals), and `productRisk` (leveraged-product
switches and exposure; for Korea the credit paths' real state, `:95-102`).

U.S. only: `buyingPower` (`usd`, `integratedMargin`, `fromKRWUSD`, `brokerUSD`, `basis`), `unsettledKRW`,
`unsettledUncertainKRW`, and `buyingPower.wonRule {rule, roomUSD, asOf}` (`wonRule`, text `WON_RULE`): the shared won
rule a U.S. buy must fit, in words, and the room it leaves, the ledger's U.S. capacity worked from readings already held
(`FundingLedger.capacityFrom`, no KIS request; `roomUSD` null without a Korean reading or a rate). Whether orders go out
automatically is `automaticExecutionEnabled`, for buys and sales alike.

The balance the AI sees is the *accepted* one: while KIS is moving a settlement, the last consistent reading stands in
(`:84-90`; `settlement-check.cjs`).

Not in the context (audit items 9, 12, 14; the first two confirmed by reading `context()`): the 120-second expiry, the
2% price band, the 2% cash cushion, the order window's end time, `lossAction`, and the daily automatic-order count.

### 3.14 The paper engine — `electron/paper-engine.cjs`

A practice account with ₩10,000,000 of simulated cash (`:16`). It shares nothing with KIS.

- Fixed rules (`POLICY`, `:3`): fee 10 bps, slippage 10 bps, price tolerance 50 bps, quotes at most 5 s old, a
  proposal lives 30 s, an order 60 s, fills come 2 shares per new quote. Its `maxOrderKRW`, `maxDailyTurnoverKRW`,
  `maxConcentrationBps` and `maxDailyLossKRW` constants are overridden by the user's optional caps and loss policy in
  `getState` (`:126`); the checks use `caps()` (`:52-58`).
- Refusal codes (returned as the proposal's `reason`, not thrown): `PAPER_PAUSED`, `INSTRUMENT_NOT_ALLOWED`,
  `INVALID_QUANTITY_OR_SIDE`, `STALE_QUOTE`, `STALE_PORTFOLIO_QUOTES`, `PRICE_MOVED`, `ORDER_SIZE_LIMIT`,
  `DAILY_TURNOVER_LIMIT`, `INSUFFICIENT_CASH`, `CONCENTRATION_LIMIT`, `INSUFFICIENT_SHARES` (`check`, `:41-61`); at
  submit `PROPOSAL_NOT_READY`, `PROPOSAL_EXPIRED`, `PORTFOLIO_CHANGED` (`:80`).
- It starts paused after every app start and cancels pending orders ("Restart recovery", `:17`).
- Tables: `paper_account`, `paper_loss_policy`, `paper_caps`, `paper_proposals`, `paper_orders`, `paper_fills`.

---

## 4. Funding and settlement

### 4.1 The funding ledger — `electron/funding-ledger.cjs`

Plain words: Korean won can pay for U.S. buys (KIS "integrated margin"), so the two markets draw on one pool. The
ledger makes sure the app never promises the same won twice. Every buy writes a **commitment** before it is sent, and a
new buy is admitted only if all commitments plus the new one fit the cash.

**Commitment states** (`commitment`, `:51-72`):

| State | When | Amount |
|---|---|---|
| `reserved` | admitted, not yet sent | quantity × per-share cost |
| `open` | Accepted / Partially filled | filled amount + unfilled shares × per-share cost |
| `uncertain` | Submitting, Uncertain, Cancellation uncertain | the whole order |
| `filled-unpaid` | Filled, or Canceled/Rejected with some filled | filled amount **plus the unfilled remainder** |
| `cancel-reported` | Canceled/Rejected with nothing filled (but see `released`) | the whole order |
| `released` | Rejected with nothing filled; or stopped before sending | 0 |

- Per-share cost = the highest price the order may carry × a fee factor from the cost estimate (1% when there is no
  estimate) (`feeFactor`, `perShare`, `:46-47`).
- Sales, and margin buys (funded by the loan), are not in the ledger (`:52`).
- "Committed shares never fall except by a conclusive rejection" (`:66-67`). More shares filled than committed marks
  the account **over-committed**: one alert, and every later buy in both markets is refused with
  `FUNDING_OVERCOMMITTED` (`:68`, `:77`, `:157`). Nothing in the code clears the mark (audit item 11; confirmed: no
  writer sets `overCommitted` back to false).

**Regimes** (`REGIMES`, `:21`; `check`, `:176-186`):

| Regime | Rule | In use? |
|---|---|---|
| `unknown` | won commitments + (U.S. commitments + KIS's reported unsettled U.S. buys + a new U.S. buy) × rate × 1.02 ≤ Korean cash. **Dollar cash is not counted** | **Yes — the only one the app runs** |
| `integrated-usd-first` | only the dollar shortfall is charged to won | no |
| `separate` | each market against its own cash | no |

`main.cjs:277-288` constructs the ledger without a `regime`, so `regime()` is always `'unknown'`
(`funding-ledger.cjs:29`, `:39`). No setting changes it.

**The capacity rule in the user's terms**: a buy in either market must fit in **Korean won cash** (the smaller of
deposit and settled cash, `:143`). A U.S. buy is converted at the rate plus 2% (`BUFFER`, `:19`). This is true even
when the account holds dollars (audit item 4; confirmed at `:183`).

**Inputs** (`inputs`, `:134-147`): both balances must be of this account and environment (`ACCOUNT_CHANGED`) and read
within two minutes (`FUNDING_BALANCE_STALE`); when a rate is needed it must be read within two minutes (`FX_STALE`,
`:178`).

**Releases** — what frees a commitment:

1. `Rejected` with nothing filled (`:60`).
2. Stopped between admission and sending (`release`, `:163`).
3. Start-up: a reservation whose order is still `Ready` ("reserved but never sent", `init`, `:81-89`).
4. **Settled filled part.** U.S.: when the settlement tracker closes a fill by KIS evidence or by age
   (`releaseSettled`, `:101-105`; called from `main.cjs:477`). Korea: by age, 3 Korean business days after the trade
   day, at each balance reading (`releaseAgedKR`, `:110-119`; called from `main.cjs:504`; `business-days.cjs:35-40`).
   Each release is an append-only row in `funding_releases`.

**Known limit (audit item 2; confirmed).** The **unfilled remainder** of a cancelled or expired buy is never released:
`filledCents` excludes it (`:91`) and every release path covers the filled part only. An unfilled day order is saved
`Canceled` on the next day's reconcile (`live-engine.cjs:449`), so its whole amount stays committed until someone
edits the database. Later buys in both markets would be refused "not enough buying power" without saying why. The
fix is designed (implementer note, item 2) and waits for the user's answer.

### 4.2 U.S. buying power — `buying-power.cjs`

KIS reports two figures: foreign currency only, and integrated. Integrated margin is "on" when the integrated figure
is larger by more than $0.01 (`integratedOn`, `:10`). The app's figure (`usBuyingPower`, `:12-19`):

- real cash = dollars + (when integrated) settled Korean cash ÷ rate;
- `usd` = the smaller of KIS's figure and real cash (so a mock account's virtual funds are never used);
- `fromKRWUSD` = the part of it that comes from won.

Wired at `main.cjs:274`. Used at `live-engine.cjs:199` (the cash check), in the percentage base, and in the context.
The decision document calls this check "R17" and the ledger rule "R3".

### 4.3 The exchange-rate source

- First choice: the rate on the U.S. balance — KIS's first published rate on the dollar cash row, else the base rate
  on the holding rows, stamped with the read time (`kis-overseas.cjs:29-35` `usdRate`).
- `automation.fx()` = that rate from the stored U.S. snapshot, else the user's own indicative rate from cost settings,
  which has no timestamp (`main.cjs:297`).
- The ledger accepts a rate only when it is under two minutes old (`funding-ledger.cjs:144-145`), so the user's
  indicative rate never passes a funding check (inferred: its timestamp is null).
- Daily reference rates for tax records come from ECOS and are stored in `fx_rates` (`main.cjs:658`;
  `trading-costs.cjs:89`) — a different use; owned by the costs part.

### 4.4 Settlement modules (what each is for)

These decide what the account is worth while trades settle. Only two of them touch the order path: the loss check
reads their values, and the tracker's "settled" event releases ledger commitments.

| Module | Purpose | Tables |
|---|---|---|
| `integrated-settlement.cjs` | How much of KIS's "U.S. buys awaiting settlement" (reported in won) is known to be won-funded (`FundingTracker`, `fundingStep`); whether a U.S. buy may be awaiting settlement while the U.S. balance cannot be read | `settlement_funding` |
| `settlement-check.cjs` | Detects a Korean balance read while KIS is moving last night's settlement; holds the last consistent reading for up to 3 hours. "Order checks never read the held value" (`:16-17`) | none found in the lines read |
| `valuation.cjs` (`InFlight`) | U.S. fills KIS's balance does not reflect yet; each leaves on KIS evidence or after 3 U.S. business days | `inflight_settlement` |
| `settlement-evidence.cjs` | The append-only evidence ledger behind `InFlight` | `settlement_events`, `settlement_evidence`, `settlement_allocations`, `settlement_k_groups` |
| `settlement-baseline.cjs` | A snapshot of the tracker with each U.S. day's loss baseline, so a cash-free settlement change moves baseline and value together | `settlement_baselines` |
| `funding-transfers.cjs` | Books the won part of each U.S. buy once, as a transfer between the markets, when KIS's figures show it. "the funding check before an order never reads this" (`:16-17`) | `funding_transfers` |
| `broker-raw.cjs` | KIS's own figures as reported: balances (stored when a figure changed; 30 days / 3,000 rows) and its orderable answer at each order check | `broker_balances`, `broker_capacity` |

I read only the header comments and table definitions of `valuation.cjs`, `settlement-evidence.cjs`,
`settlement-baseline.cjs` and `funding-transfers.cjs`; their internal rules belong to the valuation part and are not
determined here.

---

## 5. Risk rules

### 5.1 Leveraged and inverse products — `exposure.cjs`

- **Classification** (`classify`, `:38-46`), first match wins: the user's override (`product_overrides`); a list of
  known U.S. tickers (`US_KNOWN`, `:4`); the security master (a non-ETF/ETN row is standard); the name (Korean
  "레버리지"/"인버스", English "2x", "ultra", "inverse", "bear", "short" but not short-term bonds).
- **Unclassified**: no override, not in the list, no master row and no name → a **buy waits for approval**
  (`check`, `:78`). `propose` passes no name (`live-engine.cjs:117`), so any symbol missing from the security master is
  held (audit item 8; confirmed).
- **Policy per account** (`DEFAULT_POLICY`, `:9`; table `exposure_policy`): leveraged products off; automatic off; cap
  20% of equity; holding-period warning after 10 days; `brokerEligible` not confirmed.
- **At an order** (`check`, `:73-84`): switch off → `LEVERAGED_NOT_ENABLED`; held leveraged value + open leveraged buys
  + this order above the cap → `LEVERAGED_EXPOSURE_LIMIT`; automatic off → the order needs approval. Sales always pass.
- **For the AI** (`leveragedAccess`, `:13-14`): allowed only when the switch is on **and** the user confirmed that KIS
  lets the account buy them. Conditional buy orders are refused otherwise, when armed and again when fired
  (`automation.cjs:1392-1394`, `:1413`, `:1505`).
- U.S.-listed leveraged funds: the review instructions tell the AI they "cannot meet this standard here"
  (`review-instructions.cjs:8`, `:192`), so the U.S. switch has no effect on AI orders (audit item 6, not re-read).

### 5.2 Margin and short selling (Korea, live accounts) — `exposure.cjs`, `credit-paths.cjs`

- Four credit paths: margin buy, margin repayment sale, short sale, cover. **All four are `executable:false`**
  (`credit-paths.cjs:45-50`), each waiting on unconfirmed KIS fields (U1–U5). So no credit order can be proposed
  (`CREDIT_PATH_UNVERIFIED`, `live-engine.cjs:121`), sent (`:138`), or placed (`kis-client.cjs:297`), whatever the
  switches say. A review that decides one gets "Draft only: …" (`automation.cjs:1146`).
- The switches still exist and can be on (`exposure.cjs:9`): margin (cap 30% of equity as loans, collateral floor
  140%), short (cap 20% gross, stop 15%, 90 days). Their limits (`MARGIN_NOT_ENABLED`, `MARGIN_LIMIT`,
  `SHORT_NOT_ENABLED`, `SHORT_LIMIT`, `checkCredit`, `:91-106`) are unreachable today (inferred from the above).
  `main.cjs:322` refuses saving margin or short settings for the U.S. account (`FEATURE_UNAVAILABLE`).
- **Lots** (`credit-paths.cjs:18-39`): a closing order may take only what is free in its lot after closing orders
  already waiting on it (`EXCEEDS_LOT`, `NO_SUCH_LOT`). This also applies to plain cash sales, so two orders never sell
  the same shares.
- `effectOf` (`:12-15`) says whether an order opens or closes exposure; the loss rules and the daily order cap use it.
- Screen text beside the switches: quoted in the implementer note, items 5–6 (`src/ShortLeverage.tsx:39-46`; not
  re-read).

### 5.3 The daily loss limit and its responses

**Measuring** (`live-engine.cjs:287-407`):

- The day's **baseline** is taken from the app's valuation at the first reading of the trading day
  (`observeBalance`, `:70-78`; `basisFrom`, `:342-344`), adjusted for deposits and withdrawals (`adjustedBaseline`,
  `flows`, `:309-325`) and, for the U.S., for cash-free settlement corrections (`settlement`, `:354-361`).
- `lossOf` (`:365-407`) evaluates the loss under several scenarios (low bounds, high bounds, uncertain money changes
  counted). Result: `breached` (every scenario), `ambiguous` (some), `unavailable` (something could not be read),
  `late` + `restrictedForDay` (the baseline was taken after the day's first reading failed, with a limit set).
- With the limit `off`, none of the restrictions below applies (`:369`, `:379`, `:404`).

**Responses** — setting `lossAction` (Engine settings → Guardrails; `guardrails.cjs:3`; default `review`;
`src/Guardrails.tsx:11`):

| State | `review` ("Review more often, keep trading") | `block-buys` | `stop` |
|---|---|---|---|
| Breached | Emergency mode: reviews every 60 s (`automation.cjs:274`, `:1984`). Orders are **not** blocked | Same, plus AI opening orders are recorded but not proposed: "Guardrail: new buys are blocked…" (`:1140`); conditional buys rejected (`:1499`) | Auto trading stops for the day (`:1934` → `trip('auto-stopped')` → `auto-launch.stop`); Start refuses to restart (`auto-launch.cjs:13`) |
| Ambiguous | no restriction | openings restricted (`:1143`, `:1500`) | openings restricted |
| Unavailable | **openings restricted whatever the response** (`:1142`, `:1501`; engine `DAILY_LOSS_RESTRICTED`, `live-engine.cjs:218`) | same | same |
| Late baseline | **automatic openings restricted for the rest of the day** (`:1141`, `:1502`) | same | same |

Sales, repayments and covers are never held back. The user's own manual submissions are not held by
`DAILY_LOSS_RESTRICTED` (`live-engine.cjs:213-218`: automatic only).

The review instructions say the threshold "is not an order prohibition" while `lossAction` is not in the context
(audit item 9; the instruction line not re-read).

### 5.4 Guardrails — `guardrails.cjs` (tables `guardrail_events`, `review_failures`, `auto_order_slots`)

| Setting | Default | Effect |
|---|---|---|
| `maxAutoOrdersPerDay` (0–100; 0 = no cap) | 0 | Each automatic send takes a durable slot first (`reserveSlot`, `:23-24`). At the cap an opening order is not sent: "Proposal awaits manual approval" (`automation.cjs:1178`, `:1513`). Closing orders are admitted at the cap. A slot is released only when the engine's record shows nothing was sent (`settleAutoSlot`, `automation.cjs:1542-1544`). Counted per Seoul day across both markets and both routes |
| `maxConsecutiveFailures` (0–20; 0 = never) | 0 | After that many failed reviews in a row, auto trading stops (`automation.cjs:887`) |
| `lossAction` | `review` | 5.3 |

A guardrail event is recorded and alerted once per kind per day, except stops (`trip`, `automation.cjs:320-325`).

### 5.5 Extended-session limits

- U.S. pre- and after-market orders are never automatic (`EXTENDED_APPROVAL_REQUIRED`; `market-sessions.cjs:41`
  `approval:true`). The order stays `Ready` — and expires after 120 s like any other (3.6).
- Every extended-session order is capped: it plus the app's other open extended orders must be within
  `extendedMaxOrderPct` (default 5%) of the base (`EXTENDED_SIZE_LIMIT`; `live-engine.cjs:178`; `main.cjs:271`).
- Extended-session orders cannot be revised or cancelled by the app (`live-engine.cjs:506`) and are not tracked
  (`automation.cjs:1216`).
- Trailing stops move only on regular-session quotes (`trailing-stops.cjs:27-28`).

### 5.6 Fixed constants (no setting)

| Constant | Value | Where |
|---|---|---|
| Proposal lifetime | 120 s | `live-engine.cjs:126` |
| Ticket lifetime | 15 s | `order-tickets.cjs:6` |
| Queue hold limit | 30 s | `kis-service.cjs:59` |
| Price band at the KIS check | 2% from the quote | `kis-client.cjs:274`; `kis-overseas.cjs:133` |
| Cash cushion at the KIS check | 2% | `kis-client.cjs:288`; `kis-overseas.cjs:133` |
| Ledger rate buffer | 2% | `funding-ledger.cjs:19` |
| Balance and rate freshness for funding | 2 minutes | `funding-ledger.cjs:19` |
| Shares per order | 1–10,000 | `live-engine.cjs:111` |
| U.S. minimum price | $1, whole cents | `live-engine.cjs:12` |
| Last order before the close | KR 15:20; U.S. 10 minutes before | 2.8 |
| Tracker revise threshold | 0.2% | `order-pricing.cjs:6` |
| Order book age | 10 s | `order-pricing.cjs:6` |
| Batch limit | 5 minutes from the decision | `automation.cjs:13` |
| Settlement age | 3 business days | `business-days.cjs:8` |

---

## 6. Conditional orders and stops

### 6.1 What they are — `agent-desk.cjs` (table `conditional_orders`)

A conditional order is an instruction the AI arms with the tool `set_conditional_order`: "when these conditions are
met, place this order". Conditions are formulas compared with numbers (at most 4; `all` or `any`). Purposes:
`stop_loss`, `take_profit`, `entry`, `exit`, `other` (`ORDER_TOOL`, `:10`). It is **not** an order at KIS: nothing
exists at the broker until it fires. While the app is closed or auto trading is off, it is not watched.

**Settings** (`COND_DEFAULTS`, `:5`; Engine settings):

| Setting | Default | Meaning |
|---|---|---|
| `conditionalOrders` | off | The AI may arm them |
| `conditionalAutoSubmit` ("Submit them automatically", `src/EngineSettings.tsx:103`) | off | A fired order is sent without asking. Off: it becomes a proposal that waits for approval — for 120 s |
| `conditionalMaxActive` | 5 | Armed at once |
| `conditionalMaxOrderPct` | 10 | Largest buy, % of equity |
| `conditionalMaxSlippagePct` | 2 | Furthest the placement price may be from the quote |
| `conditionalMaxHours` | 168 | Longest life |
| `trailingStops` | off | Trailing stops allowed and tracked |

**Statuses**: `armed` → `firing` → `submitted` (sent), `proposed` (waits for approval), `rejected`, `cancelled`,
`expired`. An order stuck in `firing` for over two minutes goes back to `armed` (`expire`, `:39-42`).

### 6.2 Arming (`setOrder`, `agent-desk.cjs:104-168`)

Refused with a sentence the AI reads: the feature is off; the symbol is outside the review's universe; bad side or
quantity; a limit more than 50% from the price; an expiry outside 1–`conditionalMaxHours`; too many armed; a sale that
would put more shares under armed orders of that purpose than are held (plus those being bought). Sending the identical
order again **renews** it (its expiry moves). `replaces` swaps one armed cash-share stop loss for another in one
transaction, so the position is never without a stop in between (`:119-135`, `:163-167`). Credit-lot orders need an
executable and automatic credit path, so none can be armed today (`automation.cjs:1424-1432`). Paper accounts cannot
arm any (`automation.cjs:1412`).

### 6.3 Plan-linked stops (`followPlan`, `automation.cjs:1613-1636`)

When a review's Buy carries a plan with a stop price and conditional orders are on, the app arms a stop loss
`price("SYM") <= stopPrice` for the bought quantity **when the purchase is proposed**, linked to it (`linkedBuy`). The
plan itself is saved as a note. Rules:

- it sells at most what its purchase filled; it never sells shares held before (`automation.cjs:1464-1469`);
- when the purchase ends unfilled or is refused before sending, the stop is cancelled at once ("Not needed: the
  purchase was not sent / did not fill"); partly filled, it is resized (`syncLinkedStops`, `:1603-1607`, every 5 s;
  `endUnsent`, `:1599-1600`);
- if the stop could not be armed, the purchase still goes ahead; the failure is logged, alerted, stored in
  `plan_stop_failures` and shown to the next review for a day (`:1633-1635`; `agent-desk.cjs:172-181`).

### 6.4 Trailing stops — `trailing-stops.cjs`

A trailing stop is an armed cash-share Sell (`stop_loss` or `take_profit`) with the single condition
`price("SYM") <= floor` and a `trail`. Its level follows the price up and never comes down:
`level = max(floor, previous level, high − distance)`, where the distance is a percentage (0.5–50) or a multiple
(0.5–10) of the 14-day ATR fixed at arming (`rawLevel`, `:23`; limits `agent-desk.cjs:17`, `checkTrail` `:91-103`).

- The level is written into the condition's value, so every reader sees the current level (`:6-7`).
- The high moves only on fresh **regular-session** quotes (≤ 60 s Korea, ≤ 90 s U.S.) and only after **two consecutive
  distinct quotes** at or above it; the lower of the two counts (`usable`, `step`, `:27-28`, `:50-72`).
- `activateAt`: the trail starts only once that price is reached.
- A plan stop with a trail starts trailing from its purchase's fill price (`startFromFill`, `:43-45`).
- **Catch-up** after a gap of over 2 minutes (the app was closed, auto trading was off): daily highs since tracking
  stopped are applied, never the arming or fill day's bar; unreadable bars → retry in 5 minutes; a Korean capital change
  filed in the gap → no catch-up, with the reason (`catchUp`, `:96-110`; `automation.cjs:1577-1591`).
- With `trailingStops` switched off later, existing ones stay armed at their current level as fixed stops
  (`trailView`, `agent-desk.cjs:28-33`).

### 6.5 Watching and firing

**Watching** (`Automation.tick`, `automation.cjs:1955-1962`): every 5 seconds, only while conditional orders are on,
auto trading is on and armed for this run, and the scope is not paper (`conditionalMonitoringActive`, `:534`). Trailing
levels move first; then each armed order's conditions are checked on live quotes; the first one met fires. One fires at
a time.

**Firing** (`fireConditional`, `automation.cjs:1433-1539`):

1. Fresh account read through the engine's `context`. Market closed → stays armed, checked again in 5 minutes.
2. Conditions re-checked on the fresh quotes; no longer met → stays armed.
3. A linked stop: capped at what its purchase filled; waits while that is open.
4. Priced from the order book with `limitPrice` as the bound; no book for a minute → stays armed, a review is asked.
5. Placement price more than `conditionalMaxSlippagePct` from the quote → **rejected**.
6. A sale: nothing held → cancelled as "Not needed"; quantity capped at shares held and free.
7. A buy: above `conditionalMaxOrderPct` of equity → rejected; cash below notional × 1.005 → rejected; the loss rules
   of 5.3; the leveraged-entry rule.
8. `engine.propose`, marked `madeBy:'conditional'`.
9. Sent automatically only when `conditionalAutoSubmit` **and** `autoSubmit` are on, the market's automatic switch is
   on, the proposal needs no approval, and a daily slot is free. Otherwise status `proposed`: "Not executed: proposal …
   awaits your approval" (`:1509-1513`).
10. Outcomes: `submitted`; unclear reply → `submitted`, marked unconfirmed, never retried; KIS refusal → `rejected`;
    a passing refusal before KIS (rate limit, timeout, expired ticket) → armed again, up to 3 attempts a minute apart,
    then `rejected`; another order being sent → checked again in 10 s.

A rejected stop loss sends an alert ("The position is not protected until a new one is armed", `:1435`), and the
holding is listed as **unprotected** to the user and to every later review until stops cover it, the shares are gone,
or the user dismisses it (`unprotected`, `agent-desk.cjs:194-205`).

**Expiry and cancelling**: an armed order expires at `expiresAt` (`expire`, `:41`); the AI cancels with
`action:'cancel'`; the user with `desk:cancel-order` (`main.cjs:441`; `cancelOrder`, `agent-desk.cjs:208`).

Review triggers (`agent_triggers`) and notes (`agent_notes`, `agent_note_history`) live in the same file; they
schedule reviews and carry context but never trade (`agent-desk.cjs:8-9`).

---

## 7. Walk-throughs: from a decision to a filled order

### 7.1 Korea — an AI review buys 10 shares of 005930

1. **Decision.** The review ends with Buy 10 005930 and a plan (stop 68,000). `Automation.placeOrder`
   (`automation.cjs:1120`) runs for it.
2. **Guardrails first.** Loss state read live (`:1129-1143`); trading on for Korea (`:1148`); the market open
   (`:1152`, else the decision is kept as a pending decision); the AI's execution bounds valid (`:1156-1157`).
3. **Price.** The order book is read; the limit is the best ask, held at the AI's bound (`placementPrice`, `:1198`).
4. **Proposal.** `live.propose` saves a `Ready` order (3.4). It is marked `madeBy:'review'` with its bounds (`:1171`).
5. **Plan stop.** `followPlan` saves the plan note and arms a linked stop loss (6.3).
6. **Automatic?** Needs the app setting `autoSubmit`, the Korean engine's automatic switch, a `Ready` proposal, and an
   open session (`:1174`); then a daily slot (`:1177`). Otherwise the proposal waits: "Korea automatic execution is off.
   Proposal awaits manual approval." (`:1194`).
7. **Send.** `autoSubmit` → `send` (3.5): limits; the U.S. balance is read for the ledger; the order takes the queue
   hold; KIS check (session, tick, 2% band, KIS's buying power with 2% cushion, open orders) → ticket; product rule;
   company share; cash; ledger admits and reserves; loss restriction; saved `Submitting`, `sentBy:'auto'`.
8. **Placement.** `place-order` with the ticket → KIS returns an order number → `Accepted`. The "Order submission"
   event is logged with the timings (`:1185`).
9. **Tracking.** Every 3 s the tracker moves it to the best ask when that is 0.2% or more away, never above the bound.
10. **Fill.** Within 30 s a reconcile reads KIS history; `applyHistory` sets `Filled`, `fillPrice`, `filledObservedAt`
    and recomputes costs. The ledger commitment becomes `filled-unpaid`.
11. **After.** The linked stop now protects the 10 shares; if it trails, the trail starts at the fill price. KIS's own
    fee figure replaces the estimate within 15 minutes (`refreshCharges`). Three Korean business days later the ledger
    releases the commitment by age.

### 7.2 U.S. — an AI review buys 3 shares of NASD:NVDA

Steps 1–5 are the same with the U.S. engine (`usLive`), U.S. prices in cents and the New York trading day.

6. **Automatic?** Same conditions with the U.S. engine's automatic switch.
7. **Sending:** `send` runs as for Korea, with these U.S. specifics:
   - the **Korean** balance is read first for the ledger;
   - KIS check: regular session open (or an enabled extended session), limit within 2% of the quote, KIS's buying
     power (integrated when KIS shows it) with a 2% cushion, no open order (of that stock);
   - cash check against `buyingPower.usd` (KIS's figure capped at real cash);
   - ledger, `unknown` regime: won commitments + (U.S. commitments + reported unsettled U.S. buys + this buy) × rate ×
     1.02 must fit **Korean won cash**;
   - a pre- or after-market order stops here and waits for approval.

   A refusal at any of these is "Not sent" with its reason (for example `INSUFFICIENT_CAPACITY`, "there was not enough
   buying power"), and the review completes. (Before 1.5.69 every automatic U.S. buy was refused here with
   `INTEGRATED_MARGIN_AUTOMATION_BLOCKED`.)
8. **Placement** on the `order` endpoint → `Accepted`.
9. **Tracking** only while the U.S. regular session is open (KIS revises only then).
10. **Fill** found by reconcile from U.S. order history (`fillPrice` from `ft_ccld_unpr3`).
11. **After.** The fill enters the settlement tracker (`InFlight`); KIS's "awaiting settlement" amount rises; when
    KIS's figures show the won part it is booked as a transfer (`funding-transfers.cjs`). When the tracker closes the
    fill (evidence or 3 U.S. business days) the ledger releases the filled part (`main.cjs:477`). Fees are replaced by
    KIS's settled trade history when final (`refreshCharges`, `live-engine.cjs:464-484`; live accounts only).

A U.S. **sale** has always gone out automatically: neither the removed block, the ledger nor the cash check applies
to sales.

---

## 8. Every rule that can refuse or hold an order

Class: **O** = ORDER (this order only; a single order's review completes with "Not sent"), **S** = STOP (the rest of a
batch is not sent; the review fails), per `order-outcomes.cjs`. "Words" are from `activity-today.cjs:8-36`
(`NOT_SENT`), shown in Console, Home and Activity and told to the next review. "Setting" names what the user controls;
"fixed" means nothing does. The user's own ticket shows the code through `liveAction` / the `us:` handler
(`main.cjs:705`, `:334`); a code not on those allowlists reads `KIS_ORDER_FAILED` (Korea) or a `US_*` code (U.S.). How
`src/` words each code on the ticket: not determined.

### 8.1 Refusals

| Code | Class | Condition | Where | Setting | Words |
|---|---|---|---|---|---|
| `INVALID_ORDER` | O | Bad shape; off-tick or halted (KR); price < $1 (US); wrong credit side | `live-engine.cjs:109-111`; `kis-client.cjs:265,273`; `kis-overseas.cjs:133` | fixed | "the order was not valid" |
| `KIS_TRADING_DISABLED` | S | Market's trading is off at `propose` | `:112` | the market's trading switch / Start | "trading for this market is switched off" |
| `INSTRUMENT_NOT_ALLOWED` | O | Stock not on the allowlist | `:112`, `:546` | allowed stocks | "this stock is not allowed for automatic orders" |
| `ORDER_SIZE_LIMIT` | O | Notional above the cap | `:113`, `:547` | largest order | "it is above the order size limit" |
| `LIMIT_CHANGED` | O | Allowlist/cap/day changed between proposal and send; credit type changed | `:144`, `:186`, `:303` | — | "its limits changed while it was being sent" |
| `DAILY_TURNOVER_LIMIT` | O | Today's orders (cancelled ones included, at full notional) + this one above the limit | `:145-146`, `:552` | daily turnover | "the day's turnover limit is reached" |
| `CONCENTRATION_LIMIT` | O | Stock would exceed the per-company share (buys) | `:194`, `:559` | per-company share | "it would go over the per-company limit" |
| `LEVERAGED_NOT_ENABLED` | O | Leveraged/inverse buy with the switch off | `exposure.cjs:80` | Short & leverage → leveraged ETFs | "leveraged and inverse products are off" |
| `LEVERAGED_EXPOSURE_LIMIT` | O | Leveraged value would exceed the cap | `exposure.cjs:82` | leveraged cap (default 20%) | "it would go over the leveraged-product limit" |
| `MARGIN_NOT_ENABLED`, `MARGIN_LIMIT`, `SHORT_NOT_ENABLED`, `SHORT_LIMIT` | O | Credit rules | `exposure.cjs:97-104` | margin / short settings | "margin trading is off" etc. Unreachable today (5.2) |
| `CREDIT_PATH_UNVERIFIED` | O | Any Korean credit order | `:121`, `:138`; `kis-client.cjs:297` | **fixed; the Allow switches do not control it** | "its credit path is not verified" |
| `EXCEEDS_LOT`, `NO_SUCH_LOT` | O | A closing order larger than what is free in its lot | `credit-paths.cjs:34,39` | fixed | "it is more than the shares free in its lot" / "its lot was not found" |
| `FEATURE_UNAVAILABLE` | O | Credit on mock or in an extended session; revising an extended-session order; daytime on mock | `:110`, `:506`; `kis-client.cjs:264,268`; `kis-overseas.cjs:136` | fixed | "this account does not offer it" |
| `RISK_DATA_UNAVAILABLE` | S | A buy while the app's valuation cannot be read | `:413` | fixed | "the risk data could not be read" |
| `KIS_ORDER_BUSY` | O | Another order is being sent in this market | `:133`, `:443`, `:503` | fixed | "another order was being sent" |
| `UNKNOWN_ORDER` | S | No such order | `:135` | — | "the order was not found" |
| `APPROVAL_REQUIRED` | O | Wrong or missing confirmation phrase; a revision that now needs product approval | `:140`, `:563` | — | "it needed your approval" |
| `DISABLED_OR_EXPIRED` | S | Trading off, or over 120 s since the proposal | `:141`, `:195`, `:301`, `:544` | fixed (120 s) | "trading was switched off or the order expired (2 minutes after it was made)" |
| `RECONCILIATION_REQUIRED` | O | Another order is open or unclear (several open off); same stock unclear or history unreadable (on) | `:142-143` | several open orders | "open orders must be confirmed with KIS first" |
| `SESSION_CLOSED` | O | Outside the order window; the extended session ended before placement | `kis-client.cjs:253,259`; `kis-overseas.cjs:133,135,142`; `kis-worker.cjs:38,63` | extended-session switches | "the market was closed" |
| `PRICE_MOVED` | O | Limit more than 2% from the quote | `kis-client.cjs:274`; `kis-overseas.cjs:133` | fixed | "the price moved past its limit" |
| `INSUFFICIENT_CAPACITY` | O | KIS's buying power or orderable quantity (2% cushion); the engine's cash check; the ledger's rule | `kis-client.cjs:284-289`; `kis-overseas.cjs:133`; `:200`; `funding-ledger.cjs:158,171` | fixed | "there was not enough buying power" (one sentence for all four causes) |
| `OPEN_BROKER_ORDERS` | O | KIS lists an open order (any; or of the same stock) | `broker-open-orders.cjs:14-15` | several open orders | "another order for it is open at KIS" |
| `ACCOUNT_CHANGED` | S | Another account or environment connected | `:83`, `:162`, `:302`; `funding-ledger.cjs:139` | — | "another KIS account was connected" |
| `EXTENDED_SIZE_LIMIT` | O | Extended-session orders above the cap | `:178` | largest extended-session order (5%) | "it is above the extended-session size limit" |
| `DAILY_SESSION_SETUP_REQUIRED` | S | The saved policy's day is not today | `:185`, `:545` | — (switch trading on again) | "today's trading session is not set up yet (switch the market's trading on again)" |
| `FUNDING_BALANCE_STALE` | O | A balance for the funding check is missing or over 2 minutes old | `funding-ledger.cjs:141-143` | fixed | "the cash reading was too old to check its funding" |
| `FX_STALE` | O | No rate under 2 minutes old | `funding-ledger.cjs:178` | fixed | "the exchange rate was too old" |
| `FUNDING_OVERCOMMITTED` | S | KIS once reported more shares filled than committed; never clears | `funding-ledger.cjs:157,169` | none; no screen to clear it | "KIS reported more shares filled than the app held funds for, so new buys stop until that is reviewed" |
| `DAILY_LOSS_RESTRICTED` | O | An automatic opening while the loss check is unavailable or the day's baseline was late | `:218`, `:291-293`, `:550` | applies only with a loss limit set | "the daily loss limit restricts new purchases" |
| `AUTO_KIS_DISABLED` | S | `autoSubmit` with the market's automatic switch off | `:565` | the market's automatic switch | "automatic orders are off for this market". `placeOrder` does not call `autoSubmit` when the switch is off (`automation.cjs:1174`), so this is a backstop |
| `INTEGRATED_MARGIN_AUTOMATION_BLOCKED` | O | No longer thrown (removed in 1.5.69); old records carry it | — | — | "automatic U.S. purchases were off then (integrated margin not verified)" |
| `BROKER_REJECTED` | O | KIS refused the placement | `kis-client.cjs:315`; `kis-overseas.cjs:137` | — | "Rejected by KIS: … (KIS code)" |
| `ORDER_NOT_SENT` / `TICKET_EXPIRED` / `RATE_LIMITED` | O | The request limit refused the placement before it left; the ticket was over 15 s old | `:232`; `order-tickets.cjs:9` | fixed | "the KIS request limit was reached" / "the check with KIS expired before it was sent". A review follows after `retryAt` |
| `ORDER_UNCERTAIN` | O (but the review fails) | Placement reply unclear | `:233` | — | "KIS's reply was unclear, so it is not confirmed" |
| `BROKER_ORDER_MISMATCH` | O (but the review fails) | Linking an unclear order to a KIS order that differs | `:574` | — | "KIS reported a different order" |
| `KIS_NOT_CONNECTED`, `BROKER_UNAVAILABLE`, `AUTH_FAILED`, `REQUEST_FAILED`, `INVALID_RESPONSE`, `INCOMPLETE_BALANCE`, `US_BALANCE_INVALID_RESPONSE` | S | KIS not connected, not answering, or a reply the app cannot read | `:23`; `kis-service.cjs:23,43,72`; clients | — | each has a sentence (`activity-today.cjs:24-33`) |
| `US_REQUEST_FAILED` and other `US_*` stage codes | **neither set → unknown** | A U.S. read failed for a reason not on the public list | `us-errors.cjs:7-8` | — | fails the review as an unknown error; KIS failures are named "KIS {code} on {request}" (`automation.cjs:868`) |
| `STALE_DECISION`, `AUTO_TRADING_STOPPED`, `SEVERAL_OPEN_OFF`, `BATCH_LIMIT` | S | Checked before each order of a batch | `automation.cjs:1082-1092` | — | "the account or saved settings changed during the review" etc. |
| `ORDER_NOT_OPEN`, `ORDER_TAKEN_OVER`, `TRACKING_STOPPED` | S | Revise/cancel of an order that is closed, taken over in KIS, or paused | `:505`, `:508` | — | sentences at `activity-today.cjs:35` |
| `NO_FUNDED_BALANCE`, `ACTIVATION_REQUIRED`, `INVALID_LIMITS`, `INVALID_LOSS_LIMIT` | S (the last is in neither set) | Switching trading on: no funds, wrong phrase, bad limits | `:32-34`; `loss-policy.cjs:1` | — | shown on the trading page; wording in `src/` not determined |

### 8.2 Holds (nothing is refused; the order waits or is not made)

| Hold | Condition | Where | Setting | What the user sees |
|---|---|---|---|---|
| Product approval | A leveraged/inverse buy with "automatic" off; an **unclassified** product | `exposure.cjs:78,83`; `approvalNow`; `holdForApproval` | leveraged "automatic"; none for unclassified | "Waiting for your approval" (`src/LiveTrading.tsx:79`); the reason is stored, not shown; expires after 120 s |
| Extended approval | U.S. pre/after-market + automatic | `:176` | fixed | same |
| Daily automatic-order cap | Opening orders at the cap | `automation.cjs:1178`, `:1513` | `maxAutoOrdersPerDay` | "Guardrail: the daily limit of N automatic orders is reached. Proposal awaits manual approval." |
| App `autoSubmit` off / market automatic off | — | `automation.cjs:1174`, `:1194` | Start / the switches | "… automatic execution is off. Proposal awaits manual approval." |
| Fired conditional without auto-submit | `conditionalAutoSubmit` off | `automation.cjs:1509-1513` | "Submit them automatically" | "Not executed: proposal … awaits your approval" |
| Loss guardrails (not proposed at all) | 5.3 | `automation.cjs:1140-1143` | loss limit + `lossAction` | "Guardrail: new buys are blocked / restricted…" |
| Credit draft | Any credit decision | `automation.cjs:1146` | fixed | "Draft only: …" |
| Execution off | The market's trading is off | `automation.cjs:1148` | Start | "… trading session is off. Recommendation recorded…" |
| Market closed | — | `automation.cjs:1152` | — | "kept as a pending decision and reassessed when it opens" (`pending_decisions`) |
| Invalid or met restrictions | The AI's bound/stop time/cancel condition invalid or already met | `automation.cjs:1156-1159`, `:1242-1257` | — | "Execution withheld: …" |
| No order book | No usable book for a minute | `automation.cjs:1158`, `:1203` | — | "No usable order book … A review decides again." |
| Lot too small | A closing order above its free lot | `automation.cjs:1163-1165` | — | "Not proposed: …" |

In every hold that leaves a `Ready` proposal, the 120-second expiry applies: the user must approve within two minutes
of the proposal's creation or it reads "Not sent: it expired unapproved".

---

## 9. Recent decisions

### 9.1 Automatic U.S. buys

**Decided 2026-11-19** (`artifacts/reviews/2026-11-19-us-auto-buys/decision.md`; the user: "Yes"), **in 1.5.69.** The
block on automatic U.S. buys (spec R15, `INTEGRATED_MARGIN_AUTOMATION_BLOCKED` in `autoSubmit`, since 1.5.48) is
removed. The existing U.S. automatic switch, turned on by Start auto trading (`auto-launch.cjs`), governs buys and
sales alike. There is no separate setting, so automatic U.S. sales cannot be had without automatic U.S. buys.

- **The checks on a U.S. buy, automatic or manual:** KIS's buying power capped at real cash (R17,
  `buying-power.cjs`), then the shared ledger under the `unknown` regime (R3): Korean won cash at the rate plus 2%, together
  with Korean buys and unsettled U.S. buys. Dollar cash adds no ledger room. No regime is ever verified, and U6–U9 stay
  disabled. Pre- and after-market buys still wait for approval. A U.S. conditional entry goes through the same
  `autoSubmit`.
- **What the AI reads:** `automaticExecutionEnabled` per market (the one fact for whether orders go out), and on the
  U.S. account `buyingPower.wonRule {rule, roomUSD, asOf}` (3.13). The combined context's objective adds that every
  U.S. buy must also fit the won rule. The scout's accounts carry both, and its note (`opportunityNote`) names any
  market whose automatic switch is off. `automaticPurchases` and `AUTO_US_BUY_OFF` are gone.
- **What the user sees:**
  - The U.S. switch reads "Allow automatic … orders: buys and sales the AI decides are sent without asking you". When
    on, it reads "Automatic orders are on: buys and sales".
  - Under it: "U.S. buys are counted against your won cash. Limits: …", each U.S. limit as set or not set, with More.
  - Start adds "U.S.: buys and sales are sent automatically, each counted against your won cash; limits: …".
- **Old records:** `INTEGRATED_MARGIN_AUTOMATION_BLOCKED` stays in ORDER and reads "automatic U.S. purchases were off
  then (integrated margin not verified)".

### 9.2 Committed in `9c89338` and its parents (confirmed in the code)

- A single order refused with an ORDER code completes the review as "Not sent" (`automation.cjs:839-847`).
- A purchase refused before KIS ends `Rejected` with its code at once, and its linked stop closes (`endUnsent`).
- U.S. order refusals keep their codes (`us-errors.cjs:5-7`); every ORDER and STOP code has words
  (`activity-today.cjs`).
- Every failed KIS request is recorded (`kis_failures`).
- `sentBy` and `madeBy` on the order record.

### 9.3 Open items stated as current behaviour

From the audit, each confirmed above unless marked:

1. A cancelled or expired buy's unfilled amount stays committed for good (4.1).
2. Anything held for approval expires 120 s after it was made (3.6).
3. An unclassified product is held, and why is not shown (5.1).
4. Korean credit paths cannot place orders although their switches can be on (5.2).
5. U.S. leveraged funds are not bought by the AI, by instruction (audit, not re-read).
6. With the default `conditionalAutoSubmit:false`, a fired stop is a two-minute proposal, not an order (6.1).
7. `FUNDING_OVERCOMMITTED` never clears (4.1).
8. Daily turnover counts cancelled orders at full notional (`live-engine.cjs:145`).
9. The model is not told the fixed constants of 5.6, `lossAction`, or the daily order count (3.13).

---

## 10. Database tables this part owns

All are created with `CREATE TABLE IF NOT EXISTS` by the module named; most hold one JSON `payload` per row.

| Table | Created in | Holds |
|---|---|---|
| `live_policy` | `live-engine.cjs:19` | Per account+market: limits and the day's loss basis |
| `live_intents` | `live-engine.cjs:19` | Every app order (proposal to final), both markets |
| `broker_orders` | `live-engine.cjs:19` | Every order KIS lists for the account per day, whoever placed it |
| `funding_commitments` | `funding-ledger.cjs:30` | One commitment per buy |
| `funding_events` | `funding-ledger.cjs:30` | History of commitment changes and each admission's check (need, have, rate) |
| `funding_meta` | `funding-ledger.cjs:30` | `bootstrapped` marker |
| `funding_releases` | `funding-ledger.cjs:34-36` | Append-only (triggers refuse update/delete): what settled buys released |
| `exposure_policy` | `exposure.cjs:34` | Leveraged / margin / short settings per account |
| `product_overrides` | `exposure.cjs:34` | The user's product classification per symbol |
| `guardrail_events` | `guardrails.cjs:8` | Guardrail trips |
| `review_failures` | `guardrails.cjs:8` | Failed reviews per day |
| `auto_order_slots` | `guardrails.cjs:8` | One slot per automatic send (reserved / used / released) |
| `conditional_orders` | `agent-desk.cjs:35` | Conditional orders, with any trail |
| `plan_stop_failures` | `agent-desk.cjs:35` | Plan stops that could not be armed |
| `agent_triggers`, `agent_notes`, `agent_note_history` | `agent-desk.cjs:35` | Review triggers and notes (same module; they never trade) |
| `kis_failures` | `main.cjs:261` | The last 200 failed KIS requests |
| `kr_calendar` | `main.cjs:85` | KIS's Korean holiday calendar |
| `broker_balances`, `broker_capacity` | `broker-raw.cjs:19,42` | KIS's own figures; its orderable answer at each order check (30 days / 3,000 rows) |
| `settlement_funding` | `integrated-settlement.cjs:33` | Last U.S. reading's unsettled/won-funded amounts per account |
| `funding_transfers` | `funding-transfers.cjs:79` | The won part of U.S. buys booked as transfers (shared with the valuation part) |
| `inflight_settlement` | `valuation.cjs:238` | U.S. fills in flight (owned by the valuation part; listed because its close releases ledger commitments) |
| `settlement_events`, `settlement_evidence`, `settlement_allocations`, `settlement_k_groups` | `settlement-evidence.cjs:34-39` | The settlement evidence ledger (valuation part) |
| `settlement_baselines` | `settlement-baseline.cjs:28` | Tracker snapshot per U.S. day's loss baseline |
| `paper_account`, `paper_loss_policy`, `paper_caps`, `paper_proposals`, `paper_orders`, `paper_fills` | `paper-engine.cjs:10-15` | The practice account |
| `pending_decisions` | `pending-decisions.cjs:11` | Decisions kept for a closed market (read by `placeOrder`; internals not read) |

In memory only (lost at restart): each engine's `enabled`/`autoEnabled`, `reconcileHealth`, `riskBalance`; the
worker's tickets; the service's queue, cooldown and last-200 failures list; the trailing-stop two-quote memory
(`trailMemory`).

---

## 11. Not determined

1. How often the U.S. balance and quotes are refreshed (the timer around `automation.refreshUS`).
2. Whether any screen lets the user cancel or revise an open app order (no `live:revise`/`live:cancel` handler in
   `main.cjs:706-715`; the rest of `main.cjs` and `preload.cjs` were not searched for one).
3. Whether `Cancellation uncertain` is ever written by code outside `electron/` or by an older version; nothing in
   `electron/` assigns it.
4. The exact words each refusal code gets on the user's own order ticket (`src/`), and all screen text for limits,
   switches and the Short & leverage page — only `src/Guardrails.tsx` was read in full.
5. The review-instruction sentences cited by the audit (`review-instructions.cjs:8`, `:116`, `:192`): not re-read.
6. The internal rules of `valuation.cjs` (`InFlight`), `settlement-evidence.cjs`, `settlement-baseline.cjs` and
   `funding-transfers.cjs` beyond their header comments.
7. How the security master is loaded and how often a U.S. symbol is missing from it (decides how often the
   "unclassified" hold fires).
8. Whether the 6-hourly Korean calendar refresh interval is as the comment says (the timer was not read).
9. What `previousReview.sent/notPlaced` contains (built in `automation.cjs` near `:608`; not read).
10. `pending-decisions.cjs`, `review-orders.cjs`, `size-retry.cjs`, `trading-costs.cjs` cost estimation: used by the
    order path, not read.
11. The user's live settings and database state: taken from the audit (planner's reading of 2026-11-19 08:10 KST), not
    read by me.
12. Whether the unit of `maxOrderKRW` / `maxDailyTurnoverKRW` for the U.S. engine is shown to the user as dollars
    (the engine compares them with a dollar notional).
