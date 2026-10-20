import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import test from "node:test";

import {
  captureCurrentProviderBody,
  createPreparedRequestLogger,
  isProviderRequestCaptureActive,
  runWithCapture,
} from "../../open-sse/utils/providerRequestLogging.ts";

function makeCapture() {
  return createPreparedRequestLogger(
    { logTargetRequest() {} },
    { id: null, model: "synthetic-model", provider: "synthetic-provider", connectionId: null }
  );
}

test("settling a dispatch releases its prepared body and returns the caller's fallback", async () => {
  const capture = makeCapture();
  const fallback = { model: "fallback", messages: [] };
  const upstream = { model: "serialized", messages: [{ role: "user", content: "payload" }] };
  const result = await runWithCapture(capture, async () => {
    await captureCurrentProviderBody(
      "https://synthetic.invalid/chat",
      {},
      JSON.stringify(upstream)
    );
    assert.deepEqual(capture.body(fallback), upstream);
    assert.ok(capture.latest?.());
    return "dispatch-result";
  });
  assert.equal(result, "dispatch-result");
  assert.equal(capture.latest?.(), null);
  assert.equal(capture.body(fallback), fallback);
});

test("a rejected dispatch releases its body without replacing the original error", async () => {
  const capture = makeCapture();
  const failure = new Error("synthetic dispatch failure");
  await assert.rejects(
    runWithCapture(capture, async () => {
      await captureCurrentProviderBody("https://synthetic.invalid/chat", {}, '{"model":"failed"}');
      assert.ok(capture.latest?.());
      throw failure;
    }),
    (error) => error === failure
  );
  assert.equal(capture.latest?.(), null);
  const fallback = { model: "caller-body" };
  assert.equal(capture.body(fallback), fallback);
});

test("tool-name metadata survives both captured-body and post-settlement fallback access", async () => {
  const capture = makeCapture();
  const names = new Map([["WorkspaceRead", "workspace_read"]]);
  const fallback = { model: "fallback" };
  Object.defineProperty(fallback, "_toolNameMap", { value: names, enumerable: false });
  await runWithCapture(capture, async () => {
    await captureCurrentProviderBody("https://synthetic.invalid/chat", {}, '{"model":"upstream"}');
    const body = capture.body(fallback) as Record<string, unknown>;
    assert.equal(body.model, "upstream");
    assert.equal(body._toolNameMap, names);
    assert.equal(Object.getOwnPropertyDescriptor(body, "_toolNameMap")?.enumerable, false);
    assert.doesNotMatch(JSON.stringify(body), /_toolNameMap/);
  });
  const body = capture.body(fallback) as Record<string, unknown>;
  assert.equal(body, fallback);
  assert.equal(body._toolNameMap, names);
  assert.doesNotMatch(JSON.stringify(body), /_toolNameMap/);
});

test("an async resource from a settled dispatch cannot retain a new body or overwrite a retry", async () => {
  const capture = makeCapture();
  let resource: AsyncResource | undefined;
  try {
    await runWithCapture(capture, async () => {
      await captureCurrentProviderBody("https://synthetic.invalid/chat", {}, '{"model":"first"}');
      resource = new AsyncResource("synthetic-provider-socket");
    });
    assert.ok(resource);
    await resource.runInAsyncScope(async () => {
      assert.equal(isProviderRequestCaptureActive(), false);
      await captureCurrentProviderBody("https://synthetic.invalid/late", {}, '{"model":"late"}');
    });
    assert.equal(capture.latest?.(), null, "late ALS work must not repin the released body");

    await runWithCapture(capture, async () => {
      assert.equal(isProviderRequestCaptureActive(), true);
      await captureCurrentProviderBody("https://synthetic.invalid/retry", {}, '{"model":"retry"}');
      assert.deepEqual(capture.body(null), { model: "retry" });
      await resource.runInAsyncScope(() =>
        capture.capture({
          url: "https://synthetic.invalid/old-resource",
          headers: {},
          body: { model: "stale" },
          bodyString: '{"model":"stale"}',
        })
      );
      assert.deepEqual(capture.body(null), { model: "retry" });
    });
    assert.equal(capture.latest?.(), null);
  } finally {
    resource?.emitDestroy();
  }
});
