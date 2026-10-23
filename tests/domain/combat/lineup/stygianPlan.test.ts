import { describe, expect, it } from "vitest";
import type { MilpModel } from "@/domain/combat/lineup/milpModel";
import { planStygianRun } from "@/domain/combat/lineup/stygianPlan";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import type {
  CalibratedCandidate,
  StygianPlanRequest,
} from "@/domain/team/lineupSolverTypes";
import { solveMilp } from "@/services/combat/lineup/highsSolver";
import { loadTestHighs } from "../../../helpers/highs";

const highs = await loadTestHighs();
const solve = (model: MilpModel) => solveMilp(highs, model);

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];

/** A candidate fielding `charIds`, each with its own pieces and weapon
 *  unless `shared` names a piece id or weapon to use instead. */
function candidate(
  id: string,
  encounterId: string,
  margin: number,
  charIds: string[],
  shared: { piece?: string; weapon?: string } = {}
): CalibratedCandidate {
  return {
    id,
    templateId: `template-${encounterId}`,
    encounterId,
    members: charIds.map((charId, index) => ({
      charId,
      weaponId:
        index === 0 && shared.weapon ? shared.weapon : `${id}-${charId}-w`,
      refinement: 1,
      artifactSet: null,
      artifacts: Object.fromEntries(
        SLOTS.map((slotKey) => [
          slotKey,
          {
            id:
              index === 0 && slotKey === "flower" && shared.piece
                ? shared.piece
                : `${id}-${charId}-${slotKey}`,
            setKey: "noblesse_oblige",
            slotKey,
            level: 20,
            rarity: 5,
            mainStatKey: "hp",
            lock: false,
            substats: {},
          },
        ])
      ) as Record<Slot, ArtifactData | null>,
      anyPieces: false,
    })),
    damage: margin,
    ratio: margin,
    origin: "search",
    margin,
    activeSeconds: 100 / margin,
    downtimeSeconds: 10,
    barSeconds: 110,
  };
}

function request(
  candidates: CalibratedCandidate[],
  weaponCopies: Record<string, number> = {}
): StygianPlanRequest {
  const copies: Record<string, number> = { ...weaponCopies };
  for (const c of candidates)
    for (const member of c.members) copies[member.weaponId] ??= 1;
  return {
    encounterIds: ["a", "b", "c"],
    candidates,
    weaponCopies: copies,
    tiePercent: 3,
  };
}

