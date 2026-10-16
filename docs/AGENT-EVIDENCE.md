# Agent evidence, review alerts and learning memory

## Price movement detection

The main process checks automation each second. With scheduled reviews enabled and resumed, it compares fresh watched quotes against the last successful review (or the baseline when an AI alert is saved): `abs(price / baseline - 1) * 100`. The default threshold is the Engine settings percentage, initially 3%. A per-symbol AI override takes precedence. Quotes explicitly stale, older than 90 seconds, invalid or in the future are excluded.

This is movement since a baseline, not a rolling ten-minute return, volatility model or full-market scanner. Korea holdings use available streaming quotes plus REST fallback; selected Korean candidates use REST. U.S. quotes are polled, approximately every 30 seconds subject to broker queue/limits. A one-second scheduler cannot detect a move absent from its feed. Transient crossings between snapshots can be missed.

Ordinary review attempts have a one-minute cooldown. Scheduled interval and advisory loss-emergency triggers also operate; emergency entry may prompt an immediate review. API budget, busy state and enabled/resumed state still apply. Only symbols present in the review universe can receive AI alerts. Korean REST coverage remains capped at 20 symbols, prioritizing AI watches and selected candidates.

## Agent data requests

The API provider now supports an application-executed function-calling loop, similar in purpose to MCP tools. This does not expose a general MCP server or grant shell, file or order access. The existing external MCP bridge remains paper-only.

- `get_market_evidence(symbol, dataset)` supports `company`, `daily_technicals`, `minute_technicals`, and `range_10m`.
- `set_review_watch(symbol, percent, price, direction, reason)` changes monitoring only. Percent is 0.1–50, or null to use the user's default. Price is a positive native-currency alert level, or null to remove it. Above/below levels fire once when reached; they do not need to cross from the opposite side. Percentage baselines reset after successful reviews. Saved watches are isolated by account and selected scope, survive restart, and are visible/resettable in Engine settings. Restart still pauses scheduled reviews.

There are at most two tool rounds and three AI requests per review. Each request reserves the existing $0.01 estimate and consumes one daily call allowance, including failed requests. This is not actual invoiced token cost. Repeated data requests within the same review use a cache. Every request/result and watch change is logged in AI console; total token usage is recorded with the decision. Reaching the budget stops the review rather than bypassing it. A saved watch may remain even if a later AI request fails; no trade is submitted from an incomplete review.

## Data coverage

KIS company snapshots normalize current/day open/high/low, 52-week high/low, PER, PBR, EPS and BPS for KR and supported U.S. symbols. Broker entitlement, environment and response availability still determine actual coverage. Missing/zero-placeholder fields remain null. ROE and analyst-consensus targets are unavailable until suitable adapters are connected; they are not estimated from unrelated ratios.

Daily/minute candles yield SMA5/10/20 and **fast stochastic (14-bar K, three-bar SMA D)**. Periods mean bars at the stated interval. The current forming minute/day is excluded. These definitions may differ from another site's default slow stochastic or adjusted-price choices. Daily prices use the adapter's adjusted series; minute prices are as supplied. Daily results expose the last candle date rather than asserting real-time freshness across weekends/holidays. The U.S. daily date label uses the exchange date even though its numeric timestamp is only a sortable date label.

Ten-minute high/low uses the last ten completed clock-minute candles, not ten arbitrary last trades. Missing bars, after-hours gaps and insufficient history yield partial coverage or unavailable results. Partial extrema must not be represented as the entire period's extremes. Results include source, retrieval timestamp, coverage and delay caveats. Domestic history currently fetches up to 100 daily/30 minute bars; U.S. research fetches a single bounded page up to 120 bars. No multi-page historical completeness is claimed. U.S. research candles do not yet add U.S. charts to the Charts tab.

Synthetic paper evidence is explicitly labeled and cannot supply company fundamentals. Private credential files remain in the broker/provider workers; only normalized evidence reaches the model. No paid requests or actual broker calls were used for automated validation.

## Learning increment

Recorded sales now produce structured, evidence-linked review checklists in Journal, for both simulation and app-originated broker records. They describe observed results, cost certainty and missing evidence; they do not infer why the market moved. Candidate texts need approval before retrieval. Approved structured memory is matched to the symbol and account, and simulation is excluded from broker reviews. Changed economic evidence resets approval; mere observation timestamp changes do not. Legacy memory lacks broker provenance and is therefore restricted to paper context.

Still pending: LLM causal reflection with appropriate uncertainty, benchmark/horizon evaluation, external trade/tax-lot reconstruction, contradiction handling, and out-of-sample validation of claimed improvements. This increment does not train model weights or establish profitable self-improvement.

## Official references used

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [KIS domestic quote fields](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_price/chk_inquire_price.py)
- [KIS overseas company detail](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/price_detail/price_detail.py)
- [KIS overseas daily prices](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/dailyprice/dailyprice.py)
- [KIS overseas minute candles](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/overseas_stock/inquire_time_itemchartprice/inquire_time_itemchartprice.py)
