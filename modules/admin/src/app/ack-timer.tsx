import { ackState } from "@pw-support/contracts";
import { useSyncExternalStore } from "react";
import { formatElapsed } from "@/lib/format";
import { cn } from "@/lib/utils";

const listeners = new Set<() => void>();
let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export function useNow(): Date {
  return new Date(useSyncExternalStore(subscribe, () => now));
}

const STYLES = {
  waiting: "bg-secondary text-secondary-foreground",
  warn: "bg-warn/20 text-warn-foreground ring-1 ring-warn/50",
  critical: "bg-critical/15 text-critical ring-1 ring-critical/50",
  acknowledged: "bg-ok/15 text-ok",
} as const;

const LABEL = {
  waiting: "Waiting",
  warn: "Waiting, past the warning threshold",
  critical: "Waiting, past the critical threshold",
  acknowledged: "Acknowledged in",
} as const;

export function AckTimer({
  createdAt,
  acknowledgedAt,
  size = "sm",
}: {
  createdAt: string;
  acknowledgedAt: string | null;
  size?: "sm" | "lg";
}) {
  const current = useNow();
  const { state, seconds } = ackState(
    new Date(createdAt),
    acknowledgedAt ? new Date(acknowledgedAt) : null,
    current,
  );
  return (
    <span
      data-testid="ack-timer"
      data-state={state}
      title={LABEL[state]}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md font-medium tabular-nums",
        size === "lg" ? "px-3 py-1.5 text-2xl" : "px-2 py-0.5 text-sm",
        STYLES[state],
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full bg-current",
          state === "critical" && "animate-pulse",
        )}
      />
      <span className="sr-only">{LABEL[state]} </span>
      {formatElapsed(seconds)}
    </span>
  );
}
