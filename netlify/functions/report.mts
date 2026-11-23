import type { Config } from "@netlify/functions";
import { reportElement } from "../../server/game/report.ts";
import { route } from "../../server/http.ts";

export default route("report", reportElement);

export const config: Config = {
  path: "/api/report",
  method: "POST",
};
