import {
  type AdminProject,
  ccListSchema,
  type MintedKey,
  slugSchema,
} from "@pw-support/contracts";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { queries, useApi, useProjectMutations } from "@/app/api";
import { EmptyState, ErrorState, RowsSkeleton } from "@/app/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

function Field({
  id,
  label,
  hint,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
} & React.ComponentProps<"input">) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} {...props} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: AdminProject) => void;
}) {
  const { create } = useProjectMutations();
  const [clientSlug, setClientSlug] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [name, setName] = useState("");
  const [team, setTeam] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (
      !slugSchema.safeParse(clientSlug).success ||
      !slugSchema.safeParse(projectSlug).success
    ) {
      setProblem("Slugs use letters, numbers, dots, dashes, and underscores.");
      return;
    }
    setProblem(null);
    create.mutate(
      {
        clientSlug,
        projectSlug,
        name,
        linearTeamId: team.trim() === "" ? null : team,
      },
      {
        onSuccess: (project) => {
          setClientSlug("");
          setProjectSlug("");
          setName("");
          setTeam("");
          onOpenChange(false);
          onCreated(project);
        },
        onError: (error) =>
          setProblem(
            "status" in error && error.status === 409
              ? "A project with these slugs already exists."
              : "Could not create the project. Check the values and try again.",
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project is one customer-facing widget installation.
            </DialogDescription>
          </DialogHeader>
          <Field
            id="new-client"
            label="Client slug"
            value={clientSlug}
            required
            onChange={(e) => setClientSlug(e.target.value)}
          />
          <Field
            id="new-project"
            label="Project slug"
            value={projectSlug}
            required
            onChange={(e) => setProjectSlug(e.target.value)}
          />
          <Field
            id="new-name"
            label="Display name"
            value={name}
            required
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            id="new-team"
            label="Linear team ID"
            hint="Optional. Requests from this project become tickets in this team."
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          />
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DetailsSection({ project }: { project: AdminProject }) {
  const { update } = useProjectMutations();
  const [name, setName] = useState(project.name);
  const [team, setTeam] = useState(project.linearTeamId ?? "");
  useEffect(() => {
    setName(project.name);
    setTeam(project.linearTeamId ?? "");
  }, [project.name, project.linearTeamId]);

  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate({
      id: project.id,
      name,
      linearTeamId: team.trim() === "" ? null : team,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Project details">
      <h3 className="font-medium">Details and Linear team</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="project-name"
          label="Display name"
          value={name}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          id="project-team"
          label="Linear team ID"
          hint="Tickets for this project land in this team."
          value={team}
          onChange={(e) => setTeam(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={update.isPending}>
          Save details
        </Button>
        {update.isSuccess ? (
          <span role="status" className="text-sm text-ok">
            Details saved
          </span>
        ) : null}
        {update.isError ? (
          <span role="alert" className="text-sm text-destructive">
            Could not save details
          </span>
        ) : null}
      </div>
    </form>
  );
}

function KeysSection({ project }: { project: AdminProject }) {
  const { mintKey, revokeKey } = useProjectMutations();
  const [minted, setMinted] = useState<MintedKey | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <section className="space-y-3" aria-label="Project keys">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Project keys</h3>
        <Button
          size="sm"
          variant="outline"
          disabled={mintKey.isPending}
          onClick={() =>
            mintKey.mutate(project.id, { onSuccess: (key) => setMinted(key) })
          }
        >
          <Plus aria-hidden="true" /> Mint key
        </Button>
      </div>
      {minted ? (
        <div
          role="status"
          className="rounded-lg border border-primary/50 bg-accent p-3 text-sm"
        >
          <p className="font-medium">Copy this key now. It is shown once.</p>
          <code
            data-testid="minted-key"
            className="mt-1 block break-all font-mono text-xs"
          >
            {minted.key}
          </code>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2"
            onClick={() => setMinted(null)}
          >
            I have copied it
          </Button>
        </div>
      ) : null}
      {project.keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No keys yet. Mint one to let a widget connect.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {project.keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm"
            >
              <code
                className={cn(
                  "font-mono",
                  key.revokedAt && "text-muted-foreground line-through",
                )}
              >
                {key.masked}
              </code>
              <span className="text-muted-foreground">
                Created {new Date(key.createdAt).toLocaleDateString()}
                {key.revokedAt
                  ? `, revoked ${new Date(key.revokedAt).toLocaleDateString()}`
                  : ""}
              </span>
              {!key.revokedAt ? (
                <span className="ml-auto flex items-center gap-2">
                  {confirming === key.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={revokeKey.isPending}
                        onClick={() =>
                          revokeKey.mutate(
                            { id: project.id, keyId: key.id },
                            { onSettled: () => setConfirming(null) },
                          )
                        }
                      >
                        Confirm revoke
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirming(null)}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirming(key.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CcSection({ project }: { project: AdminProject }) {
  const { ccList } = useProjectMutations();
  const [emails, setEmails] = useState(project.ccList);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setEmails(project.ccList), [project.ccList]);

  function add() {
    const parsed = ccListSchema.safeParse([draft]);
    if (!parsed.success) {
      setProblem("Enter a valid email address.");
      return;
    }
    setProblem(null);
    setEmails((current) => [...new Set([...current, ...parsed.data])]);
    setDraft("");
  }

  return (
    <section className="space-y-3" aria-label="Severe-request CC list">
      <div>
        <h3 className="font-medium">Severe-request CC list</h3>
        <p className="text-sm text-muted-foreground">
          People to copy on severe requests from this project. The list is
          stored now and used when Slack alerts launch.
        </p>
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <Label htmlFor="cc-email" className="sr-only">
            Email address
          </Label>
          <Input
            id="cc-email"
            type="email"
            placeholder="name@example.com"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
            }}
          />
        </div>
        <Button type="button" variant="outline" onClick={add}>
          Add
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {emails.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nobody is on the list yet.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="CC recipients">
          {emails.map((email) => (
            <li
              key={email}
              className="flex items-center gap-1 rounded-md bg-secondary py-1 pl-2.5 pr-1 text-sm"
            >
              {email}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${email}`}
                onClick={() =>
                  setEmails((current) =>
                    current.filter((item) => item !== email),
                  )
                }
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3">
        <Button
          disabled={ccList.isPending}
          onClick={() => ccList.mutate({ id: project.id, emails })}
        >
          Save CC list
        </Button>
        {ccList.isSuccess ? (
          <span role="status" className="text-sm text-ok">
            CC list saved
          </span>
        ) : null}
        {ccList.isError ? (
          <span role="alert" className="text-sm text-destructive">
            Could not save the CC list
          </span>
        ) : null}
      </div>
    </section>
  );
}

export function ProjectsPanel() {
  const api = useApi();
  const query = useQuery(queries.projects(api));
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  if (query.isPending) return <RowsSkeleton rows={3} />;
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;

  const projects = query.data;
  const active =
    projects.find((project) => project.id === selected) ?? projects[0];

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <div className="space-y-2">
        <Button
          className="w-full"
          variant="outline"
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" /> New project
        </Button>
        <ul aria-label="Projects" className="space-y-1">
          {projects.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                aria-current={project.id === active?.id}
                onClick={() => setSelected(project.id)}
                className={cn(
                  "w-full rounded-md px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  project.id === active?.id
                    ? "bg-accent font-medium"
                    : "hover:bg-secondary",
                )}
              >
                <span className="block truncate">{project.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {project.clientSlug}/{project.projectSlug}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 space-y-8 rounded-lg border bg-card p-5">
        {active ? (
          <>
            <h2 className="text-lg font-semibold">
              {active.clientSlug}/{active.projectSlug}
            </h2>
            <DetailsSection project={active} />
            <KeysSection project={active} />
            <CcSection project={active} />
          </>
        ) : (
          <EmptyState title="No projects yet">
            Create a project, then mint a key for its widget.
          </EmptyState>
        )}
      </div>
      <NewProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(project) => setSelected(project.id)}
      />
    </div>
  );
}
