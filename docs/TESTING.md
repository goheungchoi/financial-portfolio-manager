# Automated validation

Use Node.js 22.13+ (CI uses Node 24) on Windows. Install dependencies with `npm ci`.

```powershell
npm test               # Domain, storage, broker, accounting, review and memory tests
npm run test:ui        # Build + all Electron UI cases
npm run validate       # Types, build, unit, UI, package, portable startup
```

`test:desktop` remains a compatible name for the desktop suite. The full validation command stops on failure and does not package a failed UI build. No extra testing dependency is required: the harness runs the installed Electron executable and the real compiled renderer.

## Reports

- `artifacts/validation/latest.json`: stage status/duration and stage logs.
- `artifacts/ui-tests/latest.json`: points to the latest UI run.
- `artifacts/ui-tests/run-*/report.html`: readable per-case result/log links and screenshot gallery.
- `artifacts/ui-tests/run-*/report.json`: machine-readable case results.
- `artifacts/ui-tests/run-*/ui-regression.json`: detailed layout/regression groups.
- PNGs and failure captures live beside the UI report. Each run uses separate fixture user-data directories.

The UI runner exits nonzero on assertion failure, crash, signal or timeout. The full validation runner also checks TypeScript, the production build and the packaged executable. Fixed fixtures keep the regression suite independent of market prices, account permissions and API spending. Tests do not read the user's credential JSON, place real broker orders or make paid OpenAI requests.

## Coverage

Existing desktop cases cover startup/restart, themes, same-window console navigation, quote updates/staleness, domestic candles/history, order history, realized reports, paper partial fills, settings saves, draft retention, broker activation/approval/idempotency/reconciliation, remembered file references, U.S. and combined valuations, classification and read-only reviews.

The added regression case visits every sidebar page at 1280×900 and 960×720 in dark and light modes. It checks horizontal overflow, theme switching and one-window navigation. It refreshes a zero-balance U.S. account and measures that the equity delta stays next to the total, with space before the Stock header. Positive/negative changes, stale values with HTTP/broker diagnostics, successful recovery and both-market read-only AI review with execution off are checked. Representative screenshots and a failure screenshot are saved.

Unit tests separately verify that losing-paper-fill candidates are generated once, persist across restart, stay out of review context until approved and disappear from future context after removal. These tests verify memory mechanics, not learning effectiveness.

## Continuous integration

`.github/workflows/validate.yml` runs on push, pull request and manual workflow dispatch on a Windows runner. It installs from the lockfile, runs `npm run validate`, and uploads reports/logs/screenshots on success or failure. It does not upload fixture databases or create real broker/provider secrets. The workflow is configured locally; it only runs remotely after this project/workflow is pushed to a GitHub repository with Actions enabled. No remote CI success is claimed by adding the file.

## What these tests do not prove

No live market execution, final settlement/FX/tax correctness, licensed research coverage, notification delivery to an actual mobile device, native OS file-picker interaction, full keyboard/screen-reader accessibility, pixel-perfect screenshot comparison or profitable model strategy is certified. Native file dialogs are stubbed. Layout assertions cover selected invariants and viewports, not every font/DPI/window state. Review explanations should be evaluated separately from broker accounting and order-safety tests.
