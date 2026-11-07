// zod schemas for custom library sorts (POST /api/sort, and the optional `sort` on
// POST /api/combine). Kept server-side like every other handler schema: src/shared/api.ts is
// bundled into the client, which imports no zod. The rules mirror normalizeSpec in
// src/shared/sortSpec.ts, except that blank groups are rejected here (the client drops them
// before sending, so only a hand-made request has any).
import { z } from "zod";
import {
  SORT_GROUPS_MAX,
  SORT_GROUPS_MIN,
  SORT_GROUP_MAX_CHARS,
  SORT_IDS_MAX,
  SORT_PROMPT_MAX_CHARS,
} from "../../src/shared/api.ts";
import { cleanSortText } from "../../src/shared/sortSpec.ts";
import { isElementId } from "./dto.ts";

/** Cleaned (NFC, no control/format characters, collapsed spaces), then 1..max characters. */
const text = (max: number) =>
  z
    .string()
    .max(max * 4) // generous raw cap: cleaning only ever shortens
    .transform(cleanSortText)
    .pipe(z.string().min(1).max(max));

export const SortSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rank"), prompt: text(SORT_PROMPT_MAX_CHARS) }),
  z.object({
    kind: z.literal("groups"),
    groups: z
      .array(text(SORT_GROUP_MAX_CHARS))
      .min(SORT_GROUPS_MIN)
      .max(SORT_GROUPS_MAX)
      .refine((g) => new Set(g.map((x) => x.toLowerCase())).size === g.length, "duplicate group")
      .refine((g) => g.every((x) => x.toLowerCase() !== "other"), "Other is added automatically"),
  }),
]);

export const SortSchema = z.object({
  spec: SortSpecSchema,
  ids: z.array(z.string().refine(isElementId, "invalid element id")).min(1).max(SORT_IDS_MAX).optional(),
});
