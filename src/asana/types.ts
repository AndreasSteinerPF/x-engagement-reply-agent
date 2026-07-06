import { z } from "zod";

// Schema-first, validated at the client boundary -- same "External System
// Response Validation" discipline as src/x/types.ts and the MCP client.

export const AsanaTaskCreateResponseSchema = z.object({
  data: z.object({
    gid: z.string(),
    permalink_url: z.string().optional(),
  }),
});
export type AsanaTaskCreateResponse = z.infer<typeof AsanaTaskCreateResponseSchema>;

export const AsanaSubtaskCreateResponseSchema = z.object({
  data: z.object({
    gid: z.string(),
    name: z.string().optional(),
    permalink_url: z.string().optional(),
  }),
});
export type AsanaSubtaskCreateResponse = z.infer<typeof AsanaSubtaskCreateResponseSchema>;

export const AsanaTaskSummarySchema = z.object({
  gid: z.string(),
  name: z.string().default(""),
  notes: z.string().default(""),
  permalink_url: z.string().optional(),
});
export type AsanaTaskSummary = z.infer<typeof AsanaTaskSummarySchema>;

export const AsanaListTasksResponseSchema = z.object({
  data: z.array(AsanaTaskSummarySchema).default([]),
  next_page: z.object({ offset: z.string().optional() }).nullable().optional(),
});
export type AsanaListTasksResponse = z.infer<typeof AsanaListTasksResponseSchema>;
