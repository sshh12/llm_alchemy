// Minimal Node-side client for the app API, used by global setup to verify which world the
// running server is wired to before any browser test touches it.
import type { ApiError, BootstrapRequest, BootstrapResponse } from "../../src/shared/api.ts";
import { API_HEADER } from "../../src/shared/api.ts";
import { localDay } from "../../src/shared/dates.ts";
import { solvePow } from "../../src/shared/pow.ts";

async function post(baseURL: string, path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(new URL(path, baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [API_HEADER]: "1",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Ask for a PoW challenge without creating anything. */
export async function powChallenge(baseURL: string): Promise<ApiError> {
  const res = await post(baseURL, "/api/bootstrap", { clientDate: localDay() } satisfies BootstrapRequest);
  const body = (await res.json().catch(() => ({}))) as ApiError;
  if (res.status !== 401 || body.error !== "pow_required" || !body.pow) {
    throw new Error(`Expected 401 pow_required from a cookie-less bootstrap, got ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/** Create a player through the real PoW flow and return its bootstrap. */
export async function bootstrapNewPlayer(baseURL: string, challenge: ApiError): Promise<BootstrapResponse> {
  const { salt, bits } = challenge.pow!;
  const nonce = solvePow(salt, bits);
  if (!nonce) throw new Error("Could not solve PoW");
  const res = await post(baseURL, "/api/bootstrap", { clientDate: localDay(), pow: { salt, nonce } } satisfies BootstrapRequest);
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) throw new Error(`Bootstrap with PoW failed: ${res.status} ${JSON.stringify(body)}`);
  return body as BootstrapResponse;
}
