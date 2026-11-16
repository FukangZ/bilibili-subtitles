#!/usr/bin/env node
import { runCli } from "./commands.js";

const controller = new AbortController();
const onInterrupt = () => controller.abort();
process.on("SIGINT", onInterrupt);
try {
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
} finally {
  process.off("SIGINT", onInterrupt);
}
