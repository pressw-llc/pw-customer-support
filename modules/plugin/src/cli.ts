#!/usr/bin/env bun
import { runCli } from "./commands";

const code = await runCli(process.argv.slice(2));
if (code !== undefined) process.exit(code);
