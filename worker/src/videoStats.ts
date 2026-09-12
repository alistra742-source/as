export interface PublicVideoStats {
  views: number | null;
  likes: number | null;
  comments: number | null;
}

export interface PublicMetricEvidence {
  videoId?: string;
  descriptions?: string[];
  bodyText?: string;
  likeTexts?: string[];
  viewTexts?: string[];
  commentTexts?: string[];
  jsonTexts?: string[];
}

function count(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return null;
  const suffix = match[2]?.toUpperCase();
  const multiplier = suffix === "K" ? 1_000 : suffix === "M" ? 1_000_000 : suffix === "B" ? 1_000_000_000 : 1;
  return Math.round(amount * multiplier);
}

function firstCount(values: string[] | undefined): number | null {
  for (const value of values ?? []) {
    const parsed = count(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function labeledCount(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const after = text.match(new RegExp(`([\\d.,]+\\s*[KMB]?)\\s*${label}`, "i"));
    if (after) return count(after[1]);
    const before = text.match(new RegExp(`${label}[^\\d]{0,24}([\\d.,]+\\s*[KMB]?)`, "i"));
    if (before) return count(before[1]);
  }
  return null;
}

interface StructuredCandidate extends PublicVideoStats {
  id: string;
  exact: boolean;
}

const LIKE_KEYS = ["diggCount", "likeCount", "likes", "like_count"];
const VIEW_KEYS = ["playCount", "viewCount", "views", "video_view_count", "play_count"];
const COMMENT_KEYS = ["commentCount", "comments", "comment_count"];
const ID_KEYS = ["id", "itemId", "item_id", "aweme_id", "videoId", "video_id"];

function keyedCount(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    if (!(key in record)) continue;
    const parsed = count(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function candidateFrom(record: Record<string, unknown>, parentId: string, wantedId: string): StructuredCandidate | null {
  let id = parentId;
  for (const key of ID_KEYS) {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
      id = String(value);
      break;
    }
  }
  const likes = keyedCount(record, LIKE_KEYS);
  const views = keyedCount(record, VIEW_KEYS);
  const comments = keyedCount(record, COMMENT_KEYS);
  if (likes === null && views === null && comments === null) return null;
  return { id, exact: !!wantedId && id === wantedId, likes, views, comments };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Extract the current video's counters from TikTok/Instagram hydration JSON. */
export function structuredVideoStats(jsonTexts: string[] | undefined, videoId = ""): PublicVideoStats {
  const candidates: StructuredCandidate[] = [];
  let visited = 0;
  const visit = (value: unknown, inheritedId = "", depth = 0) => {
    if (value === null || typeof value !== "object" || depth > 18 || visited > 80_000) return;
    visited += 1;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, inheritedId, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    let ownId = inheritedId;
    for (const key of ID_KEYS) {
      const id = record[key];
      if (typeof id === "string" || typeof id === "number") {
        ownId = String(id);
        break;
      }
    }
    const direct = candidateFrom(record, ownId, videoId);
    if (direct) candidates.push(direct);
    const stats = record.stats;
    if (stats && typeof stats === "object" && !Array.isArray(stats)) {
      const nested = candidateFrom(stats as Record<string, unknown>, ownId, videoId);
      if (nested) candidates.push(nested);
    }
    for (const child of Object.values(record)) visit(child, ownId, depth + 1);
  };

  for (const text of jsonTexts ?? []) {
    const parsed = parseJson(text);
    if (parsed !== null) visit(parsed);
  }
  candidates.sort((a, b) => {
    const score = (item: StructuredCandidate) =>
      (item.exact ? 1_000 : 0) + (item.likes !== null ? 100 : 0) + (item.views !== null ? 10 : 0) + (item.comments !== null ? 1 : 0);
    return score(b) - score(a);
  });
  const best = candidates[0];
  return best ? { views: best.views, likes: best.likes, comments: best.comments } : { views: null, likes: null, comments: null };
}

/** Prefer visible current-post controls, then hydration JSON, then labeled metadata. */
export function publicVideoStats(evidence: PublicMetricEvidence): PublicVideoStats {
  const structured = structuredVideoStats(evidence.jsonTexts, evidence.videoId);
  const text = [...(evidence.descriptions ?? []), evidence.bodyText ?? ""].join(" ");
  return {
    likes: firstCount(evidence.likeTexts) ?? structured.likes ?? labeledCount(text, ["likes?", "hearts?"]),
    views: firstCount(evidence.viewTexts) ?? structured.views ?? labeledCount(text, ["views?", "plays?"]),
    comments: firstCount(evidence.commentTexts) ?? structured.comments ?? labeledCount(text, ["comments?", "replies"]),
  };
}
