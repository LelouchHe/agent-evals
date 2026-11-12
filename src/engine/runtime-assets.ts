import { extname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a sibling runtime module that is executed separately from this module
 * (a worker, or sandbox-resident supervisor). Source runs use `.ts`; built
 * package runs use emitted `.js`.
 */
export function siblingRuntimeModule(moduleUrl: string, name: string): URL {
  const extension = extname(fileURLToPath(moduleUrl)) === ".ts" ? ".ts" : ".js";
  return new URL(`./${name}${extension}`, moduleUrl);
}
