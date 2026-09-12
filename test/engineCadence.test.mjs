import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const scheduleSource = fs.readFileSync(new URL("../worker/src/engineSchedule.ts", import.meta.url), "utf8");
const scheduleJs = stripTypeScriptTypes(scheduleSource, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const HOUR_MS = 3_600_000;
const schedule = new Function(
  "HOUR_MS",
  `${scheduleJs}; return { ENGINE_LOOP_TICK_MS, DISCOVERY_RETRY_MAX_MS, discoveryRetryMs, initialEngineRunAt, cadenceDurationMs, nextConfirmedPostAt, metricsReadDue, latestConfirmedPostAt };`
)(HOUR_MS);

const engineSource = fs.readFileSync(new URL("../worker/src/engine.ts", import.meta.url), "utf8");
const engineJs = stripTypeScriptTypes(engineSource, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");

const growthStartSource = fs.readFileSync(new URL("../src/state/growthStart.ts", import.meta.url), "utf8");
const growthStartJs = stripTypeScriptTypes(growthStartSource, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const automaticGrowthStartCommands = new Function(
  `${growthStartJs}; return automaticGrowthStartCommands;`
)();

function lifecycle(at = 1_700_000_000_000, posts = []) {
  const rec = {
    running: false,
    phase: "idle",
    nextRunAt: null,
    lastRunAt: null,
    message: null,
    cadenceHours: 1,
    thresholdViews: 3000,
    likesFloor: 50_000,
    topic: "drdonutt",
    niche: "stories",
    errorCount: 0,
    manualResult: null,
  };
  const broadcasts = [];
  const store = {
    engine: () => rec,
    rig: () => ({ loggedIn: true }),
    posts: () => posts,
    save: () => undefined,
    saveImmediate: () => undefined,
  };
  const rig = {
    accountId: "account-one",
    broadcast: (message) => broadcasts.push(message),
  };
  const GrowthEngine = new Function(
    "HOUR_MS",
    "ENGINE_LOOP_TICK_MS",
    "cadenceDurationMs",
    "discoveryRetryMs",
    "initialEngineRunAt",
    "latestConfirmedPostAt",
    "metricsReadDue",
    "nextConfirmedPostAt",
    "now",
    "recoverInterruptedManualResult",
    `${engineJs}; return GrowthEngine;`
  )(
    HOUR_MS,
    schedule.ENGINE_LOOP_TICK_MS,
    schedule.cadenceDurationMs,
    schedule.discoveryRetryMs,
    schedule.initialEngineRunAt,
    schedule.latestConfirmedPostAt,
    schedule.metricsReadDue,
    schedule.nextConfirmedPostAt,
    () => at,
    (result) => result
  );
  const engine = new GrowthEngine("tiktok", store, rig);
  const actualRunCycle = engine.runCycle.bind(engine);
  const cycleReasons = [];
  // Exercise Start itself without invoking network/browser stages. Tests that
  // need the real gate use the bound implementation returned alongside it.
  engine.ensureLoop = () => undefined;
  engine.runCycle = async (reason) => {
    cycleReasons.push(reason);
  };
  return { engine, actualRunCycle, rec, broadcasts, cycleReasons };
}

test("Start queues the first Growth Engine cycle immediately and remains idempotent", () => {
  const at = 1_700_000_000_123;
  const { engine, rec, cycleReasons, broadcasts } = lifecycle(at);
  engine.start();

  assert.equal(rec.running, true);
  assert.equal(rec.phase, "analyzing");
  assert.equal(rec.nextRunAt, at);
  assert.deepEqual(cycleReasons, ["start"]);
  assert.match(rec.message, /starting the first.*drdonutt.*now/i);

  engine.start();
  assert.deepEqual(cycleReasons, ["start"], "a repeated Start must not overlap the active pass");
  assert.equal(broadcasts.filter((m) => m.type === "log" && /Engine armed/.test(m.text)).length, 1);
});

test("Start preserves the remaining hour when history already has a confirmed post", () => {
  const at = 10 * HOUR_MS;
  const postedAt = at - 30 * 60_000;
  const { engine, rec, broadcasts } = lifecycle(at, [{ postedAt, checks: [] }]);
  engine.start();
  assert.equal(rec.phase, "waiting");
  assert.equal(rec.nextRunAt, postedAt + HOUR_MS);
  assert.match(rec.message, /30 min left/);
  assert.equal(broadcasts.filter((m) => m.type === "log" && /preserving the confirmed \+1h boundary/.test(m.text)).length, 1);
});

test("boot migration removes legacy warm-up and cadence jitter", () => {
  const at = 12 * HOUR_MS;
  const first = lifecycle(at);
  first.rec.running = true;
  first.rec.phase = "analyzing";
  first.rec.nextRunAt = at + 8 * 60_000;
  first.engine.resumeFromBoot();
  assert.equal(first.rec.nextRunAt, at, "an unconfirmed legacy first pass resumes now");
  assert.deepEqual(first.cycleReasons, ["boot"]);

  const empty = lifecycle(at);
  empty.rec.running = true;
  empty.rec.phase = "waiting";
  empty.rec.lastRunAt = at - 30_000;
  empty.rec.nextRunAt = at + HOUR_MS;
  empty.engine.resumeFromBoot();
  assert.equal(empty.rec.nextRunAt, at, "a completed empty search reserves no hourly slot and retries after deployment");
  assert.match(empty.rec.message, /no post was confirmed.*retrying now/i);

  const postedAt = at - 20 * 60_000;
  const existing = lifecycle(at, [{ postedAt, checks: [] }]);
  existing.rec.running = true;
  existing.rec.phase = "waiting";
  existing.rec.lastRunAt = postedAt;
  existing.rec.nextRunAt = postedAt + HOUR_MS + 9 * 60_000;
  existing.engine.resumeFromBoot();
  assert.equal(existing.rec.nextRunAt, postedAt + HOUR_MS, "legacy +9 minute jitter is removed");
  assert.equal(existing.rec.phase, "waiting");
});

test("the exact boundary runs Growth AI analysis before posting and never early", async () => {
  const at = 8_000_000;
  const { engine, actualRunCycle, rec, broadcasts } = lifecycle(at);
  const order = [];
  engine.metricsPass = async () => order.push("analyze");
  engine.postingPass = async () => order.push("post");
  rec.running = true;
  rec.phase = "waiting";
  rec.nextRunAt = at + 1;

  await actualRunCycle("test-before-boundary");
  assert.deepEqual(order, []);

  rec.phase = "waiting";
  rec.nextRunAt = at;
  await actualRunCycle("test-at-boundary");
  assert.deepEqual(order, ["analyze", "post"]);
  assert.equal(rec.phase, "analyzing");
  assert.match(rec.message, /full hour finished/i);
  assert.equal(broadcasts.filter((m) => m.type === "log" && /Full one-hour wait finished/.test(m.text)).length, 1);
});

test("Stop is idempotent and says an in-flight exact publish continues", () => {
  const { engine, rec, broadcasts } = lifecycle();
  engine.start();
  engine.manualBusy = true;

  assert.equal(engine.stop(), true);
  assert.equal(rec.running, false);
  assert.equal(rec.phase, "paused");
  assert.match(rec.message, /current publish keeps its exact request until a receipt/i);
  assert.equal(engine.manualBusy, true, "pausing automatic cycles must not cancel the correlated publish");

  assert.equal(engine.stop(), false);
  const pauses = broadcasts.filter((m) => m.type === "log" && /Engine paused/.test(m.text));
  assert.equal(pauses.length, 1, "repeated Stop requests must produce one authoritative pause log");
});

test("empty open-slot discoveries retry promptly without weakening confirmed hourly slots", () => {
  assert.equal(schedule.discoveryRetryMs(1), 60_000);
  assert.equal(schedule.discoveryRetryMs(2), 120_000);
  assert.equal(schedule.discoveryRetryMs(99), schedule.DISCOVERY_RETRY_MAX_MS);
  assert.equal(schedule.DISCOVERY_RETRY_MAX_MS, 5 * 60_000);
});

test("confirmed post slots are exact and never open a millisecond early", () => {
  const postedAt = 42_000;
  const dueAt = schedule.nextConfirmedPostAt(postedAt, 1);
  assert.equal(dueAt, postedAt + HOUR_MS);
  assert.equal(schedule.metricsReadDue(postedAt, null, dueAt - 1), false);
  assert.equal(schedule.metricsReadDue(postedAt, null, dueAt), true);
});

test("later metric reads wait a full hour from the previous read", () => {
  const postedAt = 1000;
  const firstReadAt = postedAt + HOUR_MS + 17_000;
  assert.equal(schedule.metricsReadDue(postedAt, firstReadAt, firstReadAt + HOUR_MS - 1), false);
  assert.equal(schedule.metricsReadDue(postedAt, firstReadAt, firstReadAt + HOUR_MS), true);
});

test("history recovery anchors cadence to the latest confirmed publication", () => {
  const latest = schedule.latestConfirmedPostAt([
    { postedAt: 10 },
    { postedAt: 40 },
    { postedAt: 25 },
  ]);
  assert.equal(latest, 40);
  assert.equal(schedule.nextConfirmedPostAt(latest, 1), 40 + HOUR_MS);
  assert.ok(schedule.ENGINE_LOOP_TICK_MS <= 10_000, "a due boundary should be noticed promptly");
});

test("manual and automatic entry points share the confirmed hourly slot", () => {
  const body = engineSource.slice(engineSource.indexOf("private cadenceBlockMessage"));
  assert.match(body, /nextConfirmedPostAt\(latest, e\.cadenceHours\)/);
  assert.equal(
    [...body.matchAll(/const cadenceBlock = this\.cadenceBlockMessage\(e\)/g)].length,
    2,
    "both exact-link and topic-discovery manual publishes must enforce cadence"
  );
  assert.match(body, /one-post\/hour slot is still reserved/);
});

test("Growth Start configures drdonutt discovery without consuming a stale manual URL", () => {
  const commands = automaticGrowthStartCommands({
    topic: "drdonutt",
    thresholdViews: 3_000,
    likesFloor: 50_000,
    composerUrl: "https://manual.example/previous-video",
  });
  assert.deepEqual(commands, [
    { type: "engine-config", topic: "drdonutt", thresholdViews: 3_000, likesFloor: 50_000 },
    { type: "engine", action: "start" },
  ]);
  assert.equal(commands.some((command) => command.type === "post" || command.type === "discover-post"), false);

  const deck = fs.readFileSync(new URL("../src/state/deck.ts", import.meta.url), "utf8");
  const start = deck.slice(deck.indexOf("startEngine: (p) =>"), deck.indexOf("stopEngine: (p) =>"));
  const configureAt = start.indexOf("sendBusRaw(p, accountId, configureCommand)");
  const armAt = start.indexOf("sendBusRaw(p, accountId, startCommand)");
  assert.ok(configureAt >= 0 && armAt > configureAt);
  assert.match(start, /automaticGrowthStartCommands/);
  assert.doesNotMatch(start, /postNow\(p\)|composer\.url/);
  assert.match(start, /manual source link is not used by Start/);

  const panels = fs.readFileSync(new URL("../src/components/panels.tsx", import.meta.url), "utf8");
  assert.match(panels, /<Play className="size-3\.5" \/> Start Growth AI/);
  assert.match(panels, /Start Growth AI above ignores this link and searches/);
  assert.match(panels, /Post exact video/);
  assert.doesNotMatch(panels, /Post & start/);

  const stop = deck.slice(deck.indexOf("stopEngine: (p) =>"), deck.indexOf("updateEngine: (p, patch)"));
  const live = stop.slice(stop.indexOf('room.session?.mode === "live"'), stop.indexOf("return;", stop.indexOf('room.session?.mode === "live"')) + 7);
  assert.doesNotMatch(live, /logEntry\("warn", "Engine paused/);
  assert.match(stop, /Pause requested — waiting for the worker acknowledgement/);
  assert.match(stop, /let the worker's[\s\S]*single authoritative log\/snapshot/);
});
