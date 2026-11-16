import { Config, type ConfigSnapshot } from "./config.js";
import type { DshContext } from "./host.js";
import { createLoginManager, registerLoginRoutes } from "./login.js";
import { createTools } from "./tools.js";

export { Config };

export const name = "bilibili-subtitles";
export const inject = ["tools", "fs", "workingDirectory", "llm", "credentials", "connection"];

interface VolatileConfig {
  get(): ConfigSnapshot | undefined;
}

export function apply(ctx: DshContext, config: VolatileConfig | undefined): void {
  const snapshot = () => config?.get();
  for (const tool of createTools({ ctx, config: snapshot })) ctx.tools.register(tool);

  const manager = createLoginManager(ctx);
  registerLoginRoutes(ctx, manager);
  ctx.on?.("dispose", () => manager.dispose());
}
