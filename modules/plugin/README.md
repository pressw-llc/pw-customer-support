# PressW Support plugin

The plugin lets an engineer subscribe to support channels, query request state, and complete triage jobs from a laptop.

## Install from a build

```bash
bun run build:plugin
claude --plugin-dir modules/plugin/dist/plugin
```

The build writes a self-contained plugin directory. `lib/cli.js` bundles the `pw-support` CLI, the watcher, and the stdio submit server, so the directory needs no workspace on disk. The laptop needs `bun` and `claude` on the path.

## Add to a marketplace repository

1. Run `bun run build:plugin`.
2. Copy `modules/plugin/dist/plugin` into the marketplace repository as `plugins/support`.
3. Add an entry with `"source": "./plugins/support"` to the marketplace `marketplace.json`.
4. Commit the directory. A marketplace install then runs `/plugin install support@<marketplace>`.

## Log in

Run `pw-support login` once in a terminal. Set `PW_SUPPORT_API_URL` to the deployed API. Then run `/support:watch start` in a session or `pw-support watch start` in a terminal.
