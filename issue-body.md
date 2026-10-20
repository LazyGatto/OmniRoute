## Summary

Self-hosted `3.8.52`: unbounded heap growth to the pressure guard (503s), caused by bounded string previews retaining their full parent strings.

Symptom, diagnosis method and fix below — the PR with the fix is coming right after this issue.

## Environment

- OmniRoute `3.8.52` (self-built from `release/v3.8.52` @ `4ea24a2f8`, upstream Dockerfile, Docker `runner-base`), Debian LXC, 4 vCPU / 4 GB, Node 26.
- Traffic: 1.6–5.6k requests/day, average input 110–343k tokens/request (agent sessions with multi-megabyte bodies).

## Symptom

- `503 Service temporarily unavailable due to resource pressure` on every route (chat, MCP, dashboard), increasingly often: **59 guard trips in 3 hours**, ~3 manual container restarts/day.
- Logs: `[chatCore] heap pressure guard tripped: 1826MB > 1822MB; returning 503`, `reason=v8_heap_absolute`.
- On `3.8.51` the guard never tripped for 9 days; on `3.8.52` it tripped within hours of the upgrade. Traffic was **lower** on `3.8.52` (verified from `usage_history`), so this was not a load increase.

## How we caught it (method)

1. `--heapsnapshot-near-heap-limit=1` + `--heapsnapshot-signal=SIGUSR2` via `NODE_OPTIONS`, snapshots taken at 09:34 / 10:28 / 11:35 with heap ~1.1–1.3 GB (422–452 MB files).
2. Parsed the snapshots and diffed node aggregates between them. Growth over two hours (**+204 MB**) was concentrated in:
   - full serialized upstream request bodies (`{"model":"mimo-v2.6-flash","messages":[{"role":"system","content":"<context_handoff>…`, 2.7–4.7 MB each, **three copies of the same body**);
   - the client's system prompt (`You are an AI agent running in OpenCode…`): 79 → 197 copies in 2 h;
   - `/v1/models` responses (`{"object":"list","data":[{"id":"auto/best-coding"…`), tool outputs, attached base64 images;
   - `system / JSArrayBufferData` +39 MB (1694 → 2038 buffers).
3. Code read confirmed the mechanism: `truncateLogString` (`open-sse/utils/requestLogger.ts:164`) and `truncatePreviewString` (`src/lib/usage/usageHistory/helpers.ts:199`) compose their bounded result with `String#slice()`. V8 may keep a slice as a `SlicedString` whose **parent is the entire source string**, so a "64 KB" log line or "1200 char" preview keeps the full multi-megabyte body reachable. `src/lib/usage/completedRequestDetails.ts:124-127` already documents and guards this exact hazard with `structuredClone` — the pending-preview and request-logger paths did not.

## How we fixed it (local patch, measured)

Both helpers now flatten the bounded result (`Buffer.from(str, "utf8").toString("utf8")`) so no reference to the parent remains. Output is byte-identical; only the internal representation changes.

Measured on the same instance (`/usr/local/bin/omni-mem-watch.sh`, 60 s samples, 35.1 h window):

| metric | before | after |
|---|---|---|
| heap growth | ~80–90 MB/h | **3 MB/h whole window, 0.3 MB/h over the 32 h steady phase** |
| steady range | 270 MB → 1822 MB (guard) | **721–925 MB, no trend** |
| guard trips | 59 in 3 h | **0** |

Unit tests around the touched areas: **103/103 pass**, prettier/eslint clean.

## Related findings (not covered by this issue's fix)

1. `pendingById` age sweep only marks entries `stale`; they are evicted only when the 5000-entry cap triggers, and the byte cap counts the *visible* preview, not the retained parent (blind while previews are not flattened — this patch makes the accounting truthful again).
2. `src/app/api/v1/models/catalogCache.ts`: the full serialized `/v1/models` response body is cached per `apiKey × pagination × flags` with no cap/LRU, and expired entries are only overwritten on read.
3. `saveCallLog` retains full `clientRequestBody` / `upstreamRequestBody` per attempt without bounded cloning.
4. `self-restart` (`OMNIROUTE_PRESSURE_SELF_RESTART`) never fired: the immediate guard tripped 134 times while the settled observer logged `entered critical` 0 times (`open-sse/utils/resourcePressure.ts`), so `criticalSinceMs` was never armed — related to #16144 (duplicated bundle copies).

## Reproduction

1. Run `3.8.52` with agent traffic carrying 2–4 MB request bodies.
2. `docker exec <c> node -e "console.log(require('v8').getHeapStatistics().heap_used_heap_size/1e6)"` grows ~80 MB/h.
3. Take a snapshot (`kill -USR2 <server pid>` with `--heapsnapshot-signal=SIGUSR2`): the largest non-buffer nodes are full request bodies, several copies each.
4. Apply this PR and repeat: growth flattens to ~0.3 MB/h.

## Validation Plan

- `node --test tests/unit/usage-pending-sweep.test.ts tests/unit/usagehistory-helpers-split.test.ts tests/unit/request-logger-endpoints.test.ts` (plus the active-request stream tests) — unchanged output, all green.
- Live: watch `heapUsed` over 24 h after deploy — flat plateau instead of a monotonic climb.
