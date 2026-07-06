import { z } from "zod";

export const DraftReplySchema = z.object({
  draftText: z.string().min(1).describe("The drafted X reply text."),
  quotedPhrase: z
    .string()
    .min(1)
    .describe(
      "A short phrase copied verbatim from the matched article excerpt that grounds this reply.",
    ),
  whyRecommended: z
    .string()
    .min(1)
    .describe("One sentence explaining why this article and angle were chosen for this post."),
});
export type DraftReply = z.infer<typeof DraftReplySchema>;
