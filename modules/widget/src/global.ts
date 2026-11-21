import { mount } from "./mount";

declare global {
  interface Window {
    PressWSupport?: { mount: typeof mount };
  }
}

window.PressWSupport = { mount };
