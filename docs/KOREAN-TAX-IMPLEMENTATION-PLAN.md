# Korean investment-tax implementation plan

Research date: 2026-10-25 (Asia/Seoul). Code inspected at c525f23 (1.5.34).
Deliverable: implementation specification, not a change to running trading settings or a tax return.

## 1. Decision and scope

Replace the current market-based tax shortcut with a deterministic, versioned tax engine. Keep broker cash settlement, taxable income, withholding, and annual liability separate. AI agents should consume calculated results and their limitations; they should not determine tax classifications or invent missing tax inputs.

Initial supported profile: a Korean tax-resident individual, ordinary taxable brokerage accounts, ordinary Korean exchange-listed shares and ordinary foreign-company shares/foreign-listed equity ETFs. Add Korean-listed ETF taxation and dividend accounting in subsequent phases below. Confirm the profile in the application: using profits to support a business does not establish whether the investment account belongs to an individual or a corporation.

Detect ISA, pension/IRP, corporate accounts, non-residents, special residency cases, major shareholders, gifts/inheritance, foreign partnerships/PTPs, unusual distributions and special tax-relief accounts. Until their specific rules are implemented, show `unsupported` or `needs_review`, never silently apply the ordinary-account formula. The NTS overseas-share guidance includes a five-year domestic residence condition; residency history cannot be replaced with a hard-coded “Korean resident” label. [NTS taxpayer and stock-tax scope](https://i.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274)

## 2. Rules the design must distinguish

### Ordinary domestic listed shares

Exchange sales by ordinary minority shareholders generally do not incur capital-gains income tax. Major shareholders, off-exchange transactions and unlisted shares require different treatment. Current major-shareholder tests include market-specific ownership percentages and a KRW 5 billion value threshold; outside holdings and relevant related-party holdings can matter. The app's account balance alone cannot certify exemption. [NTS August 2026 stock-tax guidance](https://g.nts.go.kr/nts/na/ntt/selectNttInfo.do?bbsId=1028&mi=2201&nttSn=1353905)

For ordinary 2026 exchange sales, distinguish KOSPI transaction tax 0.05% plus rural special tax 0.15%, KOSDAQ 0.20%, and KONEX 0.10%. These are sale-value taxes, including loss-making sales. Store the components and effective dates, rather than one editable “Korea sale tax” rate. ETF/ETN transaction-tax exemption is a separate classification from income-tax treatment. [Effective transaction-tax decree, Article 5](https://law.go.kr/LSW/lsLinkCommonInfo.do?lspttninfSeq=64014), [National Assembly Budget Office, 2026 taxation reference](https://www.nabo.go.kr/board/file/down.do?fid=33319156)

### Ordinary foreign-company shares and foreign-listed ETFs

For the supported profile, calculate realized gains in KRW, deduct eligible acquisition/disposal costs, aggregate eligible same-year gains and losses, apply the shared annual KRW 2.5 million deduction, then 20% national income tax plus 2% local income tax. KIS describes conversion using the first published reference rate on the relevant payment/receipt dates. Actual currency conversion or repatriation is not the trigger for recognizing a share disposal. [KIS capital-gains guide](https://securities.koreainvestment.com/main/bond/research/_static/TF03ca030100.jsp)

The deduction is taxpayer-wide across eligible stock gains, not per symbol, account or broker. Eligible taxable domestic stock gains can interact with overseas gains; ordinary exempt domestic stock losses cannot offset them. Mixed domestic taxable-rate cases must not simply be fed into the foreign-share 22% formula. [NTS stock-tax calculation guidance](https://i.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274)

Ordinary stock capital losses do not carry forward into the next year. The usual overseas-stock final filing/payment window is May of the following year, subject to the actual calendar and extensions. Preserve gross sale proceeds, basis and expense evidence for the broker's filing assistance or Hometax. Gifts need special basis handling: NTS describes donor-basis rules for certain family gifts sold within one year, applicable to gifts from 2025. Do not treat such transfers as purchases at market price. [NTS May 2026 filing Q&A](https://www.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=&nttSn=1350890)

KIS states it uses moving-average acquisition cost. Keep an account/broker method with provenance and effective dates. FIFO may be needed for other supported records, but must not be an unrestricted toggle that rewrites previously reconciled KIS history. [KIS overseas-investment FAQ](https://securities.koreainvestment.com/main/bond/research/_static/TF03ca030000.jsp)

### Korean-listed ETFs and ETNs

Do not infer income-tax exemption from `type === etf`. Qualifying domestic-equity ETFs have different sale-gain treatment from Korean-listed overseas-equity, bond and commodity ETFs. For taxable ETF sales, the ordinary simplified basis is the positive lower of actual trading gain and the increase in taxable NAV (과표기준가격), subject to the product's detailed holding-period tax rules. Ordinary withholding is 15.4%, and this is dividend income rather than the overseas-share capital-gains bucket. [Issuer ETF tax guide](https://www.samsungfund.com/etf/insight/guide/view05.do)

Implementation must use issuer/broker product classification and taxable-NAV records, including distribution adjustments and acquisition history. A fund name containing “Korea,” “S&P” or “ETF” is insufficient. ETNs need their own issuer-verified rules; do not assume the ETF calculation covers every ETN. If required product data are unavailable, return unknown withholding and display the known pre-income-tax proceeds separately.

### Dividends, distributions and interest

Ordinary domestic dividend withholding is 14% national plus local income tax, commonly 15.4% combined. This withholding is not necessarily final tax liability. [NTS withholding rates](https://webtv.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7703&mi=2291)

Ordinary financial income generally enters comprehensive taxation above KRW 20 million per year; there are exceptions, and below-threshold income is not automatically exempt from reporting. Add an external interest/dividend-income completeness declaration, distinct from the external capital-gains declaration. A final comprehensive-income estimate requires other income, deductions and applicable credits; initially report a filing-review flag rather than invent a marginal rate. [NTS 2026 dividend-tax guidance](https://webtv.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2201&nttSn=1349597)

Eligible ordinary U.S. dividends can have a 15% treaty withholding ceiling. Eligibility, issuer domicile and distribution type matter; a U.S. listing alone is insufficient. Record foreign withholding and Korean withholding separately, and apply verified credit/top-up rules rather than adding 15% and 15.4%. [U.S.–Korea treaty, Article 12](https://www.irs.gov/pub/irs-trty/korea.pdf)

Korean funds' foreign-tax treatment changed from 2025: foreign tax can reduce investor-level withholding under the revised mechanism. Avoid charging a second blanket 15.4% against an already adjusted payment. Preserve broker-reported taxable income and credit details. [Issuer notice on the 2025 foreign-tax change](https://www.samsungfund.com/etf/lounge/notice-view.do?no=65093)

### Exceptions that must be represented explicitly

The 2026 high-dividend-company separate-tax regime is real, not merely a proposal. Eligible income has national progressive bands of 14%, 20%, 25% and 30%, at KRW 20 million, 300 million and 5 billion boundaries. Eligibility and timing depend on the company and dividend; do not apply it to every high-yield stock or ETF. Store company fiscal year and payment date separately. NTS describes filings beginning May 2027 for 2026 payments and extending through May 2030 for qualifying 2029 payments; avoid a simplistic “expires December 2028” payment cutoff. Implement only after importing eligibility evidence and verifying election/filing mechanics. [NTS explanation](https://webtv.nts.go.kr/nts/na/ntt/selectNttInfo.do?mi=2201&nttSn=1349597), [NABO enacted-2026 tax summary](https://korea.nabo.go.kr/board/file/down.do?fid=33319142), [FSC eligibility disclosure process](https://www.fsc.go.kr/po010104/86322?curPage=43&srchBeginDt=&srchCtgry=&srchEndDt=&srchKey=&srchText=)

ISA uses account-period netting and its own exemption/settlement rules (ordinary KRW 2 million or eligible KRW 4 million, then 9.9% on qualifying excess), not the overseas-share annual deduction. Implement separately if those accounts are added. [KIS ISA guide](https://securities.koreainvestment.com/main/mall/isa/_static/TF02ef010000.jsp)

Also detect the temporary 2026 RIA scheme rather than treating all foreign-share disposals as unconditionally subject to the baseline formula. It has account, eligible-holdings, reinvestment and holding-period requirements. Full RIA relief calculations are outside the first release and require a separate current-law specification. [Broker RIA notice](https://english.samsungpop.com/ux/kor/customer/notice/notice/noticeViewContent.do?MenuSeqNo=23752)

## 3. Concrete defects in the current implementation

These are code observations, separate from the legal rules above.

| Location | Current behavior | Required correction |
| --- | --- | --- |
| `electron/trading-costs.cjs:57`, `:34` | ETF/ETN exemption removes sale tax, while domestic `gainAfterEstimatedTax` simply equals gain after fees. | Separate transaction-tax exemption from income-tax classification; unknown product income tax must not become zero. |
| `electron/tax-ledger.cjs:40`, `electron/trading-costs.cjs:50` | Annual totals omit unknown sales; `get()` uses the partial total without preserving `complete`. | Propagate incompleteness into annual and marginal tax results supplied to the UI and agents. |
| `electron/trading-costs.cjs:62` | Reads all matching U.S. live-intent payloads without an explicit taxpayer/account/environment partition. | Isolate tax lots by owner, account and environment; aggregate only explicitly linked real accounts. |
| `electron/tax-ledger.cjs:12` | Recorded purchases are consumed before old holdings represented only by a per-share fallback basis. | Import opening quantities/lots before replay; include them in averaging/FIFO ordering. |
| `electron/trading-costs.cjs:34` | Hypothetical sale uses one per-share basis; this cannot represent FIFO across differently priced lots. | Quote a sale by cloning and consuming the same lot engine used by the actual ledger. |
| `electron/tax-ledger.cjs:8`, `:18` | Weekday-only T+1; generic settlement-KRW/registered FX automatically overrides reference FX. | Use actual settlement evidence or a dated settlement calendar; verify tax meaning of each broker field. |
| `electron/trading-costs.cjs:60` | Any earlier rate within seven days may substitute for a missing rate. | Distinguish legitimate non-publication days from missing data on a normal publication day. |
| `electron/trading-costs.cjs:34` | Acquisition commission is estimated again from the current plan for economic gain. | Store whether basis includes expenses; use historical amounts without double counting. |
| `src/TradingCosts.tsx`, `src/TaxLedger.tsx` | Tax settings largely represent one year, method and outside-gain number. | Persist tax-year/account-specific inputs, income categories, provenance and completeness. |

There is also no dividend/interest tax-event ledger in these calculation paths. Fixing the percentage alone cannot address that omission.

## 4. Implementation sequence

### PR 1 — Stop false certainty and establish classification

1. Introduce a structured result: `status: reconciled | estimated | incomplete | unsupported`, `missingInputs`, `assumptions`, `ruleVersion`, `taxYear`, `asOf`, `sourceIds`.
2. Return null for a full annual liability or marginal tax estimate when a required income/basis input is missing. Keep a clearly labeled known-record subtotal; it is not necessarily a lower bound because missing sales may be losses.
3. Add a taxpayer profile and account ownership/environment mapping. Confirm ordinary personal-account applicability without collecting unnecessary identifiers.
4. Split `exempt()` into `transactionTaxTreatment` and `incomeTaxTreatment`. Unknown ETF classification remains unknown.
5. Version statutory rules by effective date, market, account type and product; keep commission-plan settings separate. Record overrides as explicit estimates.

Suggested files: new `tax-profile.cjs`, `tax-rules.cjs`, `security-tax-classification.cjs`; update `trading-costs.cjs`, UI types and AI context.

### PR 2 — Reconstruct the capital-gains ledger correctly

1. Create immutable normalized tax events. Suggested fields: owner/account/environment, broker execution ID, event type, instrument ID, trade and settlement dates, quantity, gross amount/currency, itemized expenses, applicable tax FX and source, cash settlement FX separately, reversal link and import provenance.
2. Import broker executions and manual/external transactions, not only orders initiated by this app. Deduplicate by stable broker identifiers. Corrections replace/supersede evidence, not add a second sale. Preserve partial-fill dates and fees.
3. Add opening lots with quantity, acquisition date, KRW basis, expense inclusion and source. Support same-owner transfers without creating sales or resetting basis. Unknown corporate actions must invalidate affected basis until reconciled.
4. Partition cost pools by broker/account/instrument/method. Aggregate realized income at taxpayer level only after each pool is calculated.
5. Verify KIS `wcrc_excc_amt` and `erlm_exrt` against the broker's tax-support statement. A cash-settlement field is not proven to be a tax-basis field merely because it is in KRW. Preserve both when different.
6. Actual settlement dates outrank predictions. Predictions must use the appropriate holiday calendar and effective settlement convention, with an estimated flag. Test December/January explicitly.
7. Replace duplicated quote logic with `quoteDisposal(snapshot, quantity, price, expenses, expectedSettlement)`, which consumes a cloned ledger without changing live state.
8. Separate unused basic deduction (capped at KRW 2.5 million) from same-year losses that provide additional offset capacity. Current negative annual gains can make “deduction remaining” exceed the statutory deduction.

Suggested files: refactor `tax-ledger.cjs`, `trading-costs.cjs`; update `kis-overseas.cjs`, `live-engine.cjs`, `main.cjs`; add import/reconciliation modules.

### PR 3 — Korean fund taxes and investment-income events

1. Expand the security master with tax classification, issuer evidence and effective dates. Add taxable-NAV and distribution-adjustment inputs where required.
2. Implement supported ETF holding-period withholding. Show unknown when required inputs are missing. Implement ETNs only after their product rules are verified.
3. Add dividend/distribution/interest records: gross income, taxable income, foreign withholding, Korean national/local withholding, credit adjustments, net receipt, country, payment date, fiscal year and category.
4. Import actual broker cash/tax entries and reconcile gross minus deductions to net receipts. Do not count a dividend as an external deposit in performance tracking.
5. Maintain separate annual capital-gains and financial-income summaries. Do not net dividend income or exempt domestic trading losses against overseas capital gains.
6. Detect comprehensive-tax exposure and special-regime eligibility. Final personal-income calculations remain unsupported until all required personal tax inputs and rules are implemented.

### PR 4 — Integrate decision estimates, UI and reporting

Display four separate figures: immediate net settlement cash, realized taxable gain, change in estimated annual liability, and estimated after-tax economic result. A negative marginal annual tax amount is a possible reduction in liability, not immediate cash credited by the broker. Tax reserves are planning entries, not broker cash movements.

Supply agents a deterministic quote for the proposed quantity. One-share estimates are insufficient for FIFO, multi-lot ETF sales and annual threshold crossings. Evaluate sequences of proposed trades against one shared scenario ledger so each trade cannot reuse the same deduction.

Agent instructions: use the supplied marginal tax estimate and uncertainty; do not apply 22% to all proceeds, treat a loss as a guaranteed refund, assume an ETF is tax-free, or infer tax exemption from missing inputs. Compare alternatives on a consistent horizon with dividends and disposal costs included. Unknown tax should qualify the after-tax claim, not automatically force Hold or disable existing protective exits.

Add a tax report with account coverage, known-record totals, missing evidence, statutory assumptions, broker reconciliation differences and filing dates. Preserve old review snapshots; attach corrections instead of silently rewriting historical AI inputs. Changes to agent-visible tax context/rules belong in the routing-evaluation fingerprint and a new evaluation period where applicable.

## 5. Required acceptance tests

| Case | Expected behavior |
| --- | --- |
| Ordinary foreign-share annual gains KRW 4m, losses KRW 1m; complete inputs | Taxable amount KRW 500,000; national KRW 100,000 and local KRW 10,000 before any applicable credits. |
| Gains split between two linked real brokers | One shared basic deduction; no duplicated import. |
| Unknown acquisition basis on one sale | Full annual/marginal tax unknown; known subtotal preserved and labeled. |
| Same symbol in paper account and two real accounts | Paper excluded; lots remain account-specific; eligible realized income aggregated correctly. |
| Opening 10 shares at KRW 100,000 plus new 10 at KRW 200,000; sell 10 | Moving-average basis KRW 1.5m; FIFO basis KRW 1m if the opening lot is earlier. |
| FIFO sale crosses two lots | Quote and executed-ledger basis agree; a single averaged basis is not used. |
| Buy USD 1,000 at tax FX 1,200; sell USD 1,000 at tax FX 1,400; no fees | KRW 200,000 gain despite zero USD price gain. |
| Year-end trade settles next year, or holiday delays settlement | Correct tax year from confirmed settlement; estimates remain labeled. |
| Missing FX on a normal business day | No silent week-old substitution counted as verified. |
| Foreign-share loss with annual gains already below deduction | No immediate tax cash refund; no ordinary loss carryforward to next year. |
| Ordinary exempt Korean listed-share loss | Not used to offset foreign-share taxable gains. |
| 2026 ordinary KOSPI sale KRW 1m | KRW 500 transaction tax plus KRW 1,500 rural special tax before commission; dated rules for historical sales. |
| Qualifying domestic-equity ETF versus taxable Korean-listed ETF | Both may lack transaction tax, but income-tax results differ. |
| Simplified taxable ETF fixture: actual gain 100,000, taxable-NAV increase 60,000; no adjustments | Ordinary combined withholding 9,240; missing taxable NAV gives unknown, not zero. |
| Foreign dividend with foreign withholding | Gross/net reconcile; no duplicate blanket Korean tax charge. |
| Same-owner transfer, stock split, amended broker fee | No artificial realization, doubled quantity or duplicate deductible expense. |
| High-dividend special regime eligibility unknown | No preferential rate assumed; qualified scenario tested separately. |
| ISA/RIA/corporate account | Ordinary-account calculator explicitly declines unsupported treatment. |
| Recompute an archived year after changing today's settings | Historical rule/method evidence is retained; recalculation is versioned. |

Use decimal or integer/rational money arithmetic. Verify broker/statutory rounding independently for national tax, local tax, withholding and fees; do not assume JavaScript `Math.round` is correct for every component.

## 6. Release and evidence requirements

Ship PR 1 first. Complete the ordinary overseas ledger before advertising accurate after-tax comparisons. Add ETF/dividend support only as its input data become available; unsupported status is preferable to invented precision.

For each supported rule, record the exact legal provision, effective dates, source URL and retrieval date in a rule manifest. Separate enacted rules from proposals. Before enabling a rule, resolve broker data-field semantics, product eligibility, settlement conventions and rounding against current primary documentation and tax-support statements. These are explicit implementation dependencies, not permission to guess.

Run unit tests, idempotent import tests, historical replay and side-by-side reconciliation with KIS tax-support statements. Explain every material discrepancy by transaction, FX, basis, expenses, year or category. Do not force totals to agree by adjusting a rate. Reconcile broker cash independently from tax amounts.

Release first as calculated diagnostics without submitting orders or changing tax settings. Verify fresh AI inputs show the same classifications, completeness and marginal tax as the UI. Then enable those estimates in normal review contexts. Do not submit tax returns, select personal tax elections, or change trading settings as part of this implementation plan.
