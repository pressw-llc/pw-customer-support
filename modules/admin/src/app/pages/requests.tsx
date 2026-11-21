import type { AdminRequestItem } from "@pw-support/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ExternalLink, Flag, PauseCircle, UserRoundSearch } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { AckTimer, useNow } from "@/app/ack-timer";
import { queries, useApi } from "@/app/api";
import { EmptyState, ErrorState, RowsSkeleton } from "@/app/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { relativeTime } from "@/lib/format";

const ANY = "any";
const STATUSES = ["open", "triaged", "closed"];

export function StatusChip({ status }: { status: string }) {
  return (
    <Badge variant={status === "open" ? "default" : "secondary"}>
      {status}
    </Badge>
  );
}

export function Signals({ item }: { item: AdminRequestItem }) {
  return (
    <span className="flex gap-1.5">
      {item.needsHumanTriage ? (
        <Badge
          variant="outline"
          className="gap-1 border-warn/60 text-warn-foreground"
        >
          <UserRoundSearch className="size-3" aria-hidden="true" />
          Human triage
        </Badge>
      ) : null}
      {item.heldReplies ? (
        <Badge
          variant="outline"
          className="gap-1 border-critical/60 text-critical"
        >
          <PauseCircle className="size-3" aria-hidden="true" />
          Held reply
        </Badge>
      ) : null}
      {item.flaggedReplies ? (
        <Badge
          variant="outline"
          className="gap-1 border-warn/60 text-warn-foreground"
        >
          <Flag className="size-3" aria-hidden="true" />
          Flagged reply
        </Badge>
      ) : null}
    </span>
  );
}

export function TicketLink({ item }: { item: AdminRequestItem }) {
  if (!item.ticket)
    return <span className="text-muted-foreground">No ticket</span>;
  return (
    <a
      href={item.ticket.url}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
    >
      {item.ticket.identifier}
      <ExternalLink className="size-3" aria-hidden="true" />
    </a>
  );
}

export function RequestsPage() {
  const api = useApi();
  const [params, setParams] = useSearchParams();
  const filters = {
    projectId: params.get("project") || undefined,
    status: params.get("status") || undefined,
    flaggedReplies: params.get("flagged") === "1" || undefined,
    needsHuman: params.get("human") === "1" || undefined,
  };
  const projects = useQuery(queries.projects(api));
  const list = useInfiniteQuery(queries.requests(api, filters));
  const now = useNow();
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];

  function setFilter(name: string, value: string | null) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next, { replace: true });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
        <p className="text-sm text-muted-foreground">
          Newest first. The timer runs until staff first respond.
        </p>
      </header>

      <form
        className="flex flex-wrap items-end gap-4"
        aria-label="Filter requests"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="space-y-1.5">
          <Label htmlFor="filter-project">Project</Label>
          <Select
            value={filters.projectId ?? ANY}
            onValueChange={(value) =>
              setFilter("project", value === ANY ? null : value)
            }
          >
            <SelectTrigger id="filter-project" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All projects</SelectItem>
              {(projects.data ?? []).map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.clientSlug}/{project.projectSlug}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="filter-status">Status</Label>
          <Select
            value={filters.status ?? ANY}
            onValueChange={(value) =>
              setFilter("status", value === ANY ? null : value)
            }
          >
            <SelectTrigger id="filter-status" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              {STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {status}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={Boolean(filters.flaggedReplies)}
            onChange={(event) =>
              setFilter("flagged", event.target.checked ? "1" : null)
            }
          />
          Flagged replies
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-[var(--primary)]"
            checked={Boolean(filters.needsHuman)}
            onChange={(event) =>
              setFilter("human", event.target.checked ? "1" : null)
            }
          />
          Needs human triage
        </label>
      </form>

      {list.isPending ? <RowsSkeleton /> : null}
      {list.isError ? (
        <ErrorState
          detail="Check your connection and try again."
          onRetry={() => void list.refetch()}
        />
      ) : null}
      {list.isSuccess && items.length === 0 ? (
        <EmptyState title="No requests match">
          Clear a filter, or wait for a customer to send a request from the
          widget.
        </EmptyState>
      ) : null}
      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">Waiting</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Ticket</TableHead>
                <TableHead>Signals</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <AckTimer
                      createdAt={item.createdAt}
                      acknowledgedAt={item.acknowledgedAt}
                    />
                  </TableCell>
                  <TableCell className="max-w-md">
                    <Link
                      to={`/requests/${item.id}`}
                      className="line-clamp-1 font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
                    >
                      {item.preview || "(no text)"}
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {item.clientSlug}/{item.projectSlug}, customer{" "}
                      {item.customer}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusChip status={item.status} />
                  </TableCell>
                  <TableCell>
                    <TicketLink item={item} />
                  </TableCell>
                  <TableCell>
                    <Signals item={item} />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {relativeTime(item.createdAt, now)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
      {list.hasNextPage ? (
        <Button
          variant="outline"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "Loading" : "Load more"}
        </Button>
      ) : null}
    </div>
  );
}
