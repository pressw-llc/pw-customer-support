import { describe, expect, test } from "bun:test";
import {
  ackState,
  adminRequestFiltersSchema,
  ccListInputSchema,
  createProjectInputSchema,
  INTEGRATIONS,
  integrationKindForSecretName,
  integrationKinds,
  maskProjectKey,
  saveIntegrationInputSchema,
  secretId,
  shortHash,
  updateProjectInputSchema,
} from "./admin";

describe("admin contracts", () => {
  test("secretId lives under the secrets prefix", () => {
    expect(secretId("global", "linear-api-key")).toBe(
      "pw-support/global/linear-api-key",
    );
  });

  test("every integration maps back from its secret name", () => {
    for (const kind of integrationKinds) {
      expect(integrationKindForSecretName(INTEGRATIONS[kind].secretName)).toBe(
        kind,
      );
    }
    expect(integrationKindForSecretName("other")).toBeUndefined();
  });

  test("project input accepts slugs and rejects separators", () => {
    expect(
      createProjectInputSchema.safeParse({
        clientSlug: "acme",
        projectSlug: "portal",
        name: " Portal ",
        linearTeamId: "team-1",
      }).success,
    ).toBe(true);
    for (const bad of ["a:b", "", "-x", "a b"]) {
      expect(
        createProjectInputSchema.safeParse({
          clientSlug: bad,
          projectSlug: "p",
          name: "n",
        }).success,
      ).toBe(false);
    }
  });

  test("project update needs a field", () => {
    expect(updateProjectInputSchema.safeParse({}).success).toBe(false);
    expect(
      updateProjectInputSchema.safeParse({ linearTeamId: null }).success,
    ).toBe(true);
  });

  test("cc list lowercases, dedupes, and validates", () => {
    const parsed = ccListInputSchema.parse({
      emails: ["Ada@Acme.test", "ada@acme.test", " bob@acme.test "],
    });
    expect(parsed.emails).toEqual(["ada@acme.test", "bob@acme.test"]);
    expect(ccListInputSchema.safeParse({ emails: ["nope"] }).success).toBe(
      false,
    );
    expect(
      ccListInputSchema.safeParse({
        emails: Array.from({ length: 51 }, (_, i) => `u${i}@acme.test`),
      }).success,
    ).toBe(false);
  });

  test("integration value is trimmed, non-empty, and bounded", () => {
    expect(saveIntegrationInputSchema.parse({ value: " abc " }).value).toBe(
      "abc",
    );
    expect(saveIntegrationInputSchema.safeParse({ value: "  " }).success).toBe(
      false,
    );
    expect(
      saveIntegrationInputSchema.safeParse({ value: "x".repeat(5000) }).success,
    ).toBe(false);
  });

  test("request filters coerce the query string", () => {
    const parsed = adminRequestFiltersSchema.parse({
      flaggedReplies: "true",
      needsHuman: "false",
      limit: "10",
    });
    expect(parsed).toMatchObject({
      flaggedReplies: true,
      needsHuman: false,
      limit: 10,
    });
    expect(adminRequestFiltersSchema.parse({}).limit).toBe(25);
    expect(adminRequestFiltersSchema.safeParse({ limit: "500" }).success).toBe(
      false,
    );
  });

  test("masks a key and shortens a hash", () => {
    expect(maskProjectKey("pk_abcdefghij")).toBe("pk_••••ghij");
    expect(shortHash("0123456789abcdef")).toBe("01234567");
  });

  test("ackState follows the thresholds", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const at = (minutes: number) =>
      new Date(created.getTime() + minutes * 60_000);
    expect(ackState(created, null, at(1)).state).toBe("waiting");
    expect(ackState(created, null, at(15)).state).toBe("warn");
    expect(ackState(created, null, at(61)).state).toBe("critical");
    expect(ackState(created, at(5), at(500))).toEqual({
      state: "acknowledged",
      seconds: 300,
    });
    expect(ackState(created, null, new Date(created.getTime() - 5000))).toEqual(
      { state: "waiting", seconds: 0 },
    );
  });
});
