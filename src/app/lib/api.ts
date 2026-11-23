// Typed client for the HTTP contract in src/shared/api.ts.
// Every POST carries JSON + `x-ia-client: 1`. Errors surface as ApiFailure with the
// server's ApiErrorCode (or 'network' / 'timeout'). Bootstrap runs once per page load and
// transparently solves a proof-of-work challenge in a Web Worker when asked to.
import {
  API_HEADER,
  type ApiError,
  type ApiErrorCode,
  type BootBeacon,
  type BootPhase,
  type BootstrapRequest,
  type BootstrapResponse,
  type CombineRequest,
  type CombineResponse,
  type ImageRequest,
  type ImageResponse,
  type PlayerAction,
  type PlayerResponse,
  type PowChallenge,
  type ReportRequest,
  type ReportResponse,
  type SortRequest,
  type SortResponse,
} from "../../shared/api.ts";

export type FailureCode = ApiErrorCode | "network" | "timeout";

export class ApiFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly status = 0,
    readonly retryAfterMs?: number,
    readonly pow?: PowChallenge,
    /**
     * rate_limited / budget_exhausted: the server rule that said no (e.g. "llm.player"), or
     * "platform" for a 429 without a JSON body (a Netlify platform rate limit).
     */
    readonly limit?: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

/** Sends a request; replaceable so the dev-only fake API can stand in for the server. */
export type Transport = (path: string, init: RequestInit) => Promise<Response>;
let transport: Transport = (path, init) => fetch(path, init);
export function setTransport(t: Transport): void {
  transport = t;
}

function isApiError(v: unknown): v is ApiError {
  return !!v && typeof v === "object" && typeof (v as ApiError).error === "string";
}

function retryAfterHeader(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, t - Date.now());
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 429) return "rate_limited"; // platform rate limits answer without a JSON body
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server_error";
  return "bad_request";
}

async function post<T>(path: string, body: unknown, opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, opts.timeoutMs)
    : undefined;
  try {
    let res: Response;
    try {
      res = await transport(path, {
        method: "POST",
        headers: { "content-type": "application/json", [API_HEADER]: "1" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        signal: ctrl.signal,
      });
    } catch {
      if (timedOut) throw new ApiFailure("timeout", "The request took too long.");
      throw new ApiFailure("network", "Couldn't reach the server.");
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      if (timedOut) throw new ApiFailure("timeout", "The request took too long.");
      // Non-JSON body (e.g. a platform 429 page): fall through to status mapping.
    }
    if (res.ok && data !== null) return data as T;
    if (isApiError(data)) {
      throw new ApiFailure(data.error, data.message, res.status, data.retryAfterMs ?? retryAfterHeader(res), data.pow, data.limit);
    }
    throw new ApiFailure(
      res.ok ? "server_error" : codeForStatus(res.status),
      res.statusText || "Request failed",
      res.status,
      retryAfterHeader(res),
      undefined,
      res.status === 429 ? "platform" : undefined,
    );
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

// ------------------------------------------------------------------ proof of work

async function solvePowChallenge(ch: PowChallenge): Promise<string> {
  if (typeof Worker !== "undefined") {
    try {
      return await new Promise<string>((resolve, reject) => {
        const w = new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<{ nonce: string | null }>) => {
          w.terminate();
          if (e.data.nonce) resolve(e.data.nonce);
          else reject(new Error("no nonce"));
        };
        w.onerror = (e) => {
          w.terminate();
          reject(e);
        };
        w.postMessage(ch);
      });
    } catch {
      // Fall through to the main thread (old browsers / blocked workers).
    }
  }
  const { solvePow } = await import("../../shared/pow.ts");
  const nonce = solvePow(ch.salt, ch.bits);
  if (!nonce) throw new ApiFailure("server_error", "Couldn't verify this browser.");
  return nonce;
}

// ------------------------------------------------------------------ endpoints

let bootPromise: Promise<BootstrapResponse> | null = null;

/**
 * Where one bootstrap attempt is and how long its parts took (for app_ready / load_failed and
 * the abandon beacon). `bootstrap` updates it as it goes; "render" means the response is in.
 */
export interface BootTrace {
  phase: BootPhase;
  /** Time spent solving the proof-of-work (0 when none was asked for). */
  powMs: number;
  /** Time spent waiting on /api/bootstrap responses, both POSTs together. */
  apiMs: number;
}

export const newBootTrace = (): BootTrace => ({ phase: "bootstrap1", powMs: 0, apiMs: 0 });

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

async function timedBootstrap(req: BootstrapRequest, trace: BootTrace): Promise<BootstrapResponse> {
  const t0 = now();
  try {
    return await post<BootstrapResponse>("/api/bootstrap", req, { timeoutMs: 30_000 });
  } finally {
    trace.apiMs += now() - t0;
  }
}

/**
 * POST /api/bootstrap, at most once per page load (a failed attempt may be retried).
 * `onPow` fires when the server asks this browser to solve a proof-of-work first. `trace`
 * follows the attempt through its phases: bootstrap1 -> pow -> bootstrap2 -> render.
 */
export function bootstrap(req: BootstrapRequest, onPow?: () => void, trace: BootTrace = newBootTrace()): Promise<BootstrapResponse> {
  bootPromise ??= (async () => {
    trace.phase = "bootstrap1";
    try {
      const res = await timedBootstrap(req, trace);
      trace.phase = "render";
      return res;
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== "pow_required" || !e.pow) throw e;
      trace.phase = "pow";
      onPow?.();
      const p0 = now();
      const nonce = await solvePowChallenge(e.pow);
      trace.powMs = now() - p0;
      trace.phase = "bootstrap2";
      const res = await timedBootstrap({ ...req, pow: { salt: e.pow.salt, nonce } }, trace);
      trace.phase = "render";
      return res;
    }
  })().catch((e: unknown) => {
    bootPromise = null;
    throw e;
  });
  return bootPromise;
}

