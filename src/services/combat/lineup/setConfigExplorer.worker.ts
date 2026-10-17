import "@/providers/reference/statLoaders";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  SetConfigExplorerMessage,
  SetConfigExplorerRequest,
} from "../../../domain/team/setConfigExplorerTypes";
import { runSetConfigExplorer } from "./setConfigExplorer";

self.onmessage = async (event: MessageEvent<SetConfigExplorerRequest>) => {
  const report = (message: SetConfigExplorerMessage) =>
    self.postMessage(message);
  try {
    const [chars] = await Promise.all([
      characterStatsResource.preload(),
      weaponStatsResource.preload(),
    ]);
    await runSetConfigExplorer(event.data, chars, report);
  } catch (error) {
    report({
      type: "error",
      reason: "calculator-error",
      details: error instanceof Error ? error.message : String(error),
    });
  }
};
