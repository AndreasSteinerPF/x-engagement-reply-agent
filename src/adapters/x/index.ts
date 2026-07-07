import { join } from "node:path";
import type { XClient } from "../../ports.js";
import { PACKAGE_ROOT } from "../../config/load.js";
import { FixtureXClient } from "./fixture.js";
import { LiveXClient } from "./live.js";

export { FixtureXClient } from "./fixture.js";
export { LiveXClient } from "./live.js";

export interface XClientSelection {
  client: XClient;
  mode: "live" | "fixture";
}

/**
 * Select the X source. Uses the live X API when `X_BEARER_TOKEN` is present
 * (unless `X_FORCE_FIXTURE=1`), otherwise the fixture client. The pipeline does
 * not care which it gets — that is the point of the port.
 */
export function createXClient(opts: { fixturesDir?: string } = {}): XClientSelection {
  const token = process.env.X_BEARER_TOKEN;
  if (token && process.env.X_FORCE_FIXTURE !== "1") {
    return { client: new LiveXClient({ bearerToken: token }), mode: "live" };
  }
  const fixturesDir = opts.fixturesDir ?? join(PACKAGE_ROOT, "fixtures", "posts");
  return { client: new FixtureXClient(fixturesDir), mode: "fixture" };
}
