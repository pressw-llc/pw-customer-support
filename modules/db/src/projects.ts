import { and, eq, isNull } from "drizzle-orm";
import type { SupportExecutor } from "./client";
import { projectKeys, projects } from "./schema";

export type Project = typeof projects.$inferSelect;

export interface ResolvedKey {
  project: Project;
  keyId: string;
}

export function generateProjectKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `pk_${Buffer.from(bytes).toString("base64url")}`;
}

export async function findProjectByKey(
  db: SupportExecutor,
  key: string,
): Promise<ResolvedKey | null> {
  const [row] = await db
    .select({ project: projects, keyId: projectKeys.id })
    .from(projectKeys)
    .innerJoin(projects, eq(projects.id, projectKeys.projectId))
    .where(and(eq(projectKeys.key, key), isNull(projectKeys.revokedAt)))
    .limit(1);
  return row ?? null;
}

export interface EnsureProjectInput {
  clientSlug: string;
  projectSlug: string;
  name: string;
  key?: string;
}

export async function ensureProject(
  db: SupportExecutor,
  input: EnsureProjectInput,
): Promise<{ project: Project; key: string }> {
  await db
    .insert(projects)
    .values({
      clientSlug: input.clientSlug,
      projectSlug: input.projectSlug,
      name: input.name,
    })
    .onConflictDoNothing();
  const [project] = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.clientSlug, input.clientSlug),
        eq(projects.projectSlug, input.projectSlug),
      ),
    );
  if (!project) throw new Error("project missing after insert");
  const [existing] = await db
    .select({ key: projectKeys.key })
    .from(projectKeys)
    .where(
      and(eq(projectKeys.projectId, project.id), isNull(projectKeys.revokedAt)),
    )
    .limit(1);
  if (existing) return { project, key: existing.key };
  const key = input.key ?? generateProjectKey();
  await db.insert(projectKeys).values({ projectId: project.id, key });
  return { project, key };
}
