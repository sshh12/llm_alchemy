import type { Config } from "@netlify/functions";
import { bootstrap } from "../../server/game/bootstrap.ts";
import { route } from "../../server/http.ts";

export default route("bootstrap", bootstrap);

export const config: Config = {
  path: "/api/bootstrap",
  method: "POST",
};
