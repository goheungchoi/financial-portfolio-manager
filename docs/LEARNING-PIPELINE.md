# Trade outcomes and supervised learning

Updated 2026-10-16 (Asia/Seoul).

## Local pipeline

While the app is open, the automation tick synchronizes the local ledger and candidates at least every 15 seconds. Runtime reads also synchronize them. No API calls are made by this evaluation worker. Journal → Reviewed lessons shows its status and queue counts.

App-originated cumulative broker fills replace one outcome per order; paper fills aggregate by order. Economic changes create durable `outcome_versions` rows. Repeated reconciliation timestamps do not create new versions or alter the displayed first observation of unchanged economics. Withdrawn/deleted fill evidence is retained as Retracted, rather than silently leaving a usable old outcome. This is an app evidence ledger, not a complete broker tax-lot ledger.

New reviews also retain the submitted guideline snapshot, chosen-symbol quote/position, emergency flag and retrieved lessons locally. The original decision explanation is displayed with its candidate. These records contain normalized financial context, never imported credentials.

## Evaluations

- Entries wait for a realized exit. In-progress sales wait for a final fill, cancellation or risk stop.
- Acquisition basis is inferred as net proceeds minus after-fee gain. Paper uses simulator weighted-average accounting; broker results use captured cost estimates. It is not tax-lot reconstruction.
- Net return is after-fee gain divided by that basis. Exit cost drag is exit charges divided by basis. Before-exit-charge result adds exit charges back; acquisition fees can remain in basis.
- The evaluator distinguishes entry, pending, retracted, missing evidence, cost drag, gain, loss and break-even. It does not claim a loss proves a thesis mistake.
- Native currencies remain separate. Unknown acquisition basis, fees and after-tax outcomes remain unavailable. No benchmark, holding-period, causal or out-of-sample conclusion is generated.

## Lesson lifecycle

Candidates carry source outcome/version, original decision, account/market/symbol scope, method, evidence-quality notes and gaps. User approval permits a lesson as contextual evidence, not as a validated policy change.

Journal supports editing a reviewed lesson and its applicability, approving/renewing it for 1–365 days (UI presets), retiring it, and reopening it. Evidence-signature checks reject approval of an outdated screen. Economic evidence changes invalidate prior approval. Retired lessons remain retired when evidence changes. Expiry immediately excludes a lesson from model context, even before the next UI refresh. Lifecycle changes are persisted in `lesson_history`.

Retrieval requires the same broker account and symbol (or paper-only provenance); held symbols rank first, then recent approval, with a maximum of five lessons. Legacy unscoped observations remain paper-only. User applicability notes are supplied to the provider but are not machine-executable rules. Contradiction detection between different lessons is not implemented.

## Still outstanding

External broker trade imports; complete entry/exit lot matching and corporate actions; forward horizons and benchmarks; paper replay / held-out validation; quantitative comparison against an unchanged strategy; automatic lesson promotion. No learned strategy change or profitability improvement is claimed.

## Model configuration and usage

Engine settings exposes GPT-6 Luna, GPT-6 Sol and GPT-6 Astra plus supported effort choices. Existing settings migrate to Luna/none; Astra requires low or higher. Saving settings does not itself make a model call when scheduled reviews are disabled. Existing review scheduling behavior remains explicit in the enabled checkbox.

The standard text rates were verified on 2026-10-16 against official pages:
- https://developers.openai.com/api/docs/models/gpt-6-luna
- https://developers.openai.com/api/docs/models/gpt-6-sol
- https://developers.openai.com/api/docs/models/gpt-6-astra

Each call reserves an input-size/output-allowance estimate with overhead and margin, at least USD 0.01. Reservations remain charged against the local daily allowance after failures, uncertain responses and successful calls. Reported token counts additionally produce a separate cost estimate; cached-input discounts are not assumed. This is not a provider invoice, guaranteed cost cap or accounting for other applications using the key. Prices may change. Existing pre-upgrade usage retains its historical reservations.

The selected model/effort and each call's reservation/status are persisted in `ai_calls`; completed reviews also record the model. Reasoning calls allow 8,192 output tokens and a 75-second local timeout; no automatic model fallback or retry is introduced. Up to three calls may be made per review, with a fresh budget check for each.

## Post-trade AI reflection

Engine settings can enable post-trade reflection, using the selected OpenAI model/effort with a separate daily call allowance and USD reservation budget. It defaults off. The worker runs while the app is open, independently of order automation. Broker evidence requires the existing KIS sharing permission. Enabling reflection includes existing eligible final sales, not just new fills.

A durable queue keys each job to the lesson evidence signature. Changed evidence supersedes old jobs; incomplete/retracted sales are excluded. Retired lessons are skipped. Interrupted requests recover with a delay; failures retry with backoff up to three total attempts. Every attempt reserves budget before dispatch, and uncertain/failed reservations remain charged to the local allowance. A completed job stores reported usage and its cost estimate. Separate daily budgets are additive, not a provider billing cap.

The provider gets normalized outcome evidence, original thesis and captured decision context, without account identifiers, credentials or raw broker payloads. A tool-free structured response separates observations, unknowns, tentative hypothesis, lesson and applicability. No private internal reasoning is requested. Journal shows progress and results; AI console records reflection events. “Use suggestion in draft” copies a suggestion without approving or overwriting saved user notes. Explicit approval is still required for future review context. This is contextual memory, not model-weight training or proof of causation or improved returns.

Implemented against the official Responses structured-output format: https://developers.openai.com/api/docs/guides/structured-outputs

## Offline replay foundation

Charts now includes a local, deterministic buy-and-hold versus closing-loss-threshold comparison on completed daily bars. The threshold signal executes at the following open, including price gaps. Earlier and later chronological halves are independently initialized; costs use explicit user commission and sale-levy assumptions. This is a fractional-share, full-fill illustration, excluding annual capital gains, FX, slippage and liquidity. It does not replay arbitrary natural-language lessons, persist a validation verdict, or promote lessons. Automatic lesson-to-policy mapping and full out-of-sample validation remain outstanding.

## AI review cadence

Auto review interval enables a bounded set_review_interval tool (1–60 minutes). Choices and reasons persist per account/scope. Fixed mode ignores stored agent choices. Budgets, enablement, the one-minute trigger cooldown and emergency cadence remain independent. Until the first choice, the configured interval is used, capped at 60 minutes in Auto mode.

## Usage accounting update (2026-10-16)

Reviews and reflections now have independent Unlimited call-count and Unlimited budget switches, default off. These remove local limits only; provider quotas, scheduling, bounded research rounds and execution controls still apply.

New requests explicitly use the standard service tier. Cost calculation uses reported ordinary input, cached input, cache writes, and output (already including reasoning). Cached input is 0.1× ordinary input; cache writes are 1.25×. Long contexts and recognized returned service tiers adjust pricing. Counts and a dated rate snapshot are retained per call, including reflection attempts and failed responses when usage is returned. Completed usage atomically replaces the original reservation in daily accounting. Unknown transport usage retains its reservation. Missing cache breakdowns are visibly marked and assumed zero for the calculation; historical records are labeled legacy estimates and are not silently reconstructed. Local published-rate calculations exclude account-specific discounts and taxes and are not invoice amounts. OpenAI Costs API reports aggregated billing, not a per-response invoice.

Sources: https://developers.openai.com/api/docs/guides/prompt-caching ; https://developers.openai.com/api/docs/pricing ; https://developers.openai.com/api/docs/models/gpt-6-sol ; https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
