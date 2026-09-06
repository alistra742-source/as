import type { Candidate, Niche } from "../lib/types";

/**
 * Demo candidates resemble faceless clips the discovery pass would surface
 * (high like counts, comment-verified). Only used in simulated mode so the
 * whole flow is explorable before the Railway worker is connected.
 */
export const DEMO_CANDIDATES: Candidate[] = [
  {
    id: "d1",
    url: "https://www.tiktok.com/@/_demo_/video/7204889162091955400",
    title: "He ordered the same coffee for 10 years — the barista never said a word…",
    niche: "stories",
    likes: 84_200,
    views: 1_240_000,
    comments: 1_872,
  },
  {
    id: "d2",
    url: "https://www.tiktok.com/@/_demo_/video/7204889162091955401",
    title: "3 a.m. in the hospital, floor 4 has no patients. The elevator stopped anyway.",
    niche: "scary",
    likes: 61_700,
    views: 980_000,
    comments: 2_314,
  },
  {
    id: "d3",
    url: "https://www.tiktok.com/@/_demo_/video/7204889162091955402",
    title: "Bananas are berries, but strawberries aren't. Nature was not serious.",
    niche: "facts",
    likes: 52_400,
    views: 810_000,
    comments: 941,
  },
  {
    id: "d4",
    url: "https://www.tiktok.com/@/_demo_/video/7204889162091955403",
    title: "The last voicemail he sent his mom was 'I'll call you back in ten minutes.'",
    niche: "stories",
    likes: 128_900,
    views: 2_100_000,
    comments: 4_105,
  },
  {
    id: "d5",
    url: "https://www.tiktok.com/@/_demo_/video/7204889162091955404",
    title: "Why planes avoid flying over this patch of the Pacific at night",
    niche: "facts",
    likes: 74_300,
    views: 1_060_000,
    comments: 1_203,
  },
  {
    id: "d6",
    url: "https://www.tiktok.com/@/_demo_/video/7204889162091955405",
    title: "She kept hearing footsteps in the attic. The house was one story.",
    niche: "scary",
    likes: 97_800,
    views: 1_540_000,
    comments: 3_882,
  },
];

export const DEMO_HOOKS: Record<Niche, string[]> = {
  stories: [
    "POV: you finally text the number you saved 4 years ago",
    "The friendship ended over a $6 split check",
    "He left a note on her car. She kept it for 20 years.",
  ],
  scary: [
    "The babysitter checked the baby monitor at 2:14 AM…",
    "My GPS said 'arriving' 40 minutes before we got home",
    "The neighbor's dog only barked when HE was in the backyard",
  ],
  facts: [
    "Octopuses have 3 hearts, and 2 stop beating when they swim",
    "Your brain literally cannot feel pain",
    "Cleopatra lived closer to the moon landing than to the pyramids' construction",
  ],
};

export const DEMO_USER = {
  tiktok: "@deck.demo",
  instagram: "deck.demo",
  youtube: "Deck Channel",
};
