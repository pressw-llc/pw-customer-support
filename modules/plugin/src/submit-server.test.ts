import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JobSubmitResult } from "@pw-support/contracts";
import {
  createSubmitServer,
  SUBMIT_SERVER_NAME,
  SUBMIT_TOOL_FULL_NAME,
  type SubmitOutcome,
} from "./submit-server";

async function connect(forward: (result: unknown) => Promise<JobSubmitResult>) {
  const outcomes: SubmitOutcome[] = [];
  const forwarded: unknown[] = [];
  const server = createSubmitServer({
    forward: (result) => {
      forwarded.push(result);
      return forward(result);
    },
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientSide);
  return { client, outcomes, forwarded };
}

const text = (result: unknown) =>
  (result as { content: { text: string }[] }).content[0]?.text ?? "";

describe("submit server", () => {
  test("exposes exactly one tool named submit_result", async () => {
    const { client } = await connect(async () => ({
      accepted: true,
      outcome: "agent",
    }));
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["submit_result"]);
    expect(SUBMIT_TOOL_FULL_NAME).toBe(
      `mcp__${SUBMIT_SERVER_NAME}__submit_result`,
    );
    expect(tools[0]?.description).toContain("exactly once");
  });

  test("forwards the whole result once and reports acceptance without echoing content", async () => {
    const { client, outcomes, forwarded } = await connect(async () => ({
      accepted: true,
      outcome: "agent",
    }));
    const args = { title: "T", extra: "kept for server validation" };
    const first = await client.callTool({
      name: "submit_result",
      arguments: args,
    });
    expect(text(first)).toBe("Result accepted. Stop now.");
    expect(forwarded).toEqual([args]);
    expect(outcomes).toEqual([{ accepted: true }]);
    const second = await client.callTool({
      name: "submit_result",
      arguments: args,
    });
    expect((second as { isError?: boolean }).isError).toBe(true);
    expect(forwarded).toHaveLength(1);
  });

  test("records a refusal and a transport failure", async () => {
    const refused = await connect(async () => ({
      accepted: false,
      reason: "invalid_payload",
      issues: [{ path: "category", message: "bad" }],
    }));
    const answer = await refused.client.callTool({
      name: "submit_result",
      arguments: {},
    });
    expect(text(answer)).toBe("Result refused. Stop now.");
    expect(refused.outcomes).toEqual([
      { accepted: false, reason: "invalid_payload" },
    ]);

    const broken = await connect(async () => {
      throw new Error("network");
    });
    const failed = await broken.client.callTool({
      name: "submit_result",
      arguments: {},
    });
    expect(broken.outcomes).toEqual([{ accepted: false, reason: "transport" }]);
    expect(text(failed)).toContain("Call the tool once more");
  });

  test("a transport failure leaves one retry and a delivered result then locks the tool", async () => {
    let attempt = 0;
    const { client, outcomes, forwarded } = await connect(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network");
      return { accepted: true, outcome: "agent" };
    });
    await client.callTool({ name: "submit_result", arguments: { title: "x" } });
    const retry = await client.callTool({
      name: "submit_result",
      arguments: { title: "x" },
    });
    expect(text(retry)).toBe("Result accepted. Stop now.");
    expect(outcomes).toEqual([
      { accepted: false, reason: "transport" },
      { accepted: true },
    ]);
    const third = await client.callTool({
      name: "submit_result",
      arguments: { title: "x" },
    });
    expect((third as { isError?: boolean }).isError).toBe(true);
    expect(forwarded).toHaveLength(2);
  });

  test("publishes an honest permissive schema with no union wrapper", async () => {
    const { client } = await connect(async () => ({
      accepted: true,
      outcome: "agent",
    }));
    const tool = (await client.listTools()).tools[0];
    const properties = tool?.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    for (const name of [
      "title",
      "summary",
      "category",
      "priority",
      "labels",
      "needs_human",
    ]) {
      expect(properties[name]?.anyOf).toBeUndefined();
      expect(properties[name]?.description).toBeString();
    }
    expect(tool?.description).toContain("validates every key");
  });
});

describe("submit server process", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("starts over stdio from its config file and requires a valid one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-support-submit-"));
    dirs.push(dir);
    const outcomeFile = join(dir, "outcome.json");
    const configFile = join(dir, "submit.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        jobId: "11111111-1111-4111-8111-111111111111",
        claimToken: "22222222-2222-4222-8222-222222222222",
        submitToken: "S".repeat(43),
        apiUrl: "http://127.0.0.1:1",
        outcomeFile,
      }),
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dir, "cli.ts"), "submit-server", configFile],
      env: { PATH: process.env.PATH ?? "" },
    });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "submit_result",
    ]);
    await client.callTool({ name: "submit_result", arguments: { title: "x" } });
    expect(JSON.parse(readFileSync(outcomeFile, "utf8"))).toEqual({
      accepted: false,
      reason: "transport",
    });
    await client.close();

    for (const args of [[], [join(dir, "missing.json")]]) {
      const missing = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "cli.ts"),
          "submit-server",
          ...args,
        ],
        {
          env: { PATH: process.env.PATH ?? "" },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      expect(await missing.exited).toBe(1);
    }
  });
});
