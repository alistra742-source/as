import test from "node:test";
import assert from "node:assert/strict";
import { publishReceipt } from "../worker/src/publishReceipt.ts";

const source = "https://www.tiktok.com/@source/video/7000000000000000001";
const live = "https://www.tiktok.com/@destination/video/7000000000000000002";

test("an unconfirmed uploader result can never become a success receipt", () => {
  const receipt = publishReceipt({ ok: false, message: "Post button did not accept the click" }, source);
  assert.deepEqual(receipt, { confirmed: false, error: "Post button did not accept the click" });
});

test("a confirmed destination replaces the source everywhere user-facing", () => {
  const receipt = publishReceipt({ ok: true, message: "Published", liveUrl: live }, source);
  assert.deepEqual(receipt, { confirmed: true, recordUrl: live, liveUrl: live });
  assert.notEqual(receipt.liveUrl, source);
});

test("the source URL itself is rejected even when an uploader incorrectly calls it live", () => {
  for (const falseReceipt of [`${source}?is_from_webapp=1`, source.replace("www.tiktok.com", "m.tiktok.com")]) {
    const receipt = publishReceipt({ ok: true, message: "Published", liveUrl: falseReceipt }, source);
    assert.equal(receipt.confirmed, false);
    assert.match(receipt.error, /source video URL, not a new destination post/);
  }
});

test("studio confirmation without a URL never labels the source as Live publish", () => {
  const receipt = publishReceipt({ ok: true, message: "Published" }, source);
  assert.deepEqual(receipt, { confirmed: true, recordUrl: source, liveUrl: "" });
});

test("junk live URLs are not broadcast as receipts", () => {
  const receipt = publishReceipt({ ok: true, message: "Published", liveUrl: "javascript:fake" }, source);
  assert.deepEqual(receipt, { confirmed: true, recordUrl: source, liveUrl: "" });
});
