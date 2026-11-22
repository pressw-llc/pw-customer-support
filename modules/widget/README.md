# @pressw-llc/support-react

A drop-in React support widget for PressW client projects. The widget renders in a Shadow DOM, so host styles cannot break it and it needs no CSS from the host.

## Install

```bash
bun add @pressw-llc/support-react
```

The package publishes to npmjs and to GitHub Packages. React 18 or later is a peer dependency.

## Use

```tsx
import { SupportWidget } from "@pressw-llc/support-react";

export function App() {
  return <SupportWidget projectKey="pk_..." userEmail="user@example.com" />;
}
```

`projectKey` is the key PressW mints for the client project. `userEmail` identifies the customer. The widget sends the key and a SHA-256 hash of the email and key. It never sends the raw email.

## Browser bundle

The `./global` export is a self-contained script for pages without a build step.

```html
<div id="support"></div>
<script src="https://unpkg.com/@pressw-llc/support-react/dist/support-widget.global.js"></script>
<script>
  PressWSupport.mount(document.getElementById("support"), {
    projectKey: "pk_...",
    userEmail: "user@example.com",
  });
</script>
```

## Props

| Prop             | Required | Meaning                                       |
| ---------------- | -------- | --------------------------------------------- |
| `projectKey`     | yes      | The project key from PressW.                  |
| `userEmail`      | yes      | The customer email.                           |
| `apiUrl`         | no       | Overrides the API URL baked in at build time. |
| `pollIntervalMs` | no       | Overrides the polling interval.               |
