import "@/providers/reference/statLoaders";
import {
  characterStatsResource,
  weaponStatsResource,
} from "@/domain/reference/stats";
import type {
  LevellingMessage,
  LevellingRequest,
} from "@/domain/team/lineupSolverTypes";
import { adviseCandidateLevelling } from "./levellingAdvisor";

self.onmessage = async (
  event: MessageEvent<{ id: number; request: LevellingRequest }>
) => {
  const { id, request } = event.data;
  const report = (message: LevellingMessage) => self.postMessage(message);
  try {
    const [chars] = await Promise.all([
      characterStatsResource.preload(),
      weaponStatsResource.preload(),
    ]);
    report({
      type: "result",
      id,
      advice: adviseCandidateLevelling(request, chars),
    });
  } catch (error) {
    report({
      type: "error",
      id,
      details: error instanceof Error ? error.message : String(error),
    });
  }
};
