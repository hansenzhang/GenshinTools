import { describe, expect, it } from "vitest";
import {
  planAbyssChambers,
  rankAbyssPairings,
  sharedTimerMargin,
} from "@/domain/combat/lineup/abyssPairs";
import {
  canFieldTogether,
  findContestedGear,
} from "@/domain/combat/lineup/candidates";
import type { Slot } from "@/domain/enums";
import type { ArtifactData } from "@/domain/models";
import { createAbyssEncounter } from "@/domain/team/lineup";
import type { CalibratedCandidate } from "@/domain/team/lineupSolverTypes";

const SLOTS: Slot[] = ["flower", "plume", "sands", "goblet", "circlet"];

function piecesOf(prefix: string): Record<Slot, ArtifactData | null> {
  return Object.fromEntries(
    SLOTS.map((slotKey) => [
      slotKey,
      {
        id: `${prefix}-${slotKey}`,
        setKey: "noblesse_oblige",
        slotKey,
        level: 20,
        rarity: 5,
        mainStatKey: "hp",
        lock: false,
        substats: {},
      },
    ])
  ) as Record<Slot, ArtifactData | null>;
}

/** A candidate whose margin follows from its predicted active time. */
function candidate(
  id: string,
  encounterId: string,
  members: [string, string][],
  margin: number,
  barSeconds = 110
): CalibratedCandidate {
  return {
    id,
    templateId: `template-${id}`,
    encounterId,
    members: members.map(([charId, weaponId]) => ({
      charId,
      weaponId,
      refinement: 1,
      artifactSet: null,
      artifacts: piecesOf(`${charId}-${id}`),
    })),
    damage: margin,
    ratio: margin,
    margin,
    activeSeconds: (barSeconds - 10) / margin,
    downtimeSeconds: 10,
    barSeconds,
    origin: "search",
  };
}

const COPIES = { favonius_sword: 1, sacrificial_sword: 2, homa: 1, lance: 1 };

describe("canFieldTogether", () => {
  const a = candidate("a", "e1", [["bennett", "favonius_sword"]], 1);
  it("rejects a character or piece used twice", () => {
    const sameChar = candidate(
      "b",
      "e2",
      [["bennett", "sacrificial_sword"]],
      1
    );
    expect(canFieldTogether([a, sameChar], COPIES)).toBe(false);
    const samePiece: CalibratedCandidate = {
      ...candidate("c", "e2", [["xingqiu", "sacrificial_sword"]], 1),
    };
    samePiece.members[0].artifacts.flower = a.members[0].artifacts.flower;
    expect(canFieldTogether([a, samePiece], COPIES)).toBe(false);
    expect(findContestedGear(samePiece, a, COPIES).artifactIds).toEqual([
      "bennett-a-flower",
    ]);
  });

  it("counts weapon users against owned copies", () => {
    const sharesFavonius = candidate(
      "d",
      "e2",
      [["xingqiu", "favonius_sword"]],
      1
    );
    expect(canFieldTogether([a, sharesFavonius], COPIES)).toBe(false);
    expect(findContestedGear(sharesFavonius, a, COPIES).weaponIds).toEqual([
      "favonius_sword",
    ]);
    const sac = (id: string, charId: string) =>
      candidate(id, "e2", [[charId, "sacrificial_sword"]], 1);
    expect(
      canFieldTogether([sac("e", "xingqiu"), sac("f", "xiangling")], COPIES)
    ).toBe(true);
    expect(
      canFieldTogether(
        [sac("e", "xingqiu"), sac("f", "xiangling"), sac("g", "kaeya")],
        COPIES
      )
    ).toBe(false);
  });
});

