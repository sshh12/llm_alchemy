// Server-backed game state: the element catalog this client knows about, the player's
// library, stats, today's challenge, history and the "fresh from the lab" feed.
// Elements are normalized by id so art updates touch exactly one record.
import { create } from "zustand";
import { track } from "../lib/analytics.ts";
import type {
  BootstrapResponse,
  ChallengeHistoryDay,
  CombineResponse,
  DailyChallengeDTO,
  ElementDTO,
  ElementId,
  Stats,
  Tier,
} from "../../shared/api.ts";
import { localDay } from "../../shared/dates.ts";
import { ApiFailure, bootstrap, type FailureCode } from "../lib/api.ts";
import { markLegacyImported, readLegacy } from "../lib/legacy.ts";

export interface Owned {
  discoveredAt: string;
  first: boolean;
}

export interface GameState {
  status: "booting" | "ready" | "error";
  /** The server asked for proof-of-work; the worker is solving it. */
  powSolving: boolean;
  bootError: FailureCode | null;
  player: BootstrapResponse["player"] | null;
  elements: Record<ElementId, ElementDTO>;
  owned: Record<ElementId, Owned>;
  stats: Stats;
  challenge: DailyChallengeDTO | null;
  history: ChallengeHistoryDay[];
  recent: ElementId[];
  /** Local day the loaded challenge belongs to. */
  day: string;
  /**
   * Set when this load adopted/imported 2023 progress (drives the one-time welcome-back notice).
   * `claimedElsewhere`: the legacy player is bound to another browser; this one got a copy of the elements.
   */
  legacyWelcome: { restored: number; claimedElsewhere?: boolean } | null;
}

const EMPTY_STATS: Stats = { known: 0, mine: 0, firsts: 0, challengesCompleted: 0, streak: { current: 0, best: 0 } };

export const useGame = create<GameState>(() => ({
  status: "booting",
  powSolving: false,
  bootError: null,
  player: null,
  elements: {},
  owned: {},
  stats: EMPTY_STATS,
  challenge: null,
  history: [],
  recent: [],
  day: localDay(),
  legacyWelcome: null,
}));

const ART_RANK: Record<ElementDTO["art"], number> = { missing: 0, blocked: 1, ready: 2 };

/** Merge a server copy of an element with what we have, never regressing art we already fetched. */
function mergeElement(prev: ElementDTO | undefined, next: ElementDTO): ElementDTO {
  if (!prev) return next;
  if (ART_RANK[prev.art] > ART_RANK[next.art]) return { ...next, art: prev.art, img: prev.img };
  return next;
}

function withElements(map: Record<ElementId, ElementDTO>, list: readonly ElementDTO[]): Record<ElementId, ElementDTO> {
  const out = { ...map };
  for (const el of list) out[el.id] = mergeElement(out[el.id], el);
  return out;
}

export async function bootGame(): Promise<void> {
  const legacy = readLegacy();
  const day = localDay();
  useGame.setState({ status: "booting", bootError: null });
  try {
    const res = await bootstrap({ clientDate: day, ...(legacy ? { legacy: legacy.payload } : {}) }, () =>
      useGame.setState({ powSolving: true }),
    );
    let legacyWelcome: GameState["legacyWelcome"] = null;
    if (legacy && res.legacyImport) {
      markLegacyImported(legacy.marker);
      const { adopted, imported, claimed } = res.legacyImport;
      if (claimed) {
        legacyWelcome = { restored: imported, claimedElsewhere: true };
      } else if (adopted || imported > 0) {
        legacyWelcome = { restored: adopted ? res.library.filter((e) => !e.starter).length : imported };
      }
    }
    const owned: Record<ElementId, Owned> = {};
    for (const e of res.library) owned[e.id] = { discoveredAt: e.discoveredAt, first: e.first };
    const elements = withElements({}, [
      ...res.library,
      ...(res.challenge?.targets.map((t) => t.element) ?? []),
      ...res.recent,
    ]);
    useGame.setState({
      status: "ready",
      powSolving: false,
      player: res.player,
      elements,
      owned,
      stats: res.stats,
      challenge: res.challenge,
      history: res.history,
      recent: res.recent.map((e) => e.id),
      day,
      legacyWelcome,
    });
    track("app_ready", { returning_legacy: !!legacyWelcome, elements: res.library.length });
  } catch (e) {
    const code = e instanceof ApiFailure ? e.code : "network";
    useGame.setState({ status: "error", powSolving: false, bootError: code });
    track("load_failed", { code });
  }
}

export function setElementArt(id: ElementId, art: ElementDTO["art"], img: string | null): void {
  useGame.setState((s) => {
    const prev = s.elements[id];
    if (!prev || (prev.art === art && prev.img === img)) return s;
    return { elements: { ...s.elements, [id]: { ...prev, art, img } } };
  });
}

/** Elements discovered moments ago in this session: their library tile arrives with a pop. */
const freshUntil = new Map<ElementId, number>();
const FRESH_MS = 3_000;

export function isFresh(id: ElementId): boolean {
  return (freshUntil.get(id) ?? 0) > Date.now();
}

/** Fold a combine response into local state (library, stats, challenge, history). */
export function applyCombine(res: CombineResponse): void {
  if (res.newForPlayer) freshUntil.set(res.result.id, Date.now() + FRESH_MS);
  useGame.setState((s) => {
    const id = res.result.id;
    const elements = withElements(s.elements, [res.entry ?? res.result]);
    let { owned, stats, challenge, history } = s;
    if (res.newForPlayer && !owned[id]) {
      owned = { ...owned, [id]: { discoveredAt: res.entry?.discoveredAt ?? new Date().toISOString(), first: res.entry?.first ?? res.firstEver } };
      stats = {
        ...stats,
        mine: stats.mine + 1,
        firsts: stats.firsts + (res.firstEver ? 1 : 0),
        known: stats.known + (res.firstEver ? 1 : 0),
      };
    }
    if (res.completed.length > 0 && challenge) {
      const hadAny = challenge.targets.some((t) => t.completed);
      challenge = {
        ...challenge,
        targets: challenge.targets.map((t) => (res.completed.includes(t.tier) ? { ...t, completed: true } : t)),
      };
      const current = hadAny ? stats.streak.current : stats.streak.current + 1;
      stats = {
        ...stats,
        challengesCompleted: stats.challengesCompleted + res.completed.length,
        streak: { current, best: Math.max(stats.streak.best, current) },
      };
      const completed = challenge.targets.filter((t) => t.completed).map((t) => t.tier);
      const names = Object.fromEntries(challenge.targets.map((t) => [t.tier, t.element.name])) as Record<Tier, string>;
      const today: ChallengeHistoryDay = { day: challenge.day, completed, names };
      history = [today, ...history.filter((h) => h.day !== challenge!.day)];
    }
    return { elements, owned, stats, challenge, history };
  });
}

/** After a successful server reset: the library goes back to the starters. */
export function resetLibraryLocal(): void {
  useGame.setState((s) => {
    const owned: Record<ElementId, Owned> = {};
    for (const [id, o] of Object.entries(s.owned)) if (s.elements[id]?.starter) owned[id] = o;
    return { owned, stats: { ...s.stats, mine: Object.keys(owned).length } };
  });
}

/** Open (not yet completed) challenge targets by element id. */
export function openTargetIds(s: GameState = useGame.getState()): Set<ElementId> {
  return new Set(s.challenge?.targets.filter((t) => !t.completed).map((t) => t.element.id) ?? []);
}
