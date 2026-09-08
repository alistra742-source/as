/**
 * Unit tests for the source-grab layer (worker/src/sourceGrab.ts) — the code that
 * turns a TikTok / Instagram / YouTube link into a file to upload. No browser:
 *
 *   npm test
 *
 * These fixtures are the shapes the real pages use: JSON-escaped `\/` in embedded
 * state, `\u0026` in YouTube URLs, a `blob:` player src that proves nothing, and a
 * manifest that is not a video. Every one of those has broken a publish at some
 * point, which is why they are pinned here instead of trusted to a demo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateFromResponse,
  describeGrabFailure,
  harvestMediaUrls,
  looksLikeMediaUrl,
  looksLikeVideoBytes,
  rankCandidates,
  sizeRejection,
  sourcePlatformOf,
  youtubePlayability,
} from "../worker/src/sourceGrab.ts";

/* --------------------------------- fixtures -------------------------------- */

const TIKTOK_HTML = `<html><head><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">
{"__DEFAULT_SCOPE__":{"webapp.video-detail":{"itemInfo":{"itemStruct":{"video":{
"playAddr":"https:\\/\\/v16-webapp.tiktok.com\\/6b8f\\/o\\/v0d00fg10000abc\\/o6t.mp4?a=1988&line=0",
"downloadAddr":"https:\\/\\/www.tiktok.com\\/aweme\\/v1\\/play\\/download\\/?video_timestamp=1",
"bitRateList":[{"bitrate":1234567,"playAddr":"https:\\/\\/v16-webapp.tiktok.com\\/6b8f\\/o\\/v0d00fg10000abc\\/720p.mp4?ratio=720p"}]
}}}}}}
</script></head><body><video src="blob:https://www.tiktok.com/9c1"></video></body></html>`;

const IG_HTML = `<html><head>
<meta property="og:video" content="https://scontent-lga3-1.cdninstagram.com/v/t50.2886-16/1000_11_22.mp4?_nc_cat=106&oe=6500">
</head><body><script>
{"media":{"video_versions":[{"type":2,"width":640,"height":1138,"url":"https:\\/\\/scontent.cdninstagram.com\\/vt\\/16\\/o1\\/444.mp4?_nc_ht=scontent.cdninstagram.com&oh=abc"}]}}
</script></body></html>`;

const YT_HTML = `<html><body><script>var ytInitialPlayerResponse = {
"playabilityStatus":{"status":"OK"},
"streamingData":{
 "formats":[
  {"mimeType":"video\\/mp4;\\u0026codecs=avc1","itag":18,"contentLength":"1234567","url":"https:\\/\\/rr5---sn-npoe7ns6.googlevideo.com\\/videoplayback?expire=1760000000\\u0026itag=18\\u0026source=youtube\\u0026signature=AA"},
  {"mimeType":"video\\/mp4;\\u0026codecs=avc1.4d401f","itag":22,"contentLength":"9999999","url":"https:\\/\\/rr5---sn-npoe7ns6.googlevideo.com\\/videoplayback?expire=1760000001\\u0026itag=22\\u0026mime=video%2Fmp4\\u0026signature=BB"}
 ],
 "hlsManifestUrl":"https:\\/\\/manifest.googlevideo.com\\/api\\/hls\\/playlist?id=xyz&mime=m3u8"
}};</script></body></html>`;

const urls = (list) => list.map((c) => c.url);

/* --------------------------------- platform -------------------------------- */

