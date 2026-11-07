import type { Config } from "@netlify/functions";
import { combineElements } from "../../server/game/combine.ts";
import { route } from "../../server/http.ts";

export default route("combine", combineElements);

export const config: Config = {
  path: "/api/combine",
  method: "POST",
  // Platform rule #1 of 2: rejected at the edge, before a function invocation is billed.
  rateLimit: { windowLimit: 90, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
