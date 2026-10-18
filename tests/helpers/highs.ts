import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import loadHighs from "highs";

/** HiGHS loaded from its packaged Wasm, since the jsdom test environment
 *  looks like a browser to the loader. */
export function loadTestHighs() {
  const wasmPath = createRequire(import.meta.url).resolve("highs/runtime");
  return loadHighs({ wasmBinary: readFileSync(wasmPath) });
}
