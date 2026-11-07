// Transfer deep links: `${origin}/#transfer=<code>`, what the QR code in Settings encodes.
// The code is a bearer credential, so it rides in the fragment (never sent to the server, logs
// or referrers) and is taken out of the address bar the moment the app starts, before anything
// can record it. The confirm dialog (features/sheets/TransferPrompt.tsx) runs after bootstrap.

const PREFIX = "#transfer=";
/** The shape the server accepts (server/session.ts decodeTransferCode): `<playerId>.<version>.<sig>`. */
const CODE_RE = /^[1-9]\d{0,18}\.\d{1,9}\.[A-Za-z0-9_-]{22}$/;

export interface TransferLink {
  /** Decoded code ("" when missing or not decodable). */
  code: string;
  /** Well-formed. Only the server checks the signature and revocation. */
  valid: boolean;
}

/** `#transfer=<code>` → the link; any other hash (or none) → null, to be left alone. */
export function parseTransferHash(hash: string): TransferLink | null {
  if (!hash.startsWith(PREFIX)) return null;
  let code = "";
  try {
    code = decodeURIComponent(hash.slice(PREFIX.length)).trim();
  } catch {
    // Malformed percent-escape: an unusable link.
  }
  return { code, valid: CODE_RE.test(code) };
}

export function transferUrl(origin: string, code: string): string {
  return `${origin}/${PREFIX}${encodeURIComponent(code)}`;
}

/** The player a code names (its first segment), for an "is this me already?" check. */
export function transferCodePlayer(code: string): string {
  return code.split(".", 1)[0] ?? "";
}

let captured: TransferLink | null = null;

/** First thing on startup: move a transfer link out of the URL and keep it for after bootstrap. */
export function captureTransferLink(): void {
  const link = parseTransferHash(location.hash);
  if (!link) return;
  history.replaceState(history.state, "", location.pathname + location.search);
  captured = link;
}

/** The transfer link this page was opened with, if any. */
export function capturedTransferLink(): TransferLink | null {
  return captured;
}
