import { lambdaHandlerFor } from "@pressw-llc/pipeline";
import pipeline from "../pipeline.config";
import deliver from "../steps/deliver/index";

export const handler = lambdaHandlerFor({
  pipeline,
  stepName: "deliver",
  step: deliver,
});
