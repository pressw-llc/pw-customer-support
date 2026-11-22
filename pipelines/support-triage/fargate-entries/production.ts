import { productionStartupProblems } from "@pw-support/api";
import { main } from "./main";

const problems = productionStartupProblems();
if (problems.length > 0) {
  for (const problem of problems) console.error(`[config] ${problem}`);
  process.exit(1);
}
await main({ pollAdapterQueue: false });
process.exit(0);
