import { definePipeline } from "@pressw-llc/pipeline/define";
import { RESOURCE_NAMES } from "@pw-support/contracts";

export default definePipeline({
  name: "linear-outbound",
  trigger: { sqs: { queue: RESOURCE_NAMES.linearAdapterQueue } },
  parentTaskRun: false,
  graph: {
    deliver: { runtime: "lambda", terminal: true },
  },
});