test("the source platform comes from the host, short links included", () => {
  assert.equal(sourcePlatformOf("https://www.tiktok.com/@user/video/7300000000000000000"), "tiktok");
  assert.equal(sourcePlatformOf("https://vm.tiktok.com/ZM8abc123/"), "tiktok");
  assert.equal(sourcePlatformOf("https://www.instagram.com/reel/Cxyz123/"), "instagram");
  assert.equal(sourcePlatformOf("https://instagr.am/p/Cxyz123/"), "instagram");
  assert.equal(sourcePlatformOf("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), "youtube");
  assert.equal(sourcePlatformOf("https://youtu.be/dQw4w9WgXcQ"), "youtube");
  assert.equal(sourcePlatformOf("https://www.youtube.com/shorts/abcdefghijk"), "youtube");
  assert.equal(sourcePlatformOf("https://example.com/clip.mp4"), "other");
  assert.equal(sourcePlatformOf("not a url"), "other");
});

/* --------------------------------- harvest --------------------------------- */

test("TikTok's embedded state is read without needing valid JSON", () => {
  const found = harvestMediaUrls(TIKTOK_HTML);
  assert.equal(found.length, 3, found.join("\n"));
  assert.ok(found.some((u) => u.includes("720p.mp4?ratio=720p")));
  assert.ok(found.some((u) => u.includes("o6t.mp4?a=1988&line=0")), "the escaped & must survive");
  assert.ok(!found.some((u) => u.startsWith("blob:")), "a blob URL cannot be re-fetched");
});

test("Instagram's video_versions and og:video are both picked up", () => {
  const found = harvestMediaUrls(IG_HTML);
  assert.equal(found.length, 2, found.join("\n"));
  assert.ok(found.some((u) => u.includes("o1/444.mp4")));
  assert.ok(found.some((u) => u.includes("og") || u.includes("t50.2886")));
});

test("YouTube's \\\\u0026 escapes and the manifest are handled correctly", () => {
  const found = harvestMediaUrls(YT_HTML);
  assert.equal(found.length, 2, found.join("\n"));
  for (const u of found) {
    assert.ok(u.includes("&itag="), `escapes not undone: ${u}`);
    assert.ok(!u.includes("\\u0026"));
    assert.ok(u.startsWith("https://rr5---sn-"), u);
  }
  assert.ok(!found.some((u) => u.includes("manifest")), "a playlist is not a file");
});

test("only real media files pass the URL test", () => {
  assert.equal(looksLikeMediaUrl("https://v16-webapp.tiktok.com/a/b/o6t.mp4?a=1988"), true);
  assert.equal(looksLikeMediaUrl("https://rr1---sn-x.googlevideo.com/videoplayback?itag=18"), true);
  assert.equal(looksLikeMediaUrl("https://cdn.example/videoplayback?mime=video%2Fmp4"), true);
  assert.equal(looksLikeMediaUrl("https://p16-sign.tiktokcdn.com/obj/tos/alice.jpg"), false);
  assert.equal(looksLikeMediaUrl("https://scontent.example.com/reel.jpg?oe=1"), false);
  assert.equal(looksLikeMediaUrl("https://manifest.googlevideo.com/api/hls/playlist?mime=m3u8"), false);
  assert.equal(looksLikeMediaUrl("blob:https://www.tiktok.com/9c1"), false);
  assert.equal(looksLikeMediaUrl("data:video/mp4;base64,AAAA"), false);
});

/* --------------------------------- ranking --------------------------------- */

test("the best TikTok candidate is the site's own 720p file, not the download copy", () => {
  const ranked = rankCandidates(
    harvestMediaUrls(TIKTOK_HTML).map((url) => ({ url, from: "page-json", score: 0 })),
    "tiktok"
  );
  assert.match(urls(ranked)[0], /720p\.mp4/);
  assert.match(urls(ranked)[ranked.length - 1], /download/, "downloadAddr is the flakiest copy, so it goes last");
});

test("YouTube prefers a progressive mp4 and drops the manifest", () => {
  const ranked = rankCandidates(
    harvestMediaUrls(YT_HTML).map((url) => ({ url, from: "page-json", score: 0 })),
    "youtube"
  );
  assert.equal(ranked.length, 2);
  assert.match(ranked[0].url, /itag=22/, "720p progressive beats 360p");
});

test("a DRM-tagged YouTube format is pushed down rather than tried first", () => {
  const plain = "https://rr5---sn-a.googlevideo.com/videoplayback?expire=1760000001&itag=18&mime=video%2Fmp4&signature=BB";
  const drm = "https://rr5---sn-a.googlevideo.com/videoplayback?expire=1760000001&itag=18&source=yt_shorts_drm&mime=video%2Fmp4";
  const ranked = rankCandidates(
    [
      { url: drm, from: "network", score: 0 },
      { url: plain, from: "page-json", score: 0 },
    ],
    "youtube"
  );
  assert.equal(ranked[0].url, plain);
});

test("duplicates across sources collapse into one attempt", () => {
  const dup = "https://scontent.cdninstagram.com/vt/16/o1/444.mp4?oh=abc";
  const ranked = rankCandidates(
    [
      { url: dup, from: "page-json", score: 0 },
      { url: dup + "#t=1", from: "network", score: 0 },
      { url: dup, from: "meta", score: 0 },
    ],
    "instagram"
  );
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].url, dup);
});

