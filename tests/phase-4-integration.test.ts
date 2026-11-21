import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp, createS3Storage, loadConfig } from "@pw-support/api";
import {
  type AdminRequestDetail,
  adminRequestDetailSchema,
  adminRequestListSchema,
} from "@pw-support/contracts";
import { listFlaggedReplies } from "@pw-support/db";
import { createPhase3Harness, type Phase3Harness } from "./phase-3-support";

let p: Phase3Harness;
let adminCall: (path: string) => Promise<Response>;

const staffIdentity = { sub: "staff-1", email: "ada@pressw.test", name: "Ada" };

beforeAll(async () => {
  p = await createPhase3Harness();
  const config = loadConfig({});
  const app = createApp({
    db: p.h.db,
    storage: createS3Storage(config),
    config,
    validator: {
      configured: true,
      verify: async (token) =>
        token === "staff-token"
          ? { ok: true, identity: staffIdentity, claims: {} }
          : { ok: false, reason: "bad_token" },
    },
    secretWriter: { put: async () => "unused" },
  });
  adminCall = (path) =>
    Promise.resolve(
      app.request(`/admin${path}`, {
        headers: { Authorization: "Bearer staff-token" },
      }),
    );
});

afterAll(async () => {
  await p.close();
});

async function staff(
  s: { issueId: string; requestId: string },
  body: string,
  options: { userName?: string; parentId?: string } = {},
) {
  const { comment, delivery } = await p.stub.staffComment({
    issueId: s.issueId,
    body,
    ...options,
  });
  expect(delivery?.status).toBe(200);
  await p.drain(s.requestId);
  return comment;
}

async function detail(requestId: string): Promise<AdminRequestDetail> {
  const response = await adminCall(`/requests/${requestId}`);
  expect(response.status).toBe(200);
  return adminRequestDetailSchema.parse(await response.json());
}

async function listed(query: string) {
  const response = await adminCall(`/requests?${query}`);
  expect(response.status).toBe(200);
  return adminRequestListSchema.parse(await response.json()).items;
}

describe("the admin API reads the real reply loop tables", () => {
  test("A15 admin: a reply scored 2.5 is sent and shows as flagged with its score", async () => {
    const s = await p.scenario();
    const quiet = await p.scenario();
    await staff(s, "@external Thanks for your patience. [s=2.5]");
    const item = (await listed("flaggedReplies=true")).find(
      (row) => row.id === s.requestId,
    );
    expect(item).toMatchObject({ flaggedReplies: true, heldReplies: false });
    expect(
      (await listed("flaggedReplies=true")).some(
        (row) => row.id === quiet.requestId,
      ),
    ).toBe(false);
    const flagged = await listFlaggedReplies(p.h.db, {});
    expect(flagged.map((row) => row.reply.requestId)).toContain(s.requestId);

    const view = await detail(s.requestId);
    expect(view.replies).toHaveLength(1);
    expect(view.replies[0]).toMatchObject({
      status: "sent",
      score: 2.5,
      flagged: true,
      authorName: "Ada Staff",
    });
    expect(view.messages.at(-1)).toMatchObject({
      authorName: "Ada Staff",
      originChannel: "linear",
      audience: "external",
      author: "staff",
    });
  });

  test("A15 admin: a held reply shows its score, reason, expiry, and warning until it is confirmed", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external Not our problem. [s=1.0]");
    const item = (await listed("flaggedReplies=true")).find(
      (row) => row.id === s.requestId,
    );
    expect(item).toMatchObject({ heldReplies: true, flaggedReplies: false });
    const before = await detail(s.requestId);
    expect(before.replies[0]).toMatchObject({
      status: "held",
      score: 1,
      holdReason: "wording_low",
      warningPosted: true,
    });
    expect(before.replies[0]?.expiresAt).not.toBeNull();
    expect(
      before.messages.some((message) => message.body.includes("Not our")),
    ).toBe(false);

    p.h.clock.advance(5);
    await staff(s, "@confirm", { parentId: held.id });
    const after = await detail(s.requestId);
    expect(after.replies[0]?.status).toBe("sent");
    const row = (await listed("limit=100")).find(
      (entry) => entry.id === s.requestId,
    );
    expect(row?.heldReplies).toBe(false);
  });

  test("A15 admin: an edited hold shows as cancelled with its reason", async () => {
    const s = await p.scenario();
    const held = await staff(s, "@external Rough text. [s=1.0]");
    await p.stub.editComment(held.id, "@external Polished text. [s=4]");
    const view = await detail(s.requestId);
    expect(view.replies[0]).toMatchObject({
      status: "cancelled",
      cancelReason: "edited",
    });
    expect(
      (await listed("flaggedReplies=true")).some(
        (row) => row.id === s.requestId,
      ),
    ).toBe(false);
  });

  test("internal staff comments show the author and origin, and acknowledge the request", async () => {
    const s = await p.scenario();
    expect(
      (await listed("limit=100")).find((row) => row.id === s.requestId),
    ).toMatchObject({ acknowledgedAt: null });
    await staff(s, "Dave broke the export, checking logs");
    const view = await detail(s.requestId);
    const internal = view.messages.find((m) => m.audience === "internal");
    expect(internal).toMatchObject({
      author: "staff",
      authorName: "Ada Staff",
      originChannel: "linear",
    });
    expect(view.request.acknowledgedAt).not.toBeNull();
  });

  test("a customer follow-up alone does not acknowledge the request", async () => {
    const s = await p.scenario();
    await p.followUp(s.who, s.requestId, "Any news on my invoice?");
    const view = await detail(s.requestId);
    expect(view.messages.at(-1)).toMatchObject({
      author: "customer",
      audience: "external",
    });
    expect(view.request.acknowledgedAt).toBeNull();
  });
});
