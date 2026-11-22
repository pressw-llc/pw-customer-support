import { describe, expect, test } from "bun:test";
import { createLinearClient, envSecrets } from "./linear/client";

describe.skipIf(
  !process.env.LINEAR_API_KEY || !process.env.LINEAR_TEST_TEAM_ID,
)("Linear API with a real key", () => {
  test("creates one ticket with a label and archives it", async () => {
    const teamId = process.env.LINEAR_TEST_TEAM_ID as string;
    const client = createLinearClient({
      secrets: envSecrets(),
      apiUrl: process.env.LINEAR_API_URL || undefined,
    });
    const team = await client.getTeam(teamId);
    expect(team?.id).toBeTruthy();
    const labelId = await client.findOrCreateLabel(teamId, "pw-support-test");
    const marker = `pw-support-live-${crypto.randomUUID()}`;
    const issue = await client.createIssue({
      teamId,
      title: "pw-support live test, safe to archive",
      description: `Created by an automated test.\n\n${marker}`,
      priority: 4,
      labelIds: [labelId],
    });
    try {
      expect(issue.identifier).toMatch(/^[A-Z0-9]+-\d+$/);
    } finally {
      expect(await client.archiveIssue(issue.id)).toBe(true);
    }
  }, 60_000);
});