describe("planStygianRun", () => {
  it("gives a shared character to the team that lifts the weakest boss", () => {
    const result = planStygianRun(
      request([
        candidate("a1", "a", 1.5, ["bennett", "xiangling"]),
        candidate("a2", "a", 1.2, ["kazuha", "xiangling"]),
        candidate("b1", "b", 1.4, ["bennett", "neuvillette"]),
        candidate("b2", "b", 1.0, ["sucrose", "neuvillette"]),
        candidate("c1", "c", 1.3, ["raiden"]),
      ]),
      solve
    );
    expect(result.plans).toEqual([
      {
        kind: "leximin",
        candidateIds: { a: "a2", b: "b1", c: "c1" },
        weakest: 1.2,
      },
    ]);
    // Without Bennett the best lineup is a2 + b2: its weakest boss is at 1.0.
    expect(result.binding).toContainEqual({
      kind: "character",
      id: "bennett",
      marginWithout: 1,
    });
    expect(result.binding[0]).toMatchObject({ kind: "character" });
  });

  it("lifts the next boss when the weakest margins are tied", () => {
    const result = planStygianRun(
      request([
        candidate("a1", "a", 1.2, ["bennett"]),
        candidate("a2", "a", 1.19, ["kazuha"]),
        candidate("b1", "b", 1.21, ["xingqiu"]),
        candidate("b2", "b", 1.5, ["bennett"]),
        candidate("c1", "c", 2, ["raiden"]),
      ]),
      solve
    );
    // 1.19 is within 3% of 1.2, so b's 1.5 decides.
    expect(result.plans[0].candidateIds).toEqual({ a: "a2", b: "b2", c: "c1" });
  });

  it("never gives up a clear for a tie", () => {
    const result = planStygianRun(
      request([
        candidate("a1", "a", 1.01, ["bennett"]),
        candidate("a2", "a", 0.99, ["kazuha"]),
        candidate("b1", "b", 1.01, ["xingqiu"]),
        candidate("b2", "b", 2, ["bennett"]),
        candidate("c1", "c", 3, ["raiden"]),
      ]),
      solve
    );
    expect(result.plans[0].candidateIds).toEqual({ a: "a1", b: "b1", c: "c1" });
  });

  it("leads with the smallest total shortfall when no lineup clears", () => {
    const result = planStygianRun(
      request([
        candidate("a1", "a", 1.2, ["bennett"]),
        candidate("a2", "a", 0.7, ["kazuha"]),
        candidate("b1", "b", 0.7, ["bennett"]),
        candidate("b2", "b", 0.5, ["xingqiu"]),
        candidate("c1", "c", 1.3, ["raiden"]),
      ]),
      solve
    );
    expect(result.plans).toEqual([
      // Short by 0.5 in total instead of 0.3 + 0.3.
      {
        kind: "shortfall",
        candidateIds: { a: "a1", b: "b2", c: "c1" },
        weakest: 0.5,
      },
      {
        kind: "leximin",
        candidateIds: { a: "a2", b: "b1", c: "c1" },
        weakest: 0.7,
      },
    ]);
  });

  it("counts pieces and weapon copies across bosses", () => {
    const greatPiece = { piece: "great-flower" };
    const pieces = planStygianRun(
      request([
        candidate("a1", "a", 1.5, ["hu_tao"], greatPiece),
        candidate("a2", "a", 1.1, ["hu_tao"]),
        candidate("b1", "b", 1.4, ["diluc"], greatPiece),
        candidate("b2", "b", 1.3, ["diluc"]),
        candidate("c1", "c", 2, ["raiden"]),
      ]),
      solve
    );
    expect(pieces.plans[0].candidateIds).toEqual({ a: "a1", b: "b2", c: "c1" });
    expect(pieces.binding).toContainEqual({
      kind: "artifact",
      id: "great-flower",
      marginWithout: 1.1,
    });

    const favonius = { weapon: "favonius_sword" };
    const lineup = [
      candidate("a1", "a", 1.5, ["bennett"], favonius),
      candidate("a2", "a", 1.1, ["bennett"]),
      candidate("b1", "b", 1.4, ["xingqiu"], favonius),
      candidate("b2", "b", 1.3, ["xingqiu"]),
      candidate("c1", "c", 2, ["raiden"]),
    ];
    expect(
      planStygianRun(request(lineup, { favonius_sword: 1 }), solve).plans[0]
        .candidateIds
    ).toEqual({ a: "a1", b: "b2", c: "c1" });
    const twoCopies = planStygianRun(
      request(lineup, { favonius_sword: 2 }),
      solve
    );
    expect(twoCopies.plans[0].candidateIds).toEqual({
      a: "a1",
      b: "b1",
      c: "c1",
    });
    // Losing one of the two copies sends b back to b2.
    expect(twoCopies.binding).toContainEqual({
      kind: "weapon",
      id: "favonius_sword",
      marginWithout: expect.closeTo(1.3, 6),
    });
  });

  it("plans the bosses that have candidates", () => {
    const result = planStygianRun(
      request([
        candidate("a1", "a", 1.5, ["bennett"]),
        candidate("c1", "c", 1.3, ["raiden"]),
      ]),
      solve
    );
    expect(result.missingEncounterIds).toEqual(["b"]);
    expect(result.plans[0].candidateIds).toEqual({ a: "a1", c: "c1" });
    expect(result.binding).toEqual([]);
  });

  it("bounds members that take any pieces by the pieces of their set", () => {
    // a1's and b1's supports only need four Tenacity pieces each, and wear
    // the same flower.
    const TENACITY = "tenacity_of_the_millelith";
    const loose = (entry: CalibratedCandidate): CalibratedCandidate => ({
      ...entry,
      members: entry.members.map((member) => ({
        ...member,
        anyPieces: true,
        artifactSet: { type: "4pc", setId: TENACITY },
        artifacts: Object.fromEntries(
          Object.entries(member.artifacts).map(([slot, artifact]) => [
            slot,
            artifact && { ...artifact, setKey: TENACITY },
          ])
        ) as Record<Slot, ArtifactData | null>,
      })),
    });
    const lineup = [
      loose(candidate("a1", "a", 1.5, ["bennett"], { piece: "flower" })),
      loose(candidate("b1", "b", 1.4, ["diona"], { piece: "flower" })),
      candidate("b2", "b", 1.1, ["layla"]),
      candidate("c1", "c", 1.3, ["raiden"]),
    ];
    const counts = (perSlot: number) =>
      Object.fromEntries(
        SLOTS.flatMap((slot) => [
          [`${TENACITY}:${slot}`, perSlot],
          [`noblesse_oblige:${slot}`, 10],
        ])
      );
    const plenty = planStygianRun(
      { ...request(lineup), setSlotCounts: counts(2) },
      solve
    );
    expect(plenty.plans[0].candidateIds).toEqual({
      a: "a1",
      b: "b1",
      c: "c1",
    });
    // The shared flower is not contested: either support takes another.
    expect(plenty.binding).toEqual([]);
    const scarce = planStygianRun(
      { ...request(lineup), setSlotCounts: counts(1) },
      solve
    );
    expect(scarce.plans[0].candidateIds).toEqual({
      a: "a1",
      b: "b2",
      c: "c1",
    });
  });
});