describe("rankAbyssPairings", () => {
  const strong = candidate("strong", "e1", [["hu_tao", "homa"]], 1.5);
  const weak = candidate("weak", "e1", [["diluc", "favonius_sword"]], 1.1);
  const usesHomaToo = candidate("homa2", "e2", [["zhongli", "homa"]], 1.4);
  const plain = candidate(
    "plain",
    "e2",
    [["xingqiu", "sacrificial_sword"]],
    1.2
  );

  it("skips pairings that share gear and puts the weaker half first", () => {
    const ranked = rankAbyssPairings(
      [strong, weak],
      [usesHomaToo, plain],
      COPIES,
      "per-half",
      0,
      10
    );
    expect(ranked.map((p) => [p.firstId, p.secondId, p.margin])).toEqual([
      ["strong", "plain", 1.2],
      ["weak", "homa2", 1.1],
      ["weak", "plain", 1.1],
    ]);
  });

  it("breaks a tie on the weaker half with the stronger half", () => {
    const close = candidate("close", "e1", [["diluc", "favonius_sword"]], 1.19);
    const ranked = rankAbyssPairings(
      [close, strong],
      [plain],
      COPIES,
      "per-half",
      3,
      2
    );
    // 1.19 is within 3% of 1.2, so the 1.5 partner decides.
    expect(ranked.map((p) => p.firstId)).toEqual(["strong", "close"]);
  });

  it("ranks by summed time under a shared timer", () => {
    // fast1 and steady2 both need Kazuha. Per half, steady1 + steady2 keeps
    // both halves at 1.1 or better; with one timer, fast1's spare time
    // carries the 0.9 half: 200 / (100/2 + 100/0.9) ≈ 1.24 vs ≈ 1.15.
    const fast1 = candidate("fast1", "e1", [["kazuha", "favonius_sword"]], 2);
    const steady1 = candidate("steady1", "e1", [["diluc", "homa"]], 1.2);
    const slow2 = candidate("slow2", "e2", [["xingqiu", "lance"]], 0.9);
    const steady2 = candidate(
      "steady2",
      "e2",
      [["kazuha", "sacrificial_sword"]],
      1.1
    );
    expect(sharedTimerMargin([fast1, slow2])).toBeCloseTo(
      200 / (100 / 2 + 100 / 0.9),
      10
    );
    const rank = (rule: "per-half" | "shared") =>
      rankAbyssPairings(
        [fast1, steady1],
        [slow2, steady2],
        COPIES,
        rule,
        0,
        1
      ).map((p) => [p.firstId, p.secondId]);
    expect(rank("per-half")).toEqual([["steady1", "steady2"]]);
    expect(rank("shared")).toEqual([["fast1", "slow2"]]);
  });

  it("lists single candidates when one half has none", () => {
    expect(
      rankAbyssPairings([weak, strong], [], COPIES, "per-half", 0, 5).map(
        (p) => [p.firstId, p.secondId]
      )
    ).toEqual([
      ["strong", null],
      ["weak", null],
    ]);
  });
});

describe("planAbyssChambers", () => {
  it("plans each chamber from its halves' candidates", () => {
    const encounters = [
      createAbyssEncounter("e2", 1, 2),
      createAbyssEncounter("e1", 1, 1),
      createAbyssEncounter("e3", 3, 1),
    ];
    const plans = planAbyssChambers(
      encounters,
      [
        candidate("a", "e1", [["hu_tao", "homa"]], 1.3),
        candidate("b", "e2", [["hu_tao", "homa"]], 1.4),
        candidate("c", "e3", [["xingqiu", "sacrificial_sword"]], 0.9),
      ],
      COPIES,
      "per-half",
      3,
      4
    );
    expect(plans.map((plan) => plan.chamber)).toEqual([1, 3]);
    expect(plans[0]).toMatchObject({
      firstEncounterId: "e1",
      secondEncounterId: "e2",
      pairings: [],
      bestAlone: { first: 1.3, second: 1.4 },
    });
    expect(plans[1]).toMatchObject({
      secondEncounterId: null,
      pairings: [{ firstId: "c", secondId: null, margin: 0.9 }],
    });
  });
});

describe("rankAbyssPairings equivalents", () => {
  it("drops pairings the model cannot tell apart from a better one", () => {
    const sameTeam = (id: string, margin: number, charId = "hu_tao") => ({
      ...candidate(id, "e1", [[charId, "homa"]], margin),
      templateId: "template-hu-tao",
    });
    const partner = candidate("partner", "e2", [["xingqiu", "lance"]], 1);
    const ranked = rankAbyssPairings(
      [
        sameTeam("best", 1.5),
        sameTeam("twin", 1.49),
        sameTeam("other-member", 1.48, "diluc"),
        sameTeam("weaker", 1.3),
      ],
      [partner],
      COPIES,
      "per-half",
      3,
      10
    );
    expect(ranked.map((pairing) => pairing.firstId)).toEqual([
      "best",
      "other-member",
      "weaker",
    ]);
  });
});