test("at most four candidates are tried", () => {
  const list = Array.from({ length: 12 }, (_, i) => ({ url: `https://v16-webapp.tiktok.com/a${i}.mp4`, from: "page-json", score: 0 }));
  assert.equal(rankCandidates(list, "tiktok").length, 4);
});

/* --------------------------------- network -------------------------------- */

test("a sniffed response becomes a candidate only when it is worth a try", () => {
  assert.ok(candidateFromResponse("https://x.cdninstagram.com/v/a.mp4", "video/mp4", 4_000_000));
  assert.ok(candidateFromResponse("https://v16-webapp.tiktok.com/o/v0.mp4?a=1", "application/octet-stream", undefined));
  assert.equal(candidateFromResponse("https://p16.tiktokcdn.com/cover.jpg", "image/jpeg", 40_000), null);
  assert.equal(candidateFromResponse("https://v16-webapp.tiktok.com/o/v0.mp4", "video/mp4", 9_000), null, "a 9 KB 'video' is an error page");
});

/* ------------------------------ bytes are honest ------------------------------ */

const ascii = (s) => Buffer.from(s, "latin1");

test("a body is a video only if its container says so", () => {
  assert.equal(looksLikeVideoBytes(Buffer.concat([Buffer.alloc(4), ascii("ftyp"), ascii("isom"), Buffer.alloc(64)])), true);
  assert.equal(looksLikeVideoBytes(Buffer.concat([Buffer.alloc(4), ascii("moov"), Buffer.alloc(64)])), true);
  assert.equal(looksLikeVideoBytes(ascii("<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code></Error>" + " ".repeat(64))), false);
  assert.equal(looksLikeVideoBytes(ascii("<!DOCTYPE html><html><head><title>Login</title>" + " ".repeat(64))), false);
  assert.equal(looksLikeVideoBytes(ascii("ID3\x03\x00\x00" + " ".repeat(64))), true);
  assert.equal(looksLikeVideoBytes(ascii("\x1aE\xdf\xa1\x18\x53\x80" + " ".repeat(64))), true, "webm/EBML is still a video");
  assert.equal(looksLikeVideoBytes(ascii("nope")), false);
});

test("a 403 page and a bot wall are named, not guessed at", () => {
  const err = describeGrabFailure("tiktok", [], null);
  assert.match(err, /TikTok/);
  assert.match(err, /no direct video URL in the page/);
  const err2 = describeGrabFailure("youtube", [{ url: "https://a", from: "page-json", score: 1 }], "HTTP 403");
  assert.match(err2, /fetched 1 candidate/);
  assert.match(err2, /HTTP 403/);
  assert.match(err2, /live browser/);
});

test("YouTube's own verdict is read before we blame our grab", () => {
  const html = `<script>var ytInitialPlayerResponse={"playabilityStatus":{"status":"LOGIN_REQUIRED","reason":"Sign in to confirm you're not a bot"},"streamingData":{}};</script>`;
  const v = youtubePlayability(html);
  assert.equal(v.status, "LOGIN_REQUIRED");
  assert.match(v.reason, /not a bot/);
  assert.equal(youtubePlayability(YT_HTML).status, "OK");
  assert.equal(youtubePlayability("<html>nothing</html>"), null);
});

test("a full-length video is refused before it is downloaded", () => {
  assert.equal(sizeRejection(5_000_000), null);
  assert.match(sizeRejection(400 * 1024 * 1024), /over the 180 MB cap/);
});
