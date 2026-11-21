import { definePipeline } from "@pressw-llc/pipeline/define";
import { RESOURCE_NAMES } from "@pw-support/contracts";

export default definePipeline({
  name: "support-triage",
  trigger: { sqs: { queue: RESOURCE_NAMES.triageWakeQueue } },
  parentTaskRun: false,
  graph: {
    triage: { runtime: "fargate", terminal: true },
  },
});
