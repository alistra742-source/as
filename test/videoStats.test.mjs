import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { publicVideoStats, structuredVideoStats } from "../worker/src/videoStats.ts";

const browserSource = fs.readFileSync(new URL("../worker/src/browser.ts", import.meta.url), "utf8");
const profileSource = fs.readFileSync(new URL("../worker/src/tiktokProfile.ts", import.meta.url), "utf8");

test("topic discovery combines direct creator profiles with current TikTok counter evidence", () => {
  const discovery = browserSource.slice(browserSource.indexOf("export async function scrapeCandidates"), browserSource.indexOf("async function scrapeYouTubeCandidates"));
  assert.match(discovery, /directTopicProfileUrl\(platform, topic\)/);
  assert.match(discovery, /tiktokProfileItemsPage/);
  assert.match(profileSource, /hydratedItems/);
  assert.match(profileSource, /\/api\/post\/item_list\//);
  assert.match(profileSource, /secUid/);
  assert.match(profileSource, /stats\.diggCount/);
  assert.match(discovery, /const items = \[\.\.\.profileItems, \.\.\.searchItems\]/);

  const stats = browserSource.slice(browserSource.indexOf("export async function readVideoStats"));
  assert.match(stats, /data-e2e="like-count"/);
  assert.match(stats, /publicVideoStats\(evidence\)/);
});

test("TikTok visible counters satisfy the configured likes quality floor", () => {
  assert.deepEqual(
    publicVideoStats({
      videoId: "7403603472911764778",
      likeTexts: ["232K"],
      commentTexts: ["3,481"],
      viewTexts: ["2.7M views"],
    }),
    { likes: 232_000, views: 2_700_000, comments: 3_481 }
  );
});

test("TikTok metadata descriptions expose likes when current DOM counters are hidden", () => {
  assert.deepEqual(
    publicVideoStats({
      descriptions: [
        "184.9K Likes, 3232 Comments. TikTok video from DrDonut (@drdonutt): Explore the world of Donut SMP.",
      ],
    }),
    { likes: 184_900, views: null, comments: 3_232 }
  );
});

test("hydration data selects the current video instead of a recommended clip", () => {
  const json = JSON.stringify({
    recommendations: [{ id: "other", stats: { diggCount: 900_000, playCount: 8_000_000, commentCount: 12_000 } }],
    itemInfo: {
      itemStruct: {
        id: "7403603472911764778",
        stats: { diggCount: 68_800, playCount: 633_300, commentCount: 233 },
      },
    },
  });
  assert.deepEqual(structuredVideoStats([json], "7403603472911764778"), {
    likes: 68_800,
    views: 633_300,
    comments: 233,
  });
});

test("visible current-post controls take precedence over unrelated hydration counters", () => {
  const json = JSON.stringify({ id: "other", stats: { diggCount: 999_999, playCount: 9_999_999, commentCount: 999 } });
  assert.deepEqual(
    publicVideoStats({
      videoId: "current",
      likeTexts: ["85.6K"],
      commentTexts: ["912"],
      jsonTexts: [json],
    }),
    { likes: 85_600, views: 9_999_999, comments: 912 }
  );
});