/**
 * A fresh POST /api/bootstrap for a page that is already playing (a resumed tab on a new local
 * day). Never solves a proof-of-work: without a valid session it fails (unauthorized, or
 * pow_required from a server before `refresh`), so it can never create a player. `refresh` also
 * tells the server not to count it as a load.
 */
export const refreshBootstrap = (req: BootstrapRequest) =>
  post<BootstrapResponse>("/api/bootstrap", { ...req, pow: undefined, refresh: true }, { timeoutMs: 30_000 });

/** POST /api/report: flag an element for review. */
export const reportElement = (req: ReportRequest) => post<ReportResponse>("/api/report", req, { timeoutMs: 15_000 });

/**
 * POST /api/beacon with navigator.sendBeacon, which survives the page unloading. The body goes
 * as text/plain (a beacon can't set the API header; the endpoint checks same-origin instead).
 * Returns false when the browser has no beacon or refused to queue it.
 */
export function sendBootBeacon(body: BootBeacon): boolean {
  try {
    return typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function"
      ? navigator.sendBeacon("/api/beacon", JSON.stringify(body))
      : false;
  } catch {
    return false;
  }
}

export const combine = (req: CombineRequest, signal?: AbortSignal) =>
  post<CombineResponse>("/api/combine", req, { signal, timeoutMs: 15_000 });

/** POST /api/sort. A whole-library run can take several seconds server-side (20 s deadline). */
export const scoreLibrary = (req: SortRequest, signal?: AbortSignal) =>
  post<SortResponse>("/api/sort", req, { signal, timeoutMs: 30_000 });

export const requestImage = (req: ImageRequest) => post<ImageResponse>("/api/image", req, { timeoutMs: 40_000 });

export const playerAction = (action: PlayerAction) => post<PlayerResponse>("/api/player", action, { timeoutMs: 15_000 });

/** Image CDN thumbnail for an art path, with the raw path as the fallback. */
export function thumbUrl(img: string, size = 192): string {
  return `/.netlify/images?url=${encodeURIComponent(img)}&w=${size}&h=${size}&fit=contain`;
}
