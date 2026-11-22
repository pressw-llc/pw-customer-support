import type { IntegrationStatus } from "@pw-support/contracts";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNow } from "@/app/ack-timer";
import { queries, useApi, useSaveIntegration } from "@/app/api";
import { ErrorState, RowsSkeleton } from "@/app/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { relativeTime } from "@/lib/format";

const HELP: Record<string, string> = {
  linear_api_key: "Lets the desk create tickets and comments in Linear.",
  linear_webhook_secret: "Verifies that incoming Linear webhooks are genuine.",
  typesafe_api_key: "Lets the desk screen requests with Jev before triage.",
};

function IntegrationRow({ status }: { status: IntegrationStatus }) {
  const save = useSaveIntegration();
  const now = useNow();
  const [value, setValue] = useState("");
  const inputId = `integration-${status.kind}`;

  function submit(event: FormEvent) {
    event.preventDefault();
    const secret = value;
    setValue("");
    save.mutate({ kind: status.kind, value: secret });
  }

  return (
    <li className="space-y-3 py-5" data-kind={status.kind}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="font-medium">{status.label}</h2>
          <p className="text-sm text-muted-foreground">{HELP[status.kind]}</p>
        </div>
        <p
          data-testid={`status-${status.kind}`}
          className={
            status.configured
              ? "text-sm text-ok"
              : "text-sm text-muted-foreground"
          }
        >
          {status.configured && status.updatedAt
            ? `Configured · updated ${relativeTime(status.updatedAt, now)} by ${status.updatedBy}`
            : "Not configured"}
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1 space-y-1.5">
          <Label htmlFor={inputId}>
            {status.configured ? "Replace value" : "Value"}
          </Label>
          <Input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={
              status.configured
                ? "Stored securely. Enter a new value to replace it."
                : "Paste the value"
            }
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={value.trim() === "" || save.isPending}>
          {save.isPending ? "Saving" : "Save"}
        </Button>
      </form>
      {save.isSuccess ? (
        <p role="status" className="text-sm text-ok">
          Saved. The value is stored in Secrets Manager and cannot be shown
          again.
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Could not save. Check that the value is not empty and try again.
        </p>
      ) : null}
    </li>
  );
}

export function IntegrationsPanel() {
  const api = useApi();
  const query = useQuery(queries.integrations(api));
  if (query.isPending) return <RowsSkeleton rows={3} />;
  if (query.isError) {
    return <ErrorState onRetry={() => void query.refetch()} />;
  }
  return (
    <ul className="divide-y rounded-lg border bg-card px-5">
      {query.data.map((status) => (
        <IntegrationRow key={status.kind} status={status} />
      ))}
    </ul>
  );
}
