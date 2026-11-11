# External facts the app states

Every fact about markets, brokers and tax that the AI's instructions or the screens state, with the value the app uses,
where it is used, a source, and the date it was last checked. Review this list before each release. When a fact
changes:
- update the code;
- for a session, set its `to` date in `electron/market-sessions.cjs`;
- update this row and its date.

Sources are mostly secondary: news, broker and asset-manager guides. Statute text and exchange rulebooks were not read
unless a row says so.

| Id | Fact | Value in the app | Where | Source | Checked |
|---|---|---|---|---|---|
| `F-KRX-REGULAR` | KRX regular session | 09:00–15:30 KST; the app stops new orders at 15:20 | `market-sessions.cjs` `krx-regular` | yawanginvest.com/2026/09/9-14-8.html (regular session unchanged after the 2026-09-14 change) | 2026-11-11 |
| `F-KRX-CLOSING-PRICE` | KRX closing-price windows | Pre-open 08:30–08:40 and after close 15:40–16:00 KST; shown, not traded | `market-sessions.cjs` `krx-pre`, `krx-post`; Engine settings note | easyzetec.com/blog/krx-after-market-trading-hours-nextrade-difference (15:40–16:00 after close continues). The 08:30–08:40 pre-open window was not re-checked. | 2026-11-11 |
| `F-KRX-SINGLE-ENDED` | KRX after-hours single-price auction (16:00–18:00) ended | Ended 2026-09-14; never listed or traded; a saved switch is ignored | `market-sessions.cjs` `ENDED_SESSIONS`; `automation.cjs` `LEGACY_SETTINGS`; Engine settings note | fastideabank.com/2026/09/krx-aftermarket-trading-change.html; make2t.kr/2026/09/krx-after-market-trading.html; hankyung.com/article/202609043639i | 2026-11-11 |
| `F-KRX-AFTER-MARKET` | KRX after-market since 2026-09-14 | Not supported by the app (decision Da: not researched now). Reported: 16:00–20:00 KST, continuous matching, no market orders, ETFs and ETNs excluded | Not used | Same sources as `F-KRX-SINGLE-ENDED` | 2026-11-11 |
| `F-NXT-HOURS` | Nextrade sessions (since 2025-03-04) | Pre-market 08:00–08:50, after-market 15:30–20:00 KST | `market-sessions.cjs` `nxt-pre`, `nxt-after`; Engine settings "Korea · Nextrade (NXT)" | open.shinhansec.com/mobilealpha/html/CS/NXTPolicyGuide.html; kbthink.com/stock/next-trade.html. **Differs:** those give main market 09:00:30–15:20, and after-market trading 15:40–20:00 with orders accepted from 15:30. The app's 15:30 start is the order-acceptance time. | 2026-11-11 |
| `F-KIS-US-DAYTIME` | KIS U.S. daytime session | 20:00–04:00 New York time; Engine settings says "09:00–17:00 KST in summer" | `market-sessions.cjs` `us-daytime`; Engine settings "U.S. · KIS daytime session" | heraldk.com/article/2025110316493836368 (10:00–18:00 KST, standard time). An undated article gives 10:00–17:00 KST in summer. **Differs:** in summer 20:00 New York is 09:00 KST, an hour before the reported start, and the screen's "09:00" disagrees with "10:00". Not changed in this step. | 2026-11-11 |
| `F-US-REGULAR` | U.S. regular session and early closes | 09:30–16:00 New York time, 13:00 on early-close days; the app stops 10 minutes before the close | `market-sessions.cjs` `us-regular`; `kis-overseas.cjs` `usSession` | nyse.com/trade/hours-calendars (core 09:30–16:00 ET; 2026 early closes 13:00 on 27 November and 24 December) | 2026-11-11 |
| `F-US-EXTENDED` | U.S. pre- and after-market | Pre 04:00–09:30, after 16:00–20:00 New York time | `market-sessions.cjs` `us-pre`, `us-after`; Engine settings | heraldk.com/article/2025110316493836368: KIS pre-market 18:00–23:30 KST (04:00–09:30 New York) and after-market 06:00–09:00 KST in standard time. **Differs:** in standard time KIS's after-market ends at 19:00 New York, not 20:00. Not changed in this step. | 2026-11-11 |
| `F-US-SEC-FEE` | SEC Section 31 fee on U.S. sales | USD 20.60 per million (0.00206%) | `trading-costs.cjs` `usSellFeePct` | sec.gov/rules-regulations/fee-rate-advisories/2026-2 (effective 2026-04-04, until 60 days after the FY2027 appropriation; it was USD 0.00 before) | 2026-11-11 |
| `F-KR-SALE-TAX` | Korean sale levies 2026 | KOSPI 0.05% transaction tax + 0.15% rural special tax; KOSDAQ 0.20% | `tax-rules.cjs` `KR_SALE_TAX` | Planning fact check 2026-11-11: taxtimes.co.kr/news/article.html?no=273069; economist.co.kr/article/view/ecn202512220061 | 2026-11-11 |
| `F-OVERSEAS-GAINS` | Overseas stock gains tax | 22% (20% + 2% local) on the year's net gain above KRW 2,500,000 per person; filed and paid in May; losses net within the year, nothing carries forward | `tax-rules.cjs` `OVERSEAS_GAINS`; instructions; Tax ledger | Planning fact check: taxtimes.co.kr/news/article.html?no=269579; financecoffeechat.com/tax/foreign-stock-capital-gains-2026; hometax-go.kr/foreign-stock-loss-carryforward/ | 2026-11-11 |
| `F-KR-ETF-TAX` | Korean-listed ETF sale gains | Domestic-equity ETF: not taxed. Other Korean-listed ETFs: 15.4% as dividend income. The app cannot tell them apart without your classification. | `security-tax-classification.cjs`; Tax ledger "Korean ETF tax class" | kbam.co.kr/insights/guide/etf-tax-guide-domestic-vs-other-types | 2026-11-11 |
| `F-LEVERAGED-ELIGIBILITY` | Retail access to leveraged and inverse ETFs and ETNs | Basic deposit KRW 10 million and online investor education registered with the broker. Since 2026-05-22 also for U.S.-listed products, for investors buying them for the first time (investors with earlier trades were exempt). Single-stock leveraged products: KRW 30 million in cash since 2026-07-31, with extra education. Brokers may apply their own conditions | Short & leverage "Why the app asks"; `exposure.cjs` `leveragedAccess` | heraldk.com/article/2026051918101764619 (U.S.-listed, from 22 May); news.mtn.co.kr/news-detail/2026072408143493525 (KRW 30 million cash from 31 July) | 2026-11-11 |
| `F-DAILY-RESET` | Daily-reset leveraged products drift from the multiple over longer holds | Instruction text; Short & leverage note | `ai-client.cjs`; `ShortLeverage.tsx` | General property; planning fact check item 9 | 2026-11-11 |

## Stated but not checked yet

- Margin loans "usually mature within 90–150 days" (Short & leverage, Margin buying note).
- KIS offers no margin or short selling for U.S. stocks (Short & leverage error text).
- KIS offers no extended-session orders on mock accounts (Engine settings).
- U.S. after-market orders need the KIS after-market extension on the account (Engine settings).
