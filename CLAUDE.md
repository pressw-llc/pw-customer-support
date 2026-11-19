# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

The repository holds only a `README.md`. It has no source code, package manifest, build, lint, or test tooling yet.

The workspace `CLAUDE.md` one directory up applies here. It sets the shared PressW conventions: `bun` for every command, Biome for lint and format, and worktrees under `.claude/worktrees/<branch-name>`.

## Updating this file

Replace the "Repository state" section when the first code lands. Record the real commands from `package.json`, the single-test command, and the architecture.
