import assert from "node:assert/strict";
import test from "node:test";
import {
  cleanDiscoveryTopic,
  discoverySearchUrl,
  fallbackSourceCaption,
  isTopicMatch,
  metadataWatermarkRisk,
  rankDiscoveryCandidates,
  sharesWordRun,
  topicRelevance,
} from "../worker/src/discovery.ts";

const candidate = (title, likes, url = `https://video.test/${encodeURIComponent(title)}`) => ({
  title,
  likes,
  views: likes * 10,
  comments: Math.round(likes / 20),
  url,
});

test("custom topics are bounded and stripped of controls", () => {
  assert.equal(cleanDiscoveryTopic("  donut\u0000  smp \n "), "donut smp");
  assert.equal(cleanDiscoveryTopic("x".repeat(200)).length, 80);
});

test("exact handles and multi-word topics rank by relevance before popularity", () => {
  assert.equal(topicRelevance("drdonutt", "@drdonutt newest Minecraft clip"), 1);
  assert.equal(topicRelevance("donut smp", "wild Donut SMP ending"), 1);
  assert.equal(topicRelevance("donut smp", "unrelated cooking donuts"), 0.5);
  assert.equal(isTopicMatch("donut smp", "unrelated cooking donuts"), false);

  const ranked = rankDiscoveryCandidates(
    [
      candidate("Unrelated viral dance", 9_000_000),
      candidate("Donut recipe with millions of views", 20_000_000),
      candidate("Donut SMP escape", 80_000),
    ],
    "donut smp"
  );
  assert.deepEqual(ranked.map((item) => item.title), ["Donut SMP escape"]);
});

test("metadata watermark indicators are rejected without treating a creator handle itself as a watermark", () => {
  assert.equal(metadataWatermarkRisk("Minecraft clip made with CapCut"), "made with capcut");
  assert.equal(metadataWatermarkRisk("clean clip by @drdonutt"), null);
});

test("fallback caption remains source/topic-derived without copying the source title", () => {
  const source = "I escaped the impossible prison on Donut SMP #minecraft";
  const caption = fallbackSourceCaption("donut smp", source);
  assert.match(caption.toLowerCase(), /donut smp/);
  assert.notEqual(caption.toLowerCase(), source.toLowerCase());
  assert.match(caption.toLowerCase(), /escaped impossible prison/);
  assert.match(caption, /#donutsmp/);
});

test("all three source platforms receive an exact encoded custom search", () => {
  const topic = "donut smp & drdonutt";
  const urls = [
    discoverySearchUrl("tiktok", topic),
    discoverySearchUrl("instagram", topic),
    discoverySearchUrl("youtube", topic),
  ];
  assert.match(urls[0], /tiktok\.com\/search\/video\?/);
  assert.match(urls[1], /instagram\.com\/explore\/search\/keyword\//);
  assert.match(urls[2], /youtube\.com\/results\?/);
  for (const url of urls) {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get(parsed.hostname.includes("youtube") ? "search_query" : "q"), topic);
  }
});

test("caption guard rejects copying five consecutive source words", () => {
  const source = "I escaped the impossible prison on Donut SMP today";
  assert.equal(sharesWordRun(source, "Watch how I escaped the impossible prison on stream", 5), true);
  assert.equal(sharesWordRun(source, "Donut SMP prison escapes get wild", 5), false);
});
