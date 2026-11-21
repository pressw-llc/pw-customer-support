export const STYLES = `
:host { all: initial; }
.root {
  all: initial;
  --bg: #ffffff;
  --surface: #f5f6f8;
  --border: #d9dce1;
  --fg: #1c2330;
  --muted: #5d6675;
  --accent: #1f5eff;
  --accent-fg: #ffffff;
  --danger: #b3261e;
  --warn: #8a5a00;
  --mine: #e8efff;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .root {
    --bg: #161a22;
    --surface: #1e232d;
    --border: #343b49;
    --fg: #e8ebf0;
    --muted: #a0a8b6;
    --accent: #6c93ff;
    --accent-fg: #0d1220;
    --danger: #ff8a80;
    --warn: #f0c36d;
    --mine: #24304d;
  }
}
.root *, .root *::before, .root *::after { box-sizing: border-box; font: inherit; color: inherit; }
.launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--accent); color: var(--accent-fg);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  display: flex; align-items: center; justify-content: center;
}
.launcher svg { width: 26px; height: 26px; fill: currentColor; color: var(--accent-fg); }
.badge {
  position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px;
  padding: 0 5px; border-radius: 10px; background: var(--danger); color: #fff;
  font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center;
}
.badge, .badge * { color: #fff; }
.panel {
  position: fixed; right: 20px; bottom: 88px; z-index: 2147483000;
  width: 380px; max-width: calc(100vw - 24px); height: 600px; max-height: calc(100vh - 108px);
  display: flex; flex-direction: column; overflow: hidden;
  background: var(--bg); border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
}
.panel:focus { outline: none; }
@media (max-width: 480px) {
  .panel { right: 0; bottom: 0; width: 100vw; max-width: 100vw; height: 100vh; max-height: 100vh; border-radius: 0; }
  .launcher { right: 14px; bottom: 14px; }
}
.header {
  display: flex; align-items: center; gap: 8px; padding: 12px 14px;
  border-bottom: 1px solid var(--border); background: var(--surface);
}
.header h2 { margin: 0; font-size: 15px; font-weight: 600; flex: 1; display: block; }
.icon {
  border: 0; background: transparent; cursor: pointer; padding: 4px 8px; border-radius: 6px;
  font-size: 18px; line-height: 1;
}
.icon:hover { background: var(--border); }
.body { display: flex; flex-direction: column; gap: 12px; padding: 14px; overflow-y: auto; flex: 1; }
.messages { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; max-height: 280px; }
.message { background: var(--surface); border-radius: 10px; padding: 8px 10px; max-width: 92%; align-self: flex-start; }
.message.mine { background: var(--mine); align-self: flex-end; }
.message p { margin: 0; display: block; }
.message-head { font-size: 12px; color: var(--muted); margin-bottom: 2px; }
.message-head * { color: var(--muted); }
.message-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.requests { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.request {
  width: 100%; text-align: left; cursor: pointer; display: flex; flex-direction: column; gap: 2px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg);
}
.request:hover { background: var(--surface); }
.request-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
.request-meta { font-size: 12px; color: var(--muted); display: block; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); margin-right: 6px; }
.composer { display: flex; flex-direction: column; gap: 6px; }
.composer label { font-weight: 600; display: block; }
.composer .file-label { margin-top: 4px; }
textarea, input[type="file"] {
  width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg); color: var(--fg); display: block;
}
textarea { resize: vertical; min-height: 84px; }
.files { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 13px; }
.files li { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.hint { font-size: 12px; color: var(--muted); margin: 0; display: block; }
.muted { color: var(--muted); margin: 0; display: block; }
.warn { color: var(--warn); font-size: 12px; margin: 0; display: block; }
.error { color: var(--danger); margin: 0; display: block; }
.alert { border: 1px solid var(--danger); border-radius: 8px; padding: 8px 10px; color: var(--danger); }
.alert p { margin: 0 0 4px; display: block; }
.alert ul { margin: 0; padding-left: 18px; }
button { font-family: inherit; }
.primary {
  border: 0; border-radius: 8px; padding: 9px 14px; cursor: pointer; font-weight: 600;
  background: var(--accent); color: var(--accent-fg); display: block; width: 100%;
}
.primary:disabled { opacity: 0.55; cursor: not-allowed; }
.link { border: 0; background: transparent; padding: 0; cursor: pointer; color: var(--accent); text-decoration: underline; text-align: left; }
:is(button, textarea, input):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;
