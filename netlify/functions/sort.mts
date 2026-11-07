import type { Config } from "@netlify/functions";
import { sortLibrary } from "../../server/game/sort.ts";
import { route } from "../../server/http.ts";

export default route("sort", sortLibrary);

export const config: Config = {
  path: "/api/sort",
  method: "POST",
  // No rateLimit: the Starter plan's 2 platform rules are on /api/combine and /api/image, so the
  // app-level sort.* limits and BUDGETS.jev (server/ratelimit.ts) are the only gate.
};
