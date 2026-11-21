import type { AdminRequestDetail } from "@pw-support/contracts";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download, Paperclip } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { AckTimer } from "@/app/ack-timer";
import { type ApiClient, queries, useApi } from "@/app/api";
import { Signals, StatusChip, TicketLink } from "@/app/pages/requests";
import { ErrorState, RowsSkeleton } from "@/app/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { eventLabel, formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

type Message = AdminRequestDetail["messages"][number];
type Reply = AdminRequestDetail["replies"][number];

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-3", className)}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function MessageItem({ message, api }: { message: Message; api: ApiClient }) {
  const internal = message.audience === "internal";
  return (
    <li
      data-audience={message.audience}
      className={cn(
        "rounded-lg border p-4",
        internal
          ? "border-dashed bg-muted/60"
          : message.author === "customer"
            ? "bg-card"
            : "border-primary/40 bg-accent",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <Badge
          variant={message.author === "customer" ? "secondary" : "default"}
        >
          {message.authorName
            ? `${message.authorName} (${message.author})`
            : message.author}
        </Badge>
        <Badge variant="outline">via {message.originChannel}</Badge>
        <Badge
          variant="outline"
          className={internal ? "border-warn/60 text-warn-foreground" : ""}
        >
          {internal ? "Internal only" : "Customer visible"}
        </Badge>
        {message.bodyFlagged ? (
          <Badge variant="outline" className="border-critical/60 text-critical">
            Body flagged
          </Badge>
        ) : null}
        <time
          className="ml-auto text-muted-foreground"
          dateTime={message.createdAt}
        >
          {new Date(message.createdAt).toLocaleString()}
        </time>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
      {message.attachments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((file) => (
            <li key={file.id}>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void api.download(`/attachments/${file.id}`, file.filename)
                }
              >
                <Paperclip aria-hidden="true" />
                {file.filename}
                <span className="text-muted-foreground">
                  {formatBytes(file.sizeBytes)}
                </span>
                <Download aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

const REPLY_STATE: Record<Reply["status"], string> = {
  held: "Held, not sent to the customer",
  sent: "Sent to the customer",
  cancelled: "Hold cancelled",
  expired: "Hold expired",
};

function ReplyItem({ reply }: { reply: Reply }) {
  return (
    <li
      data-testid="reply-item"
      data-status={reply.status}
      data-flagged={reply.flagged}
      className="space-y-1 rounded-lg border p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            reply.status === "held" && "border-critical/60 text-critical",
            reply.status === "sent" &&
              reply.flagged &&
              "border-warn/60 text-warn-foreground",
          )}
        >
          {REPLY_STATE[reply.status]}
        </Badge>
        {reply.flagged && reply.status === "sent" ? (
          <Badge
            variant="outline"
            className="border-warn/60 text-warn-foreground"
          >
            Flagged
          </Badge>
        ) : null}
        <span className="ml-auto tabular-nums" data-testid="reply-score">
          score {reply.score.toFixed(2)}
        </span>
      </div>
      <p className="whitespace-pre-wrap break-words text-muted-foreground">
        {reply.body}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs text-muted-foreground">
        <dt>Author</dt>
        <dd>{reply.authorName ?? "unknown"}</dd>
        {reply.holdReason ? (
          <>
            <dt>Reason</dt>
            <dd>{reply.holdReason.replaceAll("_", " ")}</dd>
          </>
        ) : null}
        {reply.cancelReason ? (
          <>
            <dt>Cancelled</dt>
            <dd>{reply.cancelReason}</dd>
          </>
        ) : null}
        {reply.expiresAt ? (
          <>
            <dt>Expires</dt>
            <dd>{new Date(reply.expiresAt).toLocaleString()}</dd>
          </>
        ) : null}
        {reply.status === "held" ? (
          <>
            <dt>Warning</dt>
            <dd>{reply.warningPosted ? "posted in the thread" : "pending"}</dd>
          </>
        ) : null}
      </dl>
    </li>
  );
}

function PayloadSummary({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload).filter(
    ([, value]) => typeof value !== "object" || value === null,
  );
  if (entries.length === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {entries.map(([key, value]) => `${key} ${String(value)}`).join(", ")}
    </span>
  );
}

function EventList({ events }: { events: AdminRequestDetail["events"] }) {
  if (events.length === 0)
    return <p className="text-sm text-muted-foreground">None.</p>;
  return (
    <ol className="space-y-2 border-l pl-4">
      {events.map((event) => (
        <li key={event.seq} className="text-sm">
          <span className="font-medium">{eventLabel(event.type)}</span>{" "}
          <time
            className="text-xs text-muted-foreground"
            dateTime={event.createdAt}
          >
            {new Date(event.createdAt).toLocaleTimeString()}
          </time>
          <br />
          <PayloadSummary payload={event.payload} />
        </li>
      ))}
    </ol>
  );
}

export function RequestDetailPage() {
  const api = useApi();
  const { id = "" } = useParams();
  const query = useQuery(queries.request(api, id));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        to="/requests"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All requests
      </Link>
      {query.isPending ? <RowsSkeleton rows={4} /> : null}
      {query.isError ? (
        <ErrorState
          title="Request not found"
          detail="It may have been removed, or you may not have access."
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data ? <Detail detail={query.data} api={api} /> : null}
    </div>
  );
}

function Detail({
  detail,
  api,
}: {
  detail: AdminRequestDetail;
  api: ApiClient;
}) {
  const { request } = detail;
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <h1 className="line-clamp-2 text-xl font-semibold tracking-tight">
            {request.preview || "(no text)"}
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <StatusChip status={request.status} />
            <span>
              {request.clientSlug}/{request.projectSlug}
            </span>
            <span>customer {request.customer}</span>
            <TicketLink item={request} />
          </div>
          <Signals item={request} />
        </div>
        <div className="text-right">
          <AckTimer
            size="lg"
            createdAt={request.createdAt}
            acknowledgedAt={request.acknowledgedAt}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {request.acknowledgedAt
              ? "Time to first staff response"
              : "Since the request arrived"}
          </p>
        </div>
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Section title="Thread">
          <ul className="space-y-3">
            {detail.messages.map((message) => (
              <MessageItem key={message.id} message={message} api={api} />
            ))}
          </ul>
          {detail.rejections.length > 0 ? (
            <div className="rounded-lg border border-critical/40 p-3 text-sm">
              <p className="font-medium">Rejected attachments</p>
              <ul className="mt-1 text-muted-foreground">
                {detail.rejections.map((row) => (
                  <li key={`${row.filename}-${row.reason}`}>
                    {row.filename} ({formatBytes(row.sizeBytes)}):{" "}
                    {row.reason.replaceAll("_", " ")}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>

        <div className="space-y-6">
          <Section title="Replies">
            {detail.replies.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No @external replies yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {detail.replies.map((reply) => (
                  <ReplyItem key={reply.id} reply={reply} />
                ))}
              </ul>
            )}
          </Section>
          <Section title="Triage">
            {detail.job ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Job</dt>
                <dd>{detail.job.status}</dd>
                <dt className="text-muted-foreground">Outcome</dt>
                <dd>{detail.job.outcome?.replaceAll("_", " ") ?? "pending"}</dd>
                <dt className="text-muted-foreground">Attempts</dt>
                <dd>{detail.job.attempts}</dd>
                <dt className="text-muted-foreground">Claimed by</dt>
                <dd>{detail.job.claimedBy ?? "nobody"}</dd>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No triage job.</p>
            )}
            {detail.judgments.length > 0 ? (
              <ul className="space-y-1 text-sm">
                {detail.judgments.map((judgment) => (
                  <li
                    key={`${judgment.kind}-${judgment.createdAt}-${judgment.score}`}
                    className="flex justify-between gap-2"
                  >
                    <span>{judgment.kind}</span>
                    <span
                      className={cn(
                        "tabular-nums",
                        judgment.flagged && "font-medium text-critical",
                      )}
                    >
                      {judgment.score.toFixed(2)} /{" "}
                      {judgment.threshold.toFixed(2)}
                      {judgment.flagged ? " flagged" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
          <Section title="Claim history">
            <EventList events={detail.claims} />
          </Section>
          <Section title="Timeline">
            <EventList events={detail.events} />
          </Section>
        </div>
      </div>
    </>
  );
}
