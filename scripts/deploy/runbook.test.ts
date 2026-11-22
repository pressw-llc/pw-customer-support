import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigScope,
  REQUIRED_KEYS,
  resolveStageConfig,
} from "@pw-support/infra";
import { parseDeployArgs } from "./lib";
import { type DeployDeps, preflight } from "./run";

type RawValues = Record<string, unknown>;

const RUNBOOK = join(import.meta.dir, "..", "..", "docs", "runbook.md");

const SAMPLE: RawValues = {
  account: "123456789012",
  certificateArn:
    "arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  apiDomain: "support-api.example.com",
  cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_X",
  adminClientId: "admin-client",
  mcpClientId: "mcp-client",
  mcpRequiredGroup: "support-staff",
  adminRequiredGroup: "support-admins",
  adminLogoutUrl: "https://example.auth.us-east-1.amazoncognito.com/logout",
  triageAgentId: "agent_1",
};

type Marker =
  | { kind: "stage-file"; keys: string[] }
  | { kind: "run"; flag: string };

function runbookMarkers(text: string): Marker[] {
  return [...text.matchAll(/<!-- (stage-file|run): ([^>]*?) -->/g)].map(
    (match) =>
      match[1] === "stage-file"
        ? {
            kind: "stage-file" as const,
            keys: (match[2] as string).split(",").map((key) => key.trim()),
          }
        : { kind: "run" as const, flag: (match[2] as string).trim() },
  );
}

const scopeOf = (flag: string): ConfigScope =>
  flag === "--oidc" ? "oidc" : flag === "--bootstrap" ? "bootstrap" : "deploy";

function resolve(file: RawValues, scope: ConfigScope) {
  return resolveStageConfig({
    stage: "production",
    scope,
    placeholders: false,
    values: file,
  });
}

describe("the runbook's first deploy sequence", () => {
  const markers = runbookMarkers(readFileSync(RUNBOOK, "utf8"));

  test("names its stage file edits and its runs in order", () => {
    expect(markers.map((m) => (m.kind === "run" ? m.flag : "file"))).toEqual([
      "file",
      "--oidc",
      "--bootstrap",
      "file",
      "file",
      "--skip-smoke",
    ]);
  });

  test("passes the preflight validation at every run with the stage file filled in exactly as each step says", () => {
    const file: RawValues = {};
    let runs = 0;
    for (const marker of markers) {
      if (marker.kind === "stage-file") {
        for (const key of marker.keys) {
          expect(
            SAMPLE[key],
            `the sample has no value for ${key}`,
          ).toBeDefined();
          file[key] = SAMPLE[key];
        }
        continue;
      }
      expect(
        () => resolve(file, scopeOf(marker.flag)),
        marker.flag,
      ).not.toThrow();
      runs += 1;
    }
    expect(runs).toBe(3);
  });

  test("the OIDC and bootstrap runs pass with only the first step's keys, and a deploy does not", () => {
    const first = markers.find((m) => m.kind === "stage-file");
    const keys = first?.kind === "stage-file" ? first.keys : [];
    const file = Object.fromEntries(keys.map((key) => [key, SAMPLE[key]]));
    expect(() => resolve(file, "oidc")).not.toThrow();
    expect(() => resolve(file, "bootstrap")).not.toThrow();
    expect(() => resolve(file, "deploy")).toThrow();
  });

  test("the final deploy needs every required key and the runbook supplies each one", () => {
    const supplied = new Set(
      markers.flatMap((m) => (m.kind === "stage-file" ? m.keys : [])),
    );
    for (const key of REQUIRED_KEYS.deploy) {
      expect(supplied.has(key), `the runbook never sets ${key}`).toBe(true);
    }
  });

  test("the real preflight accepts every documented run, in order, with the stage file as each step leaves it", async () => {
    const file: RawValues = {};
    const ran: string[] = [];
    for (const marker of markers) {
      if (marker.kind === "stage-file") {
        for (const key of marker.keys) file[key] = SAMPLE[key];
        continue;
      }
      const deps: DeployDeps = {
        args: parseDeployArgs(["--stage", "production", marker.flag]),
        env: { AWS_PROFILE: "admin", GITHUB_TOKEN: "t" },
        root: "/repo",
        infraDir: "/repo/modules/infra",
        stageFile: "/nope",
        loadConfig: (placeholders, scope) =>
          resolveStageConfig({
            stage: "production",
            scope,
            placeholders,
            values: file,
          }),
        stageConflicts: async () => [],
        isConfigError: (error): error is { problems: string[] } =>
          typeof error === "object" && error !== null && "problems" in error,
        run: async () => 0,
        identity: async () => ({ account: "123456789012" }),
        bootstrapVersion: async () =>
          ran.includes("--bootstrap") ? 29 : undefined,
        dockerAvailable: async () => true,
        writeBuildToken: () => "/t",
        removeBuildToken: () => {},
        stackOutputs: async () => ({}),
        migrate: async () => ({ taskArn: "t" }),
        log: () => {},
        error: () => {},
      };
      const result = await preflight(deps);
      expect(result.problems, `${marker.flag}`).toEqual([]);
      ran.push(marker.flag);
    }
    expect(ran).toEqual(["--oidc", "--bootstrap", "--skip-smoke"]);
  });
});
