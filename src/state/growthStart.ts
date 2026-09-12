import type { ClientMsg } from "../lib/protocol";

export interface GrowthStartConfig {
  topic: string;
  thresholdViews: number;
  likesFloor: number;
}

/**
 * Growth Start is intentionally only an automatic-discovery operation.
 * Manual composer fields are not inputs, so a stale exact-source draft cannot
 * be turned into a `post` command when the hourly engine is armed.
 */
export function automaticGrowthStartCommands(config: GrowthStartConfig): ClientMsg[] {
  return [
    {
      type: "engine-config",
      topic: config.topic,
      thresholdViews: config.thresholdViews,
      likesFloor: config.likesFloor,
    },
    { type: "engine", action: "start" },
  ];
}
