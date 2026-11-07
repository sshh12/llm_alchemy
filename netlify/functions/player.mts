import type { Config } from "@netlify/functions";
import { playerAction } from "../../server/game/player.ts";
import { route } from "../../server/http.ts";

export default route("player", playerAction);

export const config: Config = {
  path: "/api/player",
  method: "POST",
};
