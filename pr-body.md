## Summary

- Bounded string previews no longer retain their full parent strings, which caused heap to climb to the pressure guard and answer `503 Service temporarily unavailable due to resource pressure` on a self-hosted 3.8.52 instance.
- `truncateLogString` (`open-sse/utils/requestLogger.ts`) and `truncatePreviewString` (`src/lib/usage/usageHistory/helpers.ts`) compose their bounded result from `String#slice()`. V8 can keep such a slice as a `SlicedString` whose **parent is the entire source string**, so a "64 KB" log line or "1200 char" pending preview kept a multi-megabyte request body reachable for as long as the bounded string lived (call-log details, previews, retries).
- Both helpers now flatten the result with a `Buffer` round-trip. Output is byte-identical; only the internal representation changes. This mirrors the `structuredClone` guard `src/lib/usage/completedRequestDetails.ts:124-127` already applies for the same hazard on the completed-details path.

## Related Issues

- Closes #16750

## Validation

Choose the change type and focused loop from the
[Contribution Golden Path](../docs/ops/CONTRIBUTION_GOLDEN_PATH.md). The full unit suite,
Vitest, the 60% coverage gate, and the production build all run in CI on this PR (#8329):

- [x] Change type: usage / routing / other (request capture + pending details)
- [x] Focused tests and category gates from the golden path
- [x] `npm run lint`
- [x] Reconciled with the current active release base; focused checks rerun afterward
- [ ] Production-code changes include a new or updated automated test in this PR — see note below
- SonarQube is temporarily opt-in while the private project has no quota; it is not a PR gate.

## Tests Added Or Updated

- No new test: the change is representation-only (same characters out, no parent reference kept) and a unit test cannot observe `SlicedString` retention portably. Existing coverage that pins the output was used instead:
  - `tests/unit/usage-pending-sweep.test.ts`, `tests/unit/usagehistory-helpers-split.test.ts`, `tests/unit/active-request-stream-chunks-lifecycle.test.ts`, `tests/unit/conversations-active-call-log-id.test.ts`, `tests/unit/request-logger-endpoints.test.ts` — **103/103 pass** with the patch.
- If the maintainers want a regression test, the practical one is a `--expose-gc` heap-usage test (truncate a large string, drop the parent, GC, assert RSS does not keep it) — happy to add it if it fits the suite's tolerances.

## Coverage Notes

- No `src/` route surface changes. `open-sse/utils/requestLogger.ts` and `src/lib/usage/usageHistory/helpers.ts` are covered by the focused tests listed above; behaviour visible to callers (the bounded string content) is unchanged.

## Reviewer Notes

Evidence from production (self-hosted 3.8.52, agent traffic with 2–4 MB request bodies):

- Three heap snapshots (422–452 MB) over two hours: largest non-buffer nodes were **full serialized request bodies in three copies each**, client system prompts (79 → 197 copies in 2 h), `/v1/models` responses, tool outputs; `system / JSArrayBufferData` +39 MB.
- Code read confirmed the mechanism (slice → `SlicedString` → parent kept); the same hazard is already documented and guarded in `completedRequestDetails.ts:124-127`.
- After the two-line-per-function fix, measured over **35.1 h**: heap growth **~80–90 MB/h → 3 MB/h (0.3 MB/h over the 32 h steady phase)**, steady range 721–925 MB, **0 guard trips** (was 59 trips in 3 h, ~3 manual restarts/day).
- `check:open-sse-typecheck` fails on `open-sse/services/apiKeyRotator.ts` (TS2484) on a clean `release/v3.8.52` checkout as well — pre-existing, untouched.
- Related, not fixed here (tracked in #16750): the `pendingById` byte cap accounts only the visible preview; `catalogCache` has no cap/LRU; `saveCallLog` keeps full request bodies per attempt; `OMNIROUTE_PRESSURE_SELF_RESTART` never fires (immediate vs settled observer divergence — see #16144).
