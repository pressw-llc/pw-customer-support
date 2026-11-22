import { describe, expect, test } from "bun:test";
import { App, Aspects } from "aws-cdk-lib";
import { Annotations, Match } from "aws-cdk-lib/assertions";
import { AwsSolutionsChecks } from "cdk-nag";
import { loadStageConfig } from "./load-config";
import { applySuppressions } from "./nag-suppressions";
import { createSupportStacks } from "./stacks";

function nagApp() {
  const app = new App();
  const config = loadStageConfig({
    stage: "production",
    placeholders: true,
    env: {},
  });
  const stacks = createSupportStacks(app, config);
  applySuppressions(stacks);
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  return stacks;
}

describe("cdk-nag AwsSolutions", () => {
  const stacks = nagApp();
  for (const [name, stack] of Object.entries({
    foundation: stacks.foundation,
    app: stacks.app,
    oidc: stacks.oidc,
  })) {
    test(`${name} stack has no unsuppressed errors`, () => {
      const errors = Annotations.fromStack(stack).findError(
        "*",
        Match.stringLikeRegexp("AwsSolutions-.*"),
      );
      expect(
        errors.map(
          (error) => `${error.id}: ${String(error.entry.data).slice(0, 160)}`,
        ),
      ).toEqual([]);
    });
  }
});
