import { App } from "aws-cdk-lib";
import {
  createOidcStack,
  createSupportStacks,
  loadStageConfig,
  parseStage,
} from "../src/index";

const app = new App();
const readContext = (key: string) => app.node.tryGetContext(key);
const scope = ["oidc", "bootstrap"].includes(String(readContext("scope")))
  ? (readContext("scope") as "oidc" | "bootstrap")
  : "deploy";
const config = loadStageConfig({
  stage: parseStage(readContext("stage")),
  scope,
  placeholders: String(readContext("placeholders")) === "true",
  readContext,
});

if (config.placeholders.length > 0) {
  console.warn(
    `[infra] placeholder values for: ${config.placeholders.join(", ")}; not deployable`,
  );
}
if (scope === "deploy") createSupportStacks(app, config);
else createOidcStack(app, config);
app.synth();
