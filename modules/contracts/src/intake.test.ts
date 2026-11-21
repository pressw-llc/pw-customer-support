import { expect, test } from "bun:test";
import {
  attachmentRejectionReasonSchema,
  intakeResultSchema,
  requestListSchema,
  supportIdentitySchema,
  threadSchema,
} from "./index";

const id = "6f1c0a4e-5b3d-4c8e-9a1f-2d7e8b9c0a1b";
const message = {
  id,
  body: "hello",
  flagged: false,
  author: "customer",
  audience: "external",
  originChannel: "widget",
  createdAt: "2026-01-01T00:00:00.000Z",
  attachments: [
    { id, filename: "a.png", contentType: "image/png", sizeBytes: 3 },
  ],
} as const;

test("intake result accepts stored and rejected files", () => {
  const parsed = intakeResultSchema.parse({
    requestId: id,
    message,
    files: [
      { filename: "a.png", status: "stored" },
      { filename: "b.exe", status: "rejected", reason: "executable" },
    ],
  });
  expect(parsed.files).toHaveLength(2);
});

test("an unknown rejection reason fails", () => {
  expect(() => attachmentRejectionReasonSchema.parse("rude")).toThrow();
});

test("request list and thread schemas parse", () => {
  const summary = {
    id,
    status: "open",
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    unreadCount: 2,
    lastMessage: {
      preview: "hello",
      author: "staff",
      originChannel: "linear",
      createdAt: message.createdAt,
    },
  };
  expect(
    requestListSchema.parse({ requests: [summary] }).requests,
  ).toHaveLength(1);
  expect(
    threadSchema.parse({
      id,
      status: "open",
      createdAt: message.createdAt,
      messages: [message],
    }).messages,
  ).toHaveLength(1);
});

test("identity needs a lowercase hex hashed id", () => {
  expect(() =>
    supportIdentitySchema.parse({ projectKey: "k", hashedId: "XYZ" }),
  ).toThrow();
  expect(
    supportIdentitySchema.parse({ projectKey: "k", hashedId: "a".repeat(64) })
      .projectKey,
  ).toBe("k");
});
