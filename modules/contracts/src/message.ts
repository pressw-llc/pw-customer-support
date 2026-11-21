import { z } from "zod";

export const originChannels = [
  "widget",
  "linear",
  "slack",
  "email",
  "claude_code",
] as const;
export const originChannelSchema = z.enum(originChannels);
export type OriginChannel = z.infer<typeof originChannelSchema>;

export const messageAuthors = ["customer", "staff", "system"] as const;
export const messageAuthorSchema = z.enum(messageAuthors);
export type MessageAuthor = z.infer<typeof messageAuthorSchema>;

export const messageAudiences = ["external", "internal"] as const;
export const messageAudienceSchema = z.enum(messageAudiences);
export type MessageAudience = z.infer<typeof messageAudienceSchema>;

export const messageSchema = z.object({
  body: z.string().min(1),
  originChannel: originChannelSchema,
  author: messageAuthorSchema,
  audience: messageAudienceSchema,
});
export type Message = z.infer<typeof messageSchema>;
