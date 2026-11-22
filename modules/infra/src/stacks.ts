import { resourceNames } from "@pw-support/contracts";
import { type App, Tags } from "aws-cdk-lib";
import { SupportAppStack } from "./app-stack";
import { type StageConfig, stackIds } from "./config";
import { GithubOidcStack } from "./github-oidc-stack";
import { SupportStack } from "./support-stack";

export function createSupportStacks(app: App, config: StageConfig) {
  const ids = stackIds(config.stage);
  const foundation = new SupportStack(app, ids.foundation, { config });
  const appStack = new SupportAppStack(app, ids.app, { foundation, config });
  const oidc = new GithubOidcStack(app, ids.oidc, { config });
  const names = resourceNames(config.stage);
  for (const stack of [foundation, appStack, oidc]) {
    Tags.of(stack).add(names.stageTag, config.stage);
  }
  return { foundation, app: appStack, oidc, ids };
}

export { stackIds };
