// Pure helpers for custom library sorts ("Sort by anything"), shared by the client and the
// server: text cleaning, validation/normalization, identity (cache key) and labels.
import {
  SORT_GROUPS_MAX,
  SORT_GROUPS_MIN,
  SORT_GROUP_MAX_CHARS,
  SORT_PROMPT_MAX_CHARS,
  type SortSpec,
} from "./api.ts";

/** NFC, control/format/line-separator characters → spaces, collapsed whitespace, trimmed. */
export const cleanSortText = (s: string): string =>
  s
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export type SortSpecProblem = "empty" | "too_long" | "few_groups" | "many_groups" | "duplicate_group" | "other_group";

/**
 * Clean the text and drop blank group rows, then validate. Returns the normalized spec (the
 * exact shape the server accepts) or the first problem found.
 */
export function normalizeSpec(spec: SortSpec): { ok: true; spec: SortSpec } | { ok: false; problem: SortSpecProblem } {
  if (spec.kind === "rank") {
    const prompt = cleanSortText(typeof spec.prompt === "string" ? spec.prompt : "");
    if (!prompt) return { ok: false, problem: "empty" };
    if (prompt.length > SORT_PROMPT_MAX_CHARS) return { ok: false, problem: "too_long" };
    return { ok: true, spec: { kind: "rank", prompt } };
  }
  const groups = (Array.isArray(spec.groups) ? spec.groups : [])
    .map((g) => cleanSortText(typeof g === "string" ? g : ""))
    .filter(Boolean);
  if (groups.some((g) => g.length > SORT_GROUP_MAX_CHARS)) return { ok: false, problem: "too_long" };
  if (groups.some((g) => g.toLowerCase() === "other")) return { ok: false, problem: "other_group" };
  if (new Set(groups.map((g) => g.toLowerCase())).size !== groups.length) return { ok: false, problem: "duplicate_group" };
  if (groups.length < SORT_GROUPS_MIN) return { ok: false, problem: groups.length === 0 ? "empty" : "few_groups" };
  if (groups.length > SORT_GROUPS_MAX) return { ok: false, problem: "many_groups" };
  return { ok: true, spec: { kind: "groups", groups } };
}

/** Identity of a (normalized) spec: case-insensitive, group order matters. */
export const specKey = (s: SortSpec): string =>
  s.kind === "rank" ? `r:${s.prompt.toLowerCase()}` : `g:${s.groups.map((g) => g.toLowerCase()).join("\u0001")}`;

/** Jev questions asked per element (rank: one score; groups: a choice + a companion noul). */
export const questionsPer = (s: SortSpec): number => (s.kind === "groups" ? 2 : 1);

/** Full human label: the rank prompt, or the groups joined with " · ". */
export const specLabel = (s: SortSpec): string => (s.kind === "rank" ? s.prompt : s.groups.join(" · "));

const SHORT_MAX = 12;

/** Compact label for the sort select (shown after "✦ "): ≤ 12 characters plus "…". */
export function specShortLabel(s: SortSpec): string {
  const raw = s.kind === "rank" ? s.prompt.charAt(0).toUpperCase() + s.prompt.slice(1) : `${s.groups[0] ?? ""} +${s.groups.length - 1}`;
  return raw.length > SHORT_MAX ? `${raw.slice(0, SHORT_MAX).trimEnd()}…` : raw;
}
