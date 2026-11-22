import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";

const root = join(import.meta.dir, "..", "..");
const read = (name: string) =>
  YAML.parse(
    readFileSync(join(root, ".github", "workflows", name), "utf8"),
  ) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        environment?: string;
        steps: {
          uses?: string;
          run?: string;
          with?: Record<string, unknown>;
        }[];
      }
    >;
  };

const deploy = read("deploy.yml");
const ci = read("ci.yml");
const steps = deploy.jobs.deploy?.steps ?? [];

describe("deploy workflow", () => {
  test("runs only on a manual dispatch and never on a pull request", () => {
    expect(Object.keys(deploy.on)).toEqual(["workflow_dispatch"]);
    expect(deploy.on.pull_request).toBeUndefined();
    expect(deploy.on.pull_request_target).toBeUndefined();
  });

  test("has exactly one run step, the deploy script", () => {
    expect(steps.filter((step) => step.run).map((step) => step.run)).toEqual([
      "bun run deploy --stage production",
    ]);
  });

  test("uses only checkout, bun setup, and the AWS credentials action", () => {
    const uses = steps.filter((step) => step.uses).map((step) => step.uses);
    expect(uses).toEqual([
      "actions/checkout@v4",
      "oven-sh/setup-bun@v2",
      "aws-actions/configure-aws-credentials@v4",
    ]);
  });

  test("assumes the deploy role through OIDC in the production environment", () => {
    expect(deploy.permissions["id-token"]).toBe("write");
    expect(deploy.permissions.contents).toBe("read");
    expect(deploy.jobs.deploy?.environment).toBe("production");
    const aws = steps.find((step) => step.uses?.startsWith("aws-actions/"));
    expect(aws?.with?.["aws-region"]).toBe("us-east-1");
    expect(String(aws?.with?.["role-to-assume"])).toContain(
      "AWS_DEPLOY_ROLE_ARN",
    );
  });

  test("keeps the CI workflow on one check step that the deploy job does not repeat", () => {
    expect(Object.keys(ci.on)).toContain("pull_request");
    const runs = (ci.jobs.check?.steps ?? []).filter((step) => step.run);
    expect(runs.map((step) => step.run)).toEqual(["bun run check"]);
  });
});
