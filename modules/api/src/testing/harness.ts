import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { hashCustomerId } from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  ensureProject,
  migrate,
  projects,
  type SupportDb,
} from "@pw-support/db";
import { eq } from "drizzle-orm";
import { type AppDeps, createApp } from "../app";
import { type ApiConfig, loadConfig } from "../config";
import { createS3Storage } from "../storage";

export interface Tenant {
  projectId: string;
  projectKey: string;
  email: string;
  hashedId: string;
  headers: Record<string, string>;
}

export interface HarnessOptions {
  rateLimit?: Partial<ApiConfig["rateLimit"]>;
  maxBodyBytes?: number;
  deps?: Partial<AppDeps>;
}

export async function createHarness(options: HarnessOptions = {}) {
  await migrate();
  const db: SupportDb = createDb();
  const base = loadConfig({});
  const config: ApiConfig = {
    ...base,
    maxBodyBytes: options.maxBodyBytes ?? base.maxBodyBytes,
    rateLimit: { ...base.rateLimit, ...options.rateLimit },
  };
  const storage = createS3Storage(config);
  const app = createApp({ db, storage, config, ...options.deps });
  const clientSlug = `acme-test-${crypto.randomUUID().slice(0, 8)}`;
  const s3 = new S3Client({
    region: config.s3.region,
    endpoint: config.s3.endpoint,
    forcePathStyle: true,
    credentials: config.s3.credentials,
  });

  async function tenant(email = "ada@acme.test"): Promise<Tenant> {
    const { project, key } = await ensureProject(db, {
      clientSlug,
      projectSlug: `p-${crypto.randomUUID().slice(0, 8)}`,
      name: "Portal",
    });
    return asTenant(project.id, key, email);
  }

  async function asTenant(
    projectId: string,
    projectKey: string,
    email: string,
  ): Promise<Tenant> {
    const hashedId = await hashCustomerId(email, projectKey);
    return {
      projectId,
      projectKey,
      email,
      hashedId,
      headers: { "X-Support-Key": projectKey, "X-Support-User": hashedId },
    };
  }

  function call(
    who: { headers: Record<string, string> },
    method: string,
    path: string,
    body?: FormData,
  ): Promise<Response> {
    return Promise.resolve(
      app.request(`/v1${path}`, { method, headers: who.headers, body }),
    );
  }

  async function listKeys(prefix: string): Promise<string[]> {
    const result = await s3.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix }),
    );
    return (result.Contents ?? []).flatMap((item) =>
      item.Key ? [item.Key] : [],
    );
  }

  async function close(): Promise<void> {
    await db.delete(projects).where(eq(projects.clientSlug, clientSlug));
    s3.destroy();
    await closeDb(db);
  }

  return { app, db, config, tenant, asTenant, call, listKeys, close };
}

export function form(
  text: string | null,
  files: { name: string; bytes: Uint8Array; type?: string }[] = [],
): FormData {
  const data = new FormData();
  if (text !== null) data.set("text", text);
  for (const file of files) {
    data.append(
      "files",
      new File([file.bytes], file.name, {
        type: file.type ?? "application/octet-stream",
      }),
    );
  }
  return data;
}
