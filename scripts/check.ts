export {};

interface Stage {
  name: string;
  commands: string[][];
}

const skipInstall = process.argv.includes("--skip-install");

const stages: Stage[] = [
  { name: "install", commands: [["bun", "install", "--frozen-lockfile"]] },
  {
    name: "lint",
    commands: [
      ["bun", "run", "lint"],
      ["bun", "run", "validate:pipelines"],
    ],
  },
  { name: "build", commands: [["bun", "run", "build"]] },
  { name: "typecheck", commands: [["bun", "run", "typecheck"]] },
  {
    name: "stack",
    commands: [
      ["bun", "run", "stack:up"],
      ["bun", "scripts/stack-setup.ts"],
      ["bun", "run", "db:migrate"],
    ],
  },
  { name: "test", commands: [["bun", "run", "test"]] },
  {
    name: "e2e",
    commands: [
      ["bun", "scripts/ensure-chromium.ts"],
      ["bun", "run", "e2e"],
      ["bun", "run", "validate:phase-4"],
    ],
  },
  { name: "synth", commands: [["bun", "run", "synth"]] },
].filter((stage) => !(skipInstall && stage.name === "install"));

interface Result {
  name: string;
  status: "pass" | "fail" | "skipped";
  seconds: number;
}

async function runStage(stage: Stage): Promise<boolean> {
  for (const command of stage.commands) {
    const proc = Bun.spawn(command, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
    });
    if ((await proc.exited) !== 0) return false;
  }
  return true;
}

const results: Result[] = [];
let failed = false;

for (const stage of stages) {
  if (failed) {
    results.push({ name: stage.name, status: "skipped", seconds: 0 });
    continue;
  }
  console.log(`\n[check] ${stage.name}`);
  const started = performance.now();
  const ok = await runStage(stage);
  const seconds = (performance.now() - started) / 1000;
  results.push({ name: stage.name, status: ok ? "pass" : "fail", seconds });
  failed = !ok;
}

console.log("\n[check] summary");
console.log("stage      status   seconds");
for (const r of results) {
  console.log(
    `${r.name.padEnd(10)} ${r.status.padEnd(8)} ${r.seconds.toFixed(1)}`,
  );
}
console.log(failed ? "\n[check] FAILED" : "\n[check] PASSED");

process.exit(failed ? 1 : 0);
