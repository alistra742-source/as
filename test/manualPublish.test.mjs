import assert from "node:assert/strict";
import test from "node:test";
import { resolveManualSnapshot } from "../src/state/manualPublish.ts";

const base = {
  manualRequestId: null,
  manualResult: null,
  lastPost: null,
};

test("a stale manualBusy=false-era snapshot cannot cancel a new request", () => {
  assert.deepEqual(resolveManualSnapshot("post-new", base), { state: "pending" });
});

test("an acknowledgement for the exact request remains pending", () => {
  assert.deepEqual(
    resolveManualSnapshot("post-new", {
      ...base,
      manualRequestId: "post-new",
      manualResult: { requestId: "post-new", status: "accepted", message: "accepted", at: 1 },
    }),
    { state: "pending" }
  );
});

test("only the exact correlated terminal failure settles a request", () => {
  assert.deepEqual(
    resolveManualSnapshot("post-new", {
      ...base,
      manualResult: { requestId: "post-old", status: "failed", message: "old failure", at: 1 },
    }),
    { state: "pending" }
  );
  assert.deepEqual(
    resolveManualSnapshot("post-new", {
      ...base,
      manualResult: { requestId: "post-new", status: "failed", message: "upload challenge blocked Post", at: 2 },
    }),
    { state: "failed", message: "upload challenge blocked Post" }
  );
});

test("account history is a strict success receipt for its matching request", () => {
  assert.deepEqual(
    resolveManualSnapshot("post-new", {
      ...base,
      lastPost: {
        id: "worker-post",
        requestId: "post-new",
        url: "https://example.test/live",
        caption: "caption",
        niche: "stories",
        source: "manual",
        postedAt: 42,
        views: 0,
        likes: 0,
        comments: 0,
        verdict: null,
      },
    }),
    { state: "succeeded", postId: "worker-post", postedAt: 42, url: "https://example.test/live" }
  );
});
