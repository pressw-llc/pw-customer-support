import type { App } from "aws-cdk-lib";
import { SupportAppStack } from "./app-stack";
import type { StageConfig, StageName } from "./config";
import { GithubOidcStack } from "./github-oidc-stack";
import { SupportStack } from "./support-stack";

export function stackIds(stage: StageName) {
  const suffix = stage === "production" ? "" : "Staging";
  return {
    foundation: `PwSupport${suffix}`,
    app: `PwSupport${suffix}App`,
    oidc: `PwSupport${suffix}GithubOidc`,
  };
}

export function createSupportStacks(app: App, config: StageConfig) {
  const ids = stackIds(config.stage);
  const foundation = new SupportStack(app, ids.foundation, { config });
  const appStack = new SupportAppStack(app, ids.app, { foundation, config });
  const oidc = new GithubOidcStack(app, ids.oidc, { config });
  return { foundation, app: appStack, oidc, ids };
}
