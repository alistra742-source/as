import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/tiktokProfile.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" });
const { tiktokProfileItemsPage } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

async function collect(hydration, fetchImpl) {
  const text = JSON.stringify(hydration);
  const context = {
    document: { scripts: [{ textContent: text }] },
    fetch: fetchImpl,
    URLSearchParams,
  };
  const result = await vm.runInNewContext(`(${tiktokProfileItemsPage.toString()})("drdonutt")`, context);
  return JSON.parse(JSON.stringify(result));
}

test("profile hydration secUid drives a same-origin item_list request and maps exact counters", async () => {
  const requests = [];
  const results = await collect(
    { userInfo: { user: { uniqueId: "drdonutt", secUid: "MS4wLjABAAAA profile key" } } },
    async (url, options) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          return {
            itemList: [
              {
                id: "7520100654828883213",
                desc: "This trap changed the whole Donut SMP fight",
                author: { uniqueId: "drdonutt" },
                stats: { diggCount: "188400", playCount: 2700000, commentCount: 3481 },
              },
              {
                id: "7425457401735728426",
                desc: "Unrelated recommended creator",
                author: { uniqueId: "somebodyelse" },
                stats: { diggCount: 999999, playCount: 9000000, commentCount: 1 },
              },
            ],
          };
        },
      };
    }
  );

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/api\/post\/item_list\//);
  assert.match(requests[0].url, /secUid=MS4wLjABAAAA\+profile\+key/);
  assert.equal(requests[0].options.credentials, "include");
  assert.deepEqual(results, [
    {
      url: "https://www.tiktok.com/@drdonutt/video/7520100654828883213",
      label: "@drdonutt This trap changed the whole Donut SMP fight",
      likes: 188400,
      views: 2700000,
      comments: 3481,
    },
  ]);
});

test("hydrated profile items remain usable when TikTok's item_list request fails", async () => {
  const hydratedItem = {
    id: "7403603472911764778",
    desc: "Donut SMP vault defense",
    author: { uniqueId: "drdonutt" },
    stats: { diggCount: 68800, playCount: 633300, commentCount: 233 },
  };
  const results = await collect(
    {
      userInfo: { user: { uniqueId: "drdonutt", secUid: "profile-sec-uid" } },
      itemModule: { [hydratedItem.id]: hydratedItem },
    },
    async () => {
      throw new Error("challenge blocked the endpoint");
    }
  );

  assert.deepEqual(results, [
    {
      url: "https://www.tiktok.com/@drdonutt/video/7403603472911764778",
      label: "@drdonutt Donut SMP vault defense",
      likes: 68800,
      views: 633300,
      comments: 233,
    },
  ]);
});

test("malformed ids and another creator's hydration rows are rejected", async () => {
  let fetched = false;
  const results = await collect(
    {
      unrelated: { secUid: "not-the-profile-user" },
      malformed: { id: "not-a-video", author: { uniqueId: "drdonutt" }, stats: { diggCount: 999999 } },
      recommendation: {
        id: "7520100654828883213",
        author: { uniqueId: "othercreator" },
        stats: { diggCount: 999999 },
      },
    },
    async () => {
      fetched = true;
      throw new Error("must not fetch without the exact profile secUid");
    }
  );

  assert.equal(fetched, false);
  assert.deepEqual(results, []);
});
