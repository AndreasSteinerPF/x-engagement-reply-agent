#!/usr/bin/env node
import { z } from "zod";
import { loadRuntimeEnv } from "../src/config/env";

/**
 * One-time setup helper: authenticates with ASANA_ACCESS_TOKEN and prints
 * every workspace/project/section/custom-field GID this account can see,
 * plus a ready-to-paste env block using the exact variable names
 * src/config/env.ts reads. Asana's UI never shows these GIDs directly, so
 * without this you'd otherwise be hand-crafting curl calls or reading them
 * out of dashboard URLs. Read-only (no tasks are created or modified);
 * intentionally not unit-tested -- this is a manual, run-once CLI tool
 * meant to be read by a human, not exercised in CI.
 *
 * Usage: npm run asana:discover
 */

const ASANA_API_BASE_URL = "https://app.asana.com/api/1.0";

const UserResponseSchema = z.object({ data: z.object({ gid: z.string(), name: z.string() }) });
const WorkspacesResponseSchema = z.object({
  data: z.array(z.object({ gid: z.string(), name: z.string() })),
});
const ProjectsResponseSchema = z.object({
  data: z.array(z.object({ gid: z.string(), name: z.string() })),
});
const SectionsResponseSchema = z.object({
  data: z.array(z.object({ gid: z.string(), name: z.string() })),
});
const CustomFieldSettingsResponseSchema = z.object({
  data: z.array(
    z.object({
      custom_field: z.object({ gid: z.string(), name: z.string(), resource_subtype: z.string() }),
    }),
  ),
});

async function asanaGet(path: string, accessToken: string): Promise<unknown> {
  const response = await fetch(`${ASANA_API_BASE_URL}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Asana request failed: HTTP ${response.status} ${path} ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function main(): Promise<void> {
  const env = loadRuntimeEnv();
  if (!env.ASANA_ACCESS_TOKEN) {
    console.error(
      "ASANA_ACCESS_TOKEN is not set. Create a Personal Access Token at " +
        "https://app.asana.com/0/my-apps and set it in your environment first.",
    );
    process.exitCode = 1;
    return;
  }
  const accessToken = env.ASANA_ACCESS_TOKEN;

  const me = UserResponseSchema.parse(await asanaGet("/users/me", accessToken));
  console.log(`Authenticated as: ${me.data.name} (gid: ${me.data.gid})\n`);

  const workspaces = WorkspacesResponseSchema.parse(
    await asanaGet("/workspaces", accessToken),
  ).data;
  if (workspaces.length === 0) {
    console.log("No workspaces visible to this token.");
    return;
  }

  console.log("Workspaces:");
  for (const workspace of workspaces) {
    console.log(`  - ${workspace.name} (gid: ${workspace.gid})`);

    const projects = ProjectsResponseSchema.parse(
      await asanaGet(`/projects?workspace=${workspace.gid}&opt_fields=name&limit=100`, accessToken),
    ).data;

    for (const project of projects) {
      console.log(`      Project: ${project.name} (gid: ${project.gid})`);

      const sections = SectionsResponseSchema.parse(
        await asanaGet(`/projects/${project.gid}/sections?opt_fields=name`, accessToken),
      ).data;
      for (const section of sections) {
        console.log(`          Section: ${section.name} (gid: ${section.gid})`);
      }

      const customFieldSettings = CustomFieldSettingsResponseSchema.parse(
        await asanaGet(
          `/projects/${project.gid}/custom_field_settings?opt_fields=custom_field.name,custom_field.resource_subtype`,
          accessToken,
        ),
      ).data;
      for (const setting of customFieldSettings) {
        console.log(
          `          Custom field: ${setting.custom_field.name} ` +
            `[${setting.custom_field.resource_subtype}] (gid: ${setting.custom_field.gid})`,
        );
      }
    }
  }

  console.log("\nEnv vars this project reads (src/config/env.ts) -- fill in from the GIDs above:");
  console.log("ASANA_ACCESS_TOKEN=<already set>");
  console.log("ASANA_WORKSPACE_GID=<pick one from above, optional>");
  console.log("ASANA_PROJECT_GID=<pick one from above, required>");
  console.log("ASANA_SECTION_GID=<pick one from above, optional>");
  console.log(`ASANA_ASSIGNEE_GID=${me.data.gid}  # your own user gid, or pick another`);
  console.log("ASANA_ARTICLE_THRESHOLD_ASSIGNEE_GID=<optional, can be the same or different user>");
  console.log(
    "ASANA_SIMILARITY_SCORE_CUSTOM_FIELD_GID=<a Number-type custom field gid from above, optional>",
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
