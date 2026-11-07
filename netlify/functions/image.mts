import type { Config } from "@netlify/functions";
import { requestImage } from "../../server/game/images.ts";
import { route } from "../../server/http.ts";

export default route("image", requestImage);

export const config: Config = {
  path: "/api/image",
  method: "POST",
  // Platform rule #2 of 2: rejected at the edge, before a function invocation is billed.
  rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] },
};
