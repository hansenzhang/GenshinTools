import { z } from "zod";
import { ELEMENT_KEYS } from "@/domain/enums";

export const ArtifactSetConfigSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("4pc"), setId: z.string() }),
  z.object({
    type: z.literal("2pc+2pc"),
    halfSetIds: z.tuple([z.string(), z.string()]),
  }),
]);

export const TeamSlotConfigSchema = z.object({
  charId: z.string(),
  charLevel: z.number(),
  constellation: z.number().int().min(0).max(6),
  weaponId: z.string(),
  refinement: z.number().int().min(1).max(5),
  artifactSet: ArtifactSetConfigSchema.nullable(),
  talentLevels: z
    .object({ auto: z.number(), skill: z.number(), burst: z.number() })
    .optional(),
});

/** Per-element enemy base RES as fractions (0.1 = 10%). */
export const EnemyResByElementSchema = z.partialRecord(
  z.enum(ELEMENT_KEYS),
  z.number().finite()
);
