import { z } from "zod";
import { channelKeySchema } from "./channel-key";

export const eventTypes = [
  "request.created",
  "message.created",
  "message.intake_completed",
  "attachment.rejected",
  "message.flagged",
  "triage.job.opened",
  "triage.job.claimed",
  "triage.job.lease_expired",
  "triage.job.released",
  "triage.result.accepted",
  "triage.result.rejected",
  "ticket.created",
  "ticket.blocked",
  "comment.received",
  "reply.held",
  "reply.sent",
  "reply.flagged",
  "reply.cancelled",
  "reply.expired",
  "admin.project.created",
  "admin.project.updated",
  "admin.cc_list.updated",
  "admin.key.minted",
  "admin.key.revoked",
  "admin.integration.updated",
] as const;

export const eventTypeSchema = z.enum(eventTypes);
export type EventType = z.infer<typeof eventTypeSchema>;

export const eventInputSchema = z.object({
  type: eventTypeSchema,
  channelKey: channelKeySchema,
  requestId: z.string().uuid().nullish(),
  payload: z.record(z.unknown()).default({}),
});
export type EventInput = z.input<typeof eventInputSchema>;

export const eventEnvelopeSchema = eventInputSchema.extend({
  id: z.string().uuid(),
  seq: z.coerce.number().int().positive(),
  requestId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
