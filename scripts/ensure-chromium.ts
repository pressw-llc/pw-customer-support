import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";

const missing = !existsSync(chromium.executablePath());

if (missing || process.env.CI) {
  console.log("[ensure-chromium] installing chromium");
  const install = Bun.spawnSync(
    ["bunx", "playwright", "install", "--with-deps", "chromium"],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exit(install.exitCode ?? 1);
}

console.log("[ensure-chromium] chromium present");
