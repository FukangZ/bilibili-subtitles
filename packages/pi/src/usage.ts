import type { Usage } from "@earendil-works/pi-ai";
import type { Usage as CoreUsage } from "@fukangz/core-bilibili-subtitles";

/** Pi requires prices even when the adapter cannot report them. */
export function toPiUsage(usage: CoreUsage): Usage {
  return {
    ...usage,
    cost: usage.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
