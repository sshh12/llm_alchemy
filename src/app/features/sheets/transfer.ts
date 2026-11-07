// Shared by Settings (transfer code, QR, manual redeem) and the transfer-link prompt.
import { ApiFailure, playerAction } from "../../lib/api.ts";
import { KEYS, removeKey, writeString } from "../../lib/storage.ts";
import { transferCodePlayer } from "../../lib/transferLink.ts";

export const INVALID_CODE_TEXT = "That code isn't valid (or was revoked).";

/** Friendly copy for a failed /api/player call. */
export function failureText(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.code === "rate_limited") return "Too many tries. Wait a minute and try again.";
    if (e.code === "bad_request" || e.code === "not_found" || e.code === "forbidden") return INVALID_CODE_TEXT;
    if (e.code === "network" || e.code === "timeout") return "Couldn't reach the server. Check your connection.";
  }
  return "Something went wrong. Try again.";
}

/** Redeem `code`, then reload as that player from a clean workbench. Throws ApiFailure. */
export async function switchToPlayer(code: string): Promise<void> {
  await playerAction({ action: "redeem", code });
  removeKey(KEYS.canvas);
  removeKey(KEYS.undo, "session");
  // An existing player continuing here already knows the game.
  writeString(KEYS.onboarded, "1");
  location.reload();
}

/**
 * Whether `code` names the player this browser already is. Bootstrap only exposes the public
 * id, so compare against a fresh code of our own (codes start with the player id). On any
 * failure, assume not: redeeming is idempotent anyway.
 */
export async function isCurrentPlayer(code: string): Promise<boolean> {
  try {
    const res = await playerAction({ action: "transfer-code" });
    return res.action === "transfer-code" && transferCodePlayer(res.code) === transferCodePlayer(code);
  } catch {
    return false;
  }
}
