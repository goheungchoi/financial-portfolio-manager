# UI architecture decision: Electron + React

Status: React implemented. This records the comparison requested in the original specification; it is not a proposal to replace the current application.

| Choice | Advantages for this app | Costs and limitations |
| --- | --- | --- |
| Electron + React | Declarative components for many account/engine states; reusable chart/settings components; explicit state and lifecycle handling; TypeScript-friendly; easier to keep a changing financial UI consistent | Build toolchain and component/state design required; careless remounts still lose drafts; render/update performance must be measured; dependencies and bundle overhead |
| Electron + jQuery | Fast for a small static prototype; direct DOM updates; familiar imperative event handling; can be used with little build tooling | More manual coordination of DOM, state, validation, subscriptions and cleanup; greater drift risk across many account/automation states; reusable complex views and TypeScript contracts require additional conventions |

Electron supplies the desktop runtime in either option, so choosing jQuery would not remove Electron's Chromium/runtime overhead. Neither option provides brokerage correctness, privacy, profitability or reliable testing by itself.

React fits the implemented scope: shared navigation, persistent settings/drafts, streamed valuations, chart controls, approval state, failure recovery and separate broker processes. Updates are currently published at 1 Hz, not 30 Hz. A future high-frequency renderer should coalesce quote events and profile the actual workload rather than force a full portfolio rerender on every market event.

Renderer code has no Node access. Native credential-file import and broker execution remain in Electron main/private utility workers. UI tests use DOM interactions and measure rendered geometry in actual Electron windows; native brokerage access is replaced with fixtures.
