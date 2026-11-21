import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function Notice({
  title,
  children,
  tone = "neutral",
  action,
}: {
  title: string;
  children?: ReactNode;
  tone?: "neutral" | "error";
  action?: { label: string; onClick: () => void };
}) {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div
        role={tone === "error" ? "alert" : "status"}
        className="w-full max-w-sm space-y-3"
      >
        <h1
          className={cn(
            "text-lg font-semibold",
            tone === "error" && "text-destructive",
          )}
        >
          {title}
        </h1>
        {children ? (
          <p className="text-sm text-muted-foreground">{children}</p>
        ) : null}
        {action ? (
          <Button onClick={action.onClick}>{action.label}</Button>
        ) : null}
      </div>
    </main>
  );
}

export function ConfigProblem({ missing }: { missing: string[] }) {
  return (
    <Notice tone="error" title="Admin is not configured">
      Set {missing.join(", ")} in the build environment or in config.json.
    </Notice>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="font-medium">{title}</p>
      {children ? (
        <p className="mt-1 text-sm text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}

export function ErrorState({
  title = "Could not load this page",
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/40 bg-destructive/5 px-6 py-8"
    >
      <p className="font-medium text-destructive">{title}</p>
      {detail ? (
        <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
      ) : null}
      {onRetry ? (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

const SKELETON_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];

export function RowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      className="space-y-2"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {SKELETON_KEYS.slice(0, rows).map((key) => (
        <Skeleton key={key} className="h-12 w-full" />
      ))}
    </div>
  );
}
