import Groq from "groq-sdk";
import { env } from "./config.js";

const groq = env.groqKey ? new Groq({ apiKey: env.groqKey }) : null;

export function groqAvailable(): boolean {
  return !!groq;
}

async function chatJson(system: string, user: string): Promise<Record<string, unknown> | null> {
  if (!groq) return null;
  try {
    const res = await groq.chat.completions.create({
      model: env.groqModel,
      temperature: 0.4,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      return m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
    }
  } catch (e) {
    console.warn("[groq] call failed:", (e as Error).message);
    return null;
  }
}

export interface CandidateJudge {
  verdict: "post" | "skip";
  reason: string;
  caption: string | null;
  angle: string | null;
}

export async function judgeCandidate(args: {
  niche: string;
  title: string;
  likes: number;
  views: number;
  comments: number;
  commentSample: string;
}): Promise<CandidateJudge> {
  const fallback: CandidateJudge = {
    verdict: args.likes >= 50_000 && args.comments / Math.max(1, args.likes) > 0.015 ? "post" : "skip",
    reason:
      args.likes >= 50_000
        ? "50K+ likes with engaged comments — within quality bar."
        : "Under the 50K likes quality floor.",
    caption: null,
    angle: args.niche,
  };
  const json = await chatJson(
    "You run a faceless content growth engine. Judge ONE candidate video for reposting. Reply ONLY JSON with keys: verdict (\"post\"|\"skip\"), reason (1 sentence), caption (a ready-to-paste caption with 3 hashtags, or null if skipping), angle (the storytelling hook, or null).",
    `Niche: ${args.niche}\nTitle/description: ${args.title}\nStats: ${args.likes} likes, ${args.views} views, ${args.comments} comments.\nSample comments: ${args.commentSample.slice(0, 800)}`
  );
  if (!json) return fallback;
  return {
    verdict: json.verdict === "post" ? "post" : "skip",
    reason: typeof json.reason === "string" ? json.reason : fallback.reason,
    caption: typeof json.caption === "string" ? json.caption : null,
    angle: typeof json.angle === "string" ? json.angle : args.niche,
  };
}

export interface MetricsVerdict {
  hit: boolean;
  verdict: string;
  nextAngle: string | null;
}

export async function interpretMetrics(args: {
  views: number;
  likes: number;
  comments: number;
  threshold: number;
  niche: string;
  priorVerdict: string | null;
}): Promise<MetricsVerdict> {
  const fallback: MetricsVerdict = {
    hit: args.views >= args.threshold,
    verdict:
      args.views >= args.threshold
        ? `🔥 ${args.views.toLocaleString()} views — crossed the ${args.threshold.toLocaleString()}/hr target. Engine doubles down on similar content.`
        : `📉 ${args.views.toLocaleString()} views in the window — under target. Keeping cadence, testing a fresh angle.`,
    nextAngle: null,
  };
  const json = await chatJson(
    "You read a posted video's first-hour performance. Reply ONLY JSON: hit (boolean: views >= threshold), verdict (one punchy sentence for the activity log), nextAngle (string: the content angle to pursue next, or null to stay).",
    `Views: ${args.views} | Likes: ${args.likes} | Comments: ${args.comments} | Threshold: ${args.threshold} views/hour | Current niche: ${args.niche}\nPrior engine note: ${args.priorVerdict ?? "none"}`
  );
  if (!json) return fallback;
  return {
    hit: json.hit === true || args.views >= args.threshold,
    verdict: typeof json.verdict === "string" ? json.verdict : fallback.verdict,
    nextAngle: typeof json.nextAngle === "string" ? json.nextAngle : null,
  };
}

export async function writeCaption(args: { niche: string; hook?: string | null }): Promise<string> {
  const hooks: Record<string, string> = {
    stories: "POV: it all changed with one text",
    scary: "The door was locked from the inside. Nobody was home.",
    facts: "Your brain does something wild every time you read this",
  };
  const fallback = `${args.hook ?? hooks[args.niche] ?? "Watch until the end"}\n\n#fyp #viral #${args.niche}`;
  const json = await chatJson(
    "You write captions for faceless short-form videos. Reply ONLY JSON: caption (string, max 90 chars + 3 hashtags, an open loop that makes people watch twice).",
    `Niche: ${args.niche}${args.hook ? `\nHook/angle: ${args.hook}` : ""}`
  );
  if (!json || typeof json.caption !== "string") return fallback;
  return json.caption;
}
