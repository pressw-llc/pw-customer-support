import { App } from "aws-cdk-lib";
import { AWS_REGION, SupportStack } from "../src/index";

const app = new App();
new SupportStack(app, "PwSupport", { env: { region: AWS_REGION } });
app.synth();
