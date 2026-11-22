import { App } from "aws-cdk-lib";
import { createSupportStacks, loadStageConfig, parseStage } from "../src/index";

const app = new App();
const readContext = (key: string) => app.node.tryGetContext(key);
const config = loadStageConfig({
  stage: parseStage(readContext("stage")),
  placeholders: String(readContext("placeholders")) === "true",
  readContext,
});

if (config.placeholders.length > 0) {
  console.warn(
    `[infra] placeholder values for: ${config.placeholders.join(", ")}; not deployable`,
  );
}
createSupportStacks(app, config);
app.synth();
