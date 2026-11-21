import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SupportWidget } from "./SupportWidget";
import type { SupportWidgetProps } from "./types";

export interface MountedWidget {
  unmount(): void;
}

export function mount(
  element: Element,
  props: SupportWidgetProps,
): MountedWidget {
  const root = createRoot(element);
  root.render(createElement(SupportWidget, props));
  return { unmount: () => root.unmount() };
}
