export const MAX_DISCOVERY_TOPIC_CHARS = 80;

export function discoverySearchUrl(platform: "tiktok" | "instagram" | "youtube", rawQuery: string): string {
  const query = cleanDiscoveryTopic(rawQuery);
  if (platform === "tiktok") return `https://www.tiktok.com/search/video?q=${encodeURIComponent(query)}`;
  if (platform === "instagram") return `https://www.instagram.com/explore/search/keyword/?q=${encodeURIComponent(query)}`;
  return `https://www.youtube.com/results?${new URLSearchParams({ search_query: query }).toString()}`;
}

/** Account-persisted free-text search, safe to place in a public search URL. */
export function cleanDiscoveryTopic(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DISCOVERY_TOPIC_CHARS)
    .trim();
}

function searchable(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * 0..1 lexical relevance. Handles are treated as one exact token (`drdonutt`),
 * while phrases such as `donut smp` require all meaningful words to score well.
 */
export function topicRelevance(topic: string, ...evidence: string[]): number {
  const wanted = searchable(cleanDiscoveryTopic(topic));
  if (!wanted) return 1;
  const text = searchable(evidence.join(" "));
  if (!text) return 0;
  if (text.includes(wanted)) return 1;
  const tokens = Array.from(new Set(wanted.split(" ").filter((token) => token.length > 1)));
  if (!tokens.length) return 0;
  const matched = tokens.filter((token) => text.split(" ").some((word) => word === token || word.includes(token))).length;
  return matched / tokens.length;
}

export function isTopicMatch(topic: string, ...evidence: string[]): boolean {
  const wanted = searchable(cleanDiscoveryTopic(topic));
  if (!wanted) return true;
  const tokenCount = wanted.split(" ").filter(Boolean).length;
  const floor = tokenCount <= 2 ? 1 : Math.max(0.67, (tokenCount - 1) / tokenCount);
  return topicRelevance(wanted, ...evidence) >= floor;
}

export interface DiscoveryCandidateLike {
  url: string;
  title: string;
  likes: number;
  views: number;
  comments: number;
}

/** Search relevance dominates; engagement breaks ties between matching clips. */
export function rankDiscoveryCandidates<T extends DiscoveryCandidateLike>(items: T[], topic: string): T[] {
  return items
    .map((item, index) => {
      const relevance = topicRelevance(topic, item.title, item.url);
      const engagement = Math.log10(Math.max(1, item.likes)) * 3 + Math.log10(Math.max(1, item.views));
      return { item, index, score: relevance * 100 + engagement };
    })
    .filter(({ item }) => !topic || isTopicMatch(topic, item.title, item.url))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}

/** Metadata-level first pass; downloaded pixels get a second OCR pass. */
export function metadataWatermarkRisk(...values: string[]): string | null {
  const text = values.join(" ").toLowerCase();
  const match = text.match(/\b(?:watermarked?|tiktok\s*watermark|capcut(?:\s+template)?|made\s+with\s+capcut|repost(?:ed)?\s+with\s+watermark)\b/i);
  return match?.[0] ?? null;
}

export function sharesWordRun(source: string, candidate: string, runLength = 5): boolean {
  const sourceWords = searchable(source).split(" ").filter(Boolean);
  const candidateText = ` ${searchable(candidate)} `;
  if (sourceWords.length < runLength) return false;
  for (let index = 0; index <= sourceWords.length - runLength; index += 1) {
    if (candidateText.includes(` ${sourceWords.slice(index, index + runLength).join(" ")} `)) return true;
  }
  return false;
}

function hashtag(value: string): string {
  return searchable(value).replace(/\s+/g, "").slice(0, 28) || "viral";
}

/** Deterministic no-key fallback that stays topic/source-derived but not copied. */
export function fallbackSourceCaption(topic: string, sourceTitle: string, hook?: string | null): string {
  const cleanedTopic = cleanDiscoveryTopic(topic) || "this moment";
  const source = sourceTitle
    .replace(/\s*[-|·]\s*(?:TikTok|Instagram|YouTube).*$/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/@[a-z0-9_.-]+/gi, "")
    .replace(/#[a-z0-9_]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const topicWords = new Set(searchable(cleanedTopic).split(" "));
  const hookText = cleanDiscoveryTopic(hook);
  const angleBasis = hookText && searchable(hookText) !== searchable(cleanedTopic) ? `${hookText} ${source}` : source;
  const angle = searchable(angleBasis)
    .split(" ")
    .filter((word) => word.length > 2 && !topicWords.has(word) && !/^(?:the|and|this|that|with|from|shorts?|video)$/.test(word))
    .slice(0, 3)
    .join(" ");
  const lead = angle
    ? `${cleanedTopic}: the ${angle} moment gets better the longer you watch`
    : `This ${cleanedTopic} moment gets better the longer you watch`;
  return `${lead} 👀\n\n#${hashtag(cleanedTopic)} #viral #shorts`.slice(0, 220);
}
