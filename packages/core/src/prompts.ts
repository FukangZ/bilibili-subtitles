import { readFileSync } from "node:fs";

export interface Prompts {
  structure: string;
  polish: string;
}

/** Works from both src/ and the published dist/ directory. */
export function loadPrompts(): Prompts {
  return {
    structure: readFileSync(new URL("../prompts/structure.md", import.meta.url), "utf8"),
    polish: readFileSync(new URL("../prompts/polish.md", import.meta.url), "utf8"),
  };
}
