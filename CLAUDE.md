# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

The repository holds only a `README.md`. It has no source code, package manifest, build, lint, or test tooling yet.

The workspace `CLAUDE.md` one directory up applies here. It sets the shared PressW conventions: `bun` for every command, Biome for lint and format, and worktrees under `.claude/worktrees/<branch-name>`.

## Delivery loop

Start work with `/delivery-loop:scope <branch>`. Use `/delivery-loop:activate` for planning or review with no worktree.

The delivery-loop skills own the methodology. Invoke them instead of re-deriving the process: `goal-prd`, `phased-plan`, `work`, `worktree-execution`, `adversarial-review-loop`, `live-validation`, `evidence-pr`, `debug-to-root-cause`.

Plans live under `docs/plans/<plan>/`. Each plan holds `PRD.md` and an `evidence/` directory.

Project settings live in `.delivery/config`. Template overrides live in `.delivery/templates/`. Both are committed. Session and run state is gitignored.

## Updating this file

Replace the "Repository state" section when the first code lands. Record the real commands from `package.json`, the single-test command, and the architecture.
