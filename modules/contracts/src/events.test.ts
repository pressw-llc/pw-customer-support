import { describe, expect, test } from "bun:test";
import {
  eventEnvelopeSchema,
  eventInputSchema,
  eventTypeSchema,
  eventTypes,
} from "./events";

const requestId = "7d6f6c0e-8f3a-4d55-9d0c-2f2a4f1f3b11";

describe("eventTypeSchema", () => {
  test("lists the stream event types", () => {
    expect(eventTypes).toContain("request.created");
    expect(eventTypes).toContain("reply.flagged");
    expect(new Set(eventTypes).size).toBe(eventTypes.length);
  });

  test("accepts every listed type and rejects unknown ones", () => {
    for (const type of eventTypes) {
      expect(eventTypeSchema.safeParse(type).success).toBe(true);
    }
    expect(eventTypeSchema.safeParse("request.deleted").success).toBe(false);
  });
});

describe("eventInputSchema", () => {
  test("defaults the payload to an empty object", () => {
    const parsed = eventInputSchema.parse({
      type: "request.created",
      channelKey: "acme:portal",
    });
    expect(parsed.payload).toEqual({});
    expect(parsed.requestId).toBeUndefined();
  });

  test("accepts a request id and payload", () => {
    const parsed = eventInputSchema.parse({
      type: "message.created",
      channelKey: "acme:portal:u1",
      requestId,
      payload: { messageId: "m1" },
    });
    expect(parsed.requestId).toBe(requestId);
  });

  test("rejects an invalid channel key", () => {
    expect(
      eventInputSchema.safeParse({
        type: "request.created",
        channelKey: "acme::x",
      }).success,
    ).toBe(false);
  });

  test("rejects a request id that is not a uuid", () => {
    expect(
      eventInputSchema.safeParse({
        type: "request.created",
        channelKey: "acme",
        requestId: "not-a-uuid",
      }).success,
    ).toBe(false);
  });

  test("rejects a non-object payload", () => {
    expect(
      eventInputSchema.safeParse({
        type: "request.created",
        channelKey: "acme",
        payload: "text",
      }).success,
    ).toBe(false);
  });
});

describe("eventEnvelopeSchema", () => {
  const stored = {
    id: "0b1f9a3e-5c8d-4e2a-9a77-3d1f6b2c4e90",
    seq: "42",
    type: "ticket.created",
    channelKey: "acme",
    requestId: null,
    payload: {},
    createdAt: "2026-11-20T12:00:00.000Z",
  };

  test("coerces the sequence and timestamp", () => {
    const parsed = eventEnvelopeSchema.parse(stored);
    expect(parsed.seq).toBe(42);
    expect(parsed.createdAt).toBeInstanceOf(Date);
  });

  test("requires an id and a positive sequence", () => {
    expect(eventEnvelopeSchema.safeParse({ ...stored, id: "x" }).success).toBe(
      false,
    );
    expect(eventEnvelopeSchema.safeParse({ ...stored, seq: 0 }).success).toBe(
      false,
    );
  });
});
