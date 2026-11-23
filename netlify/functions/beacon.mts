import type { Config } from "@netlify/functions";
import { bootBeacon } from "../../server/game/beacon.ts";
import { route } from "../../server/http.ts";

export default route("beacon", bootBeacon);

export const config: Config = {
  path: "/api/beacon",
  method: "POST",
};
