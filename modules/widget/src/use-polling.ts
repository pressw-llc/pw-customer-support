import { useCallback, useEffect, useRef } from "react";

export function usePolling(
  task: () => Promise<void>,
  intervalMs: number,
): () => Promise<void> {
  const latest = useRef(task);
  latest.current = task;
  const running = useRef(false);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      await latest.current();
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    void run();
    const timer = setInterval(() => void run(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, run]);

  return run;
}
