import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import {
  GetFunctionCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
} from "@aws-sdk/client-lambda";
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { startLinearStub } from "@pw-support/channels/testing";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  RESOURCE_NAMES,
  resolveStackEnv,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import {
  closeDb,
  createDb,
  ensureProject,
  setProjectLinearTeam,
} from "@pw-support/db";
import { hydrateDatabaseEnv } from "../../pipelines/linear-outbound/lambda-entries/db-secret";
import { runSmoke } from "../smoke/lib";
import { freePort } from "./free-port";
import {
  buildSubset,
  type CfnTemplate,
  withLambdaStep,
  withOutputs,
} from "./local-subset";
import { type Managed, startProcess, waitForHttp } from "./proc";
import { assert, exec, Steps, waitFor } from "./steps";

const root = join(import.meta.dir, "..", "..");
const SUFFIX = crypto.randomUUID().slice(0, 8);
const LS_CONTAINER = `pw-support-deploy-ls-${SUFFIX}`;
const LS_PORT = freePort();
const LS_URL = `http://127.0.0.1:${LS_PORT}`;
const LS_FROM_DOCKER = `http://host.docker.internal:${LS_PORT}`;
const API_PORT = freePort();
const STUB_PORT = freePort();
const CONTAINER_API_PORT = freePort();
const API_IMAGE = `pw-support-api:rehearsal-${SUFFIX}`;
const WORKER_IMAGE = `pw-support-worker:rehearsal-${SUFFIX}`;
const stack = resolveStackEnv(process.env);
const POSTGRES_HOST_PORT = stack.postgresPort;

const steps = new Steps();
const work = mkdtempSync(join(tmpdir(), "pw-deploy-rehearsal-"));
const processes: Managed[] = [];
const containers: string[] = [LS_CONTAINER];
const stub = startLinearStub({ port: STUB_PORT });
const teamId = stub.teams[0]?.id as string;

const awsConfig = {
  endpoint: LS_URL,
  region: "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
};
const cfn = new CloudFormationClient(awsConfig);
const sqs = new SQSClient(awsConfig);
const s3 = new S3Client({ ...awsConfig, forcePathStyle: true });
const secrets = new SecretsManagerClient(awsConfig);
const lambda = new LambdaClient(awsConfig);

const state: {
  outputs: Record<string, string>;
  lambdaOk: boolean;
  lambdaDetail: string;
  projectKey: string;
} = {
  outputs: {},
  lambdaOk: false,
  lambdaDetail: "not attempted",
  projectKey: "",
};

const cleanEnv = {
  ...process.env,
  SUPPORT_STAGE_CONFIG: undefined,
  AWS_ACCESS_KEY_ID: undefined,
  AWS_PROFILE: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
};

async function waitStack(name: string, expect: string): Promise<void> {
  await waitFor(
    async () => {
      const result = await cfn.send(
        new DescribeStacksCommand({ StackName: name }),
      );
      const status = result.Stacks?.[0]?.StackStatus ?? "";
      if (status.endsWith("FAILED") || status.includes("ROLLBACK")) {
        const events = await cfn.send(
          new DescribeStackEventsCommand({ StackName: name }),
        );
        const failed = (events.StackEvents ?? [])
          .filter((event) => event.ResourceStatus?.endsWith("FAILED"))
          .map(
            (event) =>
              `${event.LogicalResourceId}: ${event.ResourceStatusReason}`,
          );
        throw new Error(`${name} ${status}: ${failed.join("; ")}`);
      }
      return status === expect;
    },
    `${name} ${expect}`,
    180_000,
  ).catch((error) => {
    throw error;
  });
}

async function outputsOf(name: string): Promise<Record<string, string>> {
  const result = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  return Object.fromEntries(
    (result.Stacks?.[0]?.Outputs ?? []).map((o) => [
      o.OutputKey as string,
      o.OutputValue as string,
    ]),
  );
}

function readTemplate(name: string): CfnTemplate {
  return JSON.parse(
    readFileSync(
      join(root, "modules", "infra", "cdk.out", `${name}.template.json`),
      "utf8",
    ),
  ) as CfnTemplate;
}

function localEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: undefined,
    AWS_ENDPOINT_URL: LS_URL,
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    ATTACHMENTS_BUCKET: state.outputs.AttachmentsBucket,
    LINEAR_API_URL: stub.url,
    LINEAR_API_KEY: "local-rehearsal",
    TRIAGE_INITIAL_DELAY_SECONDS: "1",
    TRIAGE_SWEEP_INTERVAL_SECONDS: "2",
    API_PORT: String(API_PORT),
    ...extra,
  };
}

const stubReadback = async (token: string) => {
  const issue = stub.issues.find((candidate) =>
    candidate.description.includes(token),
  );
  return issue
    ? { id: issue.id, identifier: issue.identifier, url: issue.url }
    : undefined;
};

async function submitSmoke(apiUrl: string) {
  const result = await runSmoke({
    apiUrl,
    projectKey: state.projectKey,
    readback: stubReadback,
    timeoutMs: 150_000,
    intervalMs: 1_000,
  });
  return `${result.ticket.identifier} ${result.ticket.url} (request ${result.requestId})`;
}

async function buildImage(target: string, tag: string): Promise<string> {
  const tokenFile = join(work, "github_token");
  writeFileSync(
    tokenFile,
    process.env.GITHUB_TOKEN || process.env.GH_PACKAGES_TOKEN || "",
    {
      mode: 0o600,
    },
  );
  const built = await exec(
    [
      "docker",
      "build",
      "--secret",
      `id=github_token,src=${tokenFile}`,
      "--target",
      target,
      "-t",
      tag,
      ".",
    ],
    { cwd: root },
  );
  assert(
    built.code === 0,
    `docker build ${target} failed:\n${built.out.slice(-1500)}`,
  );
  return tag;
}

try {
  await steps.run(
    "deploy --dry-run succeeds with placeholder config",
    async () => {
      const result = await exec(["bun", "run", "deploy", "--dry-run"], {
        cwd: root,
        env: cleanEnv,
      });
      assert(result.code === 0, result.out.slice(-1500));
      assert(/DRY RUN complete/.test(result.out), result.out.slice(-800));
      assert(
        /placeholders for/.test(result.out),
        "placeholders were not reported",
      );
      return "config, build, images, and synth passed with no AWS call";
    },
  );

  await steps.run(
    "deploy fails clearly when a required production value is missing",
    async () => {
      const result = await exec(
        ["bun", "run", "deploy", "--dry-run", "--skip-assets"],
        {
          cwd: root,
          env: {
            ...cleanEnv,
            SUPPORT_STAGE_CONFIG: JSON.stringify({
              account: "123456789012",
              cognitoIssuer:
                "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_X",
              adminClientId: "a",
              mcpClientId: "m",
            }),
          },
        },
      );
      assert(
        result.code === 2,
        `exit ${result.code}: ${result.out.slice(-600)}`,
      );
      for (const key of [
        "mcpRequiredGroup is required",
        "certificateArn is required",
        "triageAgentId is required",
      ]) {
        assert(result.out.includes(key), `message lacks "${key}"`);
      }
      return "exit 2 naming mcpRequiredGroup, certificateArn, and triageAgentId";
    },
  );

  await steps.run("the Compose stack is up and migrated", async () => {
    const up = await exec(["bun", "scripts/stack.ts", "up"], { cwd: root });
    assert(up.code === 0, up.out.slice(-800));
    const migrated = await exec(["bun", "run", "db:migrate"], { cwd: root });
    assert(migrated.code === 0, migrated.out.slice(-800));
  });

  await steps.run(
    "start a dedicated LocalStack with the Docker socket",
    async () => {
      const started = await exec([
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        LS_CONTAINER,
        "-p",
        `127.0.0.1:${LS_PORT}:4566`,
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-e",
        "SERVICES=s3,sqs,secretsmanager,cloudformation,lambda,iam,sns,logs,sts,cloudwatch,events",
        "-e",
        "LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT=120",
        "localstack/localstack:3",
      ]);
      assert(started.code === 0, started.out);
      await waitFor(
        async () => (await fetch(`${LS_URL}/_localstack/health`)).ok,
        "LocalStack health",
        90_000,
      );
      return LS_URL;
    },
  );

  await steps.run(
    "deploy the S3, SQS, and Secrets Manager subset of the stack",
    async () => {
      const synth = await exec(["bun", "run", "synth"], { cwd: root });
      assert(synth.code === 0, synth.out.slice(-800));
      const subset = buildSubset(readTemplate("PwSupport"));
      const wanted = [
        "AttachmentsBucket",
        "TriageWakeQueue",
        "LinearAdapterQueue",
        "TriageWakeDlq",
        "LinearAdapterDlq",
        "DatabaseCluster",
      ];
      for (const fragment of wanted.slice(0, 5)) {
        assert(
          subset.kept.some((id) => id.includes(fragment)),
          `subset lacks ${fragment}: kept ${subset.kept.join(", ")}`,
        );
      }
      const ids = (fragment: string, type: string) =>
        Object.entries(subset.template.Resources).find(
          ([id, r]) => r.Type === type && id.includes(fragment),
        )?.[0] as string;
      const template = withOutputs(subset.template, {
        AttachmentsBucket: ids("AttachmentsBucket", "AWS::S3::Bucket"),
        TriageWakeQueueUrl: ids("QueuesTriageWakeQueue", "AWS::SQS::Queue"),
        LinearAdapterQueueUrl: ids(
          "QueuesLinearAdapterQueue",
          "AWS::SQS::Queue",
        ),
        DbSecret: ids("Secret", "AWS::SecretsManager::Secret"),
      });
      await cfn.send(
        new CreateStackCommand({
          StackName: "pw-support-subset",
          TemplateBody: JSON.stringify(template),
        }),
      );
      await waitStack("pw-support-subset", "CREATE_COMPLETE");
      state.outputs = await outputsOf("pw-support-subset");
      return `${subset.kept.length} resources deployed, ${subset.dropped.length} need real AWS (RDS, ECS, ELB, CloudFront, IAM, VPC)`;
    },
  );

  await steps.run(
    "queues carry redrive, retention, and the shared visibility timeouts",
    async () => {
      const attrs = async (url: string) =>
        (
          await sqs.send(
            new GetQueueAttributesCommand({
              QueueUrl: url,
              AttributeNames: ["All"],
            }),
          )
        ).Attributes ?? {};
      const wake = await attrs(state.outputs.TriageWakeQueueUrl as string);
      const adapter = await attrs(
        state.outputs.LinearAdapterQueueUrl as string,
      );
      for (const queue of [wake, adapter]) {
        const redrive = JSON.parse(queue.RedrivePolicy ?? "{}");
        assert(redrive.maxReceiveCount === 5, `redrive ${queue.RedrivePolicy}`);
        assert(
          String(redrive.deadLetterTargetArn).includes("-dlq"),
          "redrive target is not a DLQ",
        );
      }
      assert(
        Number(wake.VisibilityTimeout) ===
          TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
        "wake visibility",
      );
      assert(
        Number(adapter.VisibilityTimeout) ===
          LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
        "adapter visibility",
      );
      await s3.send(
        new HeadBucketCommand({
          Bucket: state.outputs.AttachmentsBucket as string,
        }),
      );
      return "wake and adapter queues redrive to DLQs after 5 receives; bucket exists";
    },
  );

  await steps.run(
    "the deployed DB secret hydrates the Lambda database environment",
    async () => {
      const env: Record<string, string | undefined> = {
        DB_SECRET_ARN: state.outputs.DbSecret,
      };
      await hydrateDatabaseEnv(env, async (id) => {
        const value = await secrets.send(
          new GetSecretValueCommand({ SecretId: id }),
        );
        return value.SecretString;
      });
      assert(env.DB_USER && env.DB_PASSWORD, "credentials were not copied");
      return `user ${env.DB_USER}, password length ${env.DB_PASSWORD?.length}`;
    },
  );

  await steps.run(
    "deploy the linear-outbound Lambda step into LocalStack Lambda (T15)",
    async () => {
      try {
        const bundle = join(work, "lambda");
        mkdirSync(bundle);
        const built = await exec(
          [
            "bun",
            "build",
            "pipelines/linear-outbound/lambda-entries/production.ts",
            "--target",
            "node",
            "--format",
            "esm",
            "--outfile",
            join(bundle, "index.mjs"),
          ],
          { cwd: root },
        );
        assert(built.code === 0, built.out);
        const zipped = await exec([
          "zip",
          "-j",
          join(bundle, "index.zip"),
          join(bundle, "index.mjs"),
        ]);
        assert(zipped.code === 0, zipped.out);
        await s3.send(
          new CreateBucketCommand({ Bucket: "pw-support-lambda-code" }),
        );
        await s3.send(
          new PutObjectCommand({
            Bucket: "pw-support-lambda-code",
            Key: "index.zip",
            Body: readFileSync(join(bundle, "index.zip")),
          }),
        );
        const queueUrl = state.outputs.LinearAdapterQueueUrl as string;
        const attributes = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: queueUrl,
            AttributeNames: ["QueueArn"],
          }),
        );
        const appTemplate = readTemplate("PwSupportApp");
        const fn = Object.values(appTemplate.Resources).find(
          (resource) =>
            resource.Type === "AWS::Lambda::Function" &&
            resource.Properties?.PackageType === "Image",
        )?.Properties as { Timeout: number; MemorySize: number } | undefined;
        const mapping = Object.values(appTemplate.Resources).find(
          (resource) => resource.Type === "AWS::Lambda::EventSourceMapping",
        )?.Properties as
          | { BatchSize: number; ScalingConfig: { MaximumConcurrency: number } }
          | undefined;
        assert(fn && mapping, "the app template has no Lambda step");
        const template = withLambdaStep(
          { Resources: {} },
          {
            codeBucket: "pw-support-lambda-code",
            codeKey: "index.zip",
            role: "arn:aws:iam::000000000000:role/local-lambda",
            timeout: fn.Timeout,
            memorySize: fn.MemorySize,
            batchSize: mapping.BatchSize,
            maxConcurrency: mapping.ScalingConfig.MaximumConcurrency,
            eventSourceArn: attributes.Attributes?.QueueArn,
            runtime: "nodejs20.x",
            environment: {
              DATABASE_URL: `postgres://support:support@host.docker.internal:${POSTGRES_HOST_PORT}/support`,
              AWS_ENDPOINT_URL: LS_FROM_DOCKER,
              LINEAR_API_URL: `http://host.docker.internal:${STUB_PORT}/graphql`,
              LINEAR_API_KEY: "local-rehearsal",
              ATTACHMENTS_BUCKET: state.outputs.AttachmentsBucket as string,
              AWS_ACCESS_KEY_ID: "test",
              AWS_SECRET_ACCESS_KEY: "test",
            },
          },
        );
        await cfn.send(
          new CreateStackCommand({
            StackName: "pw-support-lambda",
            TemplateBody: JSON.stringify(template),
          }),
        );
        await waitStack("pw-support-lambda", "CREATE_COMPLETE");
        await waitFor(
          async () => {
            const result = await lambda.send(
              new GetFunctionCommand({
                FunctionName: "pw-support-linear-outbound",
              }),
            );
            return result.Configuration?.State === "Active";
          },
          "Lambda Active",
          180_000,
        );
        const mappings = await lambda.send(
          new ListEventSourceMappingsCommand({
            FunctionName: "pw-support-linear-outbound",
          }),
        );
        const found = mappings.EventSourceMappings?.[0];
        assert(found, "no event source mapping");
        assert(
          found.FunctionResponseTypes?.includes("ReportBatchItemFailures"),
          "ReportBatchItemFailures missing",
        );
        state.lambdaOk = true;
        state.lambdaDetail = `function Active, mapping ${found.State}, batch ${found.BatchSize}`;
        return state.lambdaDetail;
      } catch (error) {
        state.lambdaDetail =
          error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
  );

  await steps.run(
    "seed a project that routes to the Linear stub team",
    async () => {
      const db = createDb();
      const { key } = await ensureProject(db, {
        clientSlug: "acme",
        projectSlug: `deploy-${SUFFIX}`,
        name: "acme deploy rehearsal",
      });
      await setProjectLinearTeam(db, {
        clientSlug: "acme",
        projectSlug: `deploy-${SUFFIX}`,
        linearTeamId: teamId,
      });
      await closeDb(db);
      state.projectKey = key;
    },
  );

  const workerCommand = state.lambdaOk
    ? "pipelines/support-triage/fargate-entries/production.ts"
    : "pipelines/support-triage/fargate-entries/main.ts";

  await steps.run(
    "smoke: API, worker, deployed queues, and Linear stub produce a ticket",
    async () => {
      processes.push(
        startProcess("api", ["bun", "apps/server/src/server.ts"], {
          cwd: root,
          env: localEnv(),
        }),
        startProcess("worker", ["bun", workerCommand], {
          cwd: root,
          env: localEnv(),
        }),
      );
      await waitForHttp(`http://127.0.0.1:${API_PORT}/health`);
      const wakeUrl = (
        await sqs.send(
          new GetQueueUrlCommand({ QueueName: RESOURCE_NAMES.triageWakeQueue }),
        )
      ).QueueUrl;
      assert(
        wakeUrl === state.outputs.TriageWakeQueueUrl,
        "the API resolves a different wake queue than the deployed one",
      );
      const detail = await submitSmoke(`http://127.0.0.1:${API_PORT}`);
      return `${detail}; adapter path ${state.lambdaOk ? "LocalStack Lambda" : "in-process poller (Lambda step failed)"}`;
    },
  );

  await steps.run(
    "the production image builds with a non-root user and no dev dependencies",
    async () => {
      await buildImage("api", API_IMAGE);
      await buildImage("worker", WORKER_IMAGE);
      const inspect = await exec([
        "docker",
        "image",
        "inspect",
        API_IMAGE,
        "--format",
        "{{.Config.User}}|{{json .Config.Env}}",
      ]);
      const [user, env] = inspect.out.trim().split("|");
      assert(user === "bun", `user is ${user}`);
      assert(
        String(env).includes("NODE_ENV=production"),
        "NODE_ENV is not production",
      );
      const dev = await exec([
        "docker",
        "run",
        "--rm",
        API_IMAGE,
        "sh",
        "-c",
        "test ! -d node_modules/@playwright && test ! -d node_modules/@biomejs && echo clean",
      ]);
      assert(dev.out.includes("clean"), `dev dependencies present: ${dev.out}`);
      const size = await exec([
        "docker",
        "image",
        "inspect",
        API_IMAGE,
        "--format",
        "{{.Size}}",
      ]);
      return `user bun, NODE_ENV=production, no @playwright or @biomejs, ${(Number(size.out) / 1e6).toFixed(0)} MB`;
    },
  );

  await steps.run(
    "the API container answers /health and passes the extraction self-test",
    async () => {
      containers.push(`pw-support-api-${SUFFIX}`);
      const started = await exec([
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        `pw-support-api-${SUFFIX}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-p",
        `127.0.0.1:${CONTAINER_API_PORT}:8787`,
        "-e",
        "NODE_ENV=development",
        "-e",
        `DATABASE_URL=postgres://support:support@host.docker.internal:${POSTGRES_HOST_PORT}/support`,
        "-e",
        `AWS_ENDPOINT_URL=${LS_FROM_DOCKER}`,
        "-e",
        "AWS_ACCESS_KEY_ID=test",
        "-e",
        "AWS_SECRET_ACCESS_KEY=test",
        "-e",
        `ATTACHMENTS_BUCKET=${state.outputs.AttachmentsBucket}`,
        API_IMAGE,
      ]);
      assert(started.code === 0, started.out);
      await waitForHttp(
        `http://127.0.0.1:${CONTAINER_API_PORT}/health`,
        undefined,
        60_000,
      );
      const body = await (
        await fetch(`http://127.0.0.1:${CONTAINER_API_PORT}/health`)
      ).json();
      assert(
        (body as { status?: string }).status === "ok",
        JSON.stringify(body),
      );
      const logs = await exec(["docker", "logs", `pw-support-api-${SUFFIX}`]);
      assert(
        logs.out.includes("[api] extraction self-test passed"),
        `no self-test line:\n${logs.out.slice(-600)}`,
      );
      return "/health ok, self-test line present";
    },
  );

  await steps.run(
    "the worker container processes one job to a stub ticket",
    async () => {
      for (const proc of processes) await proc.stop();
      processes.length = 0;
      const entry = state.lambdaOk
        ? ["bun", "pipelines/support-triage/fargate-entries/production.ts"]
        : ["bun", "pipelines/support-triage/fargate-entries/main.ts"];
      containers.push(`pw-support-worker-${SUFFIX}`);
      const started = await exec([
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        `pw-support-worker-${SUFFIX}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "-e",
        "NODE_ENV=development",
        "-e",
        `DATABASE_URL=postgres://support:support@host.docker.internal:${POSTGRES_HOST_PORT}/support`,
        "-e",
        `AWS_ENDPOINT_URL=${LS_FROM_DOCKER}`,
        "-e",
        "AWS_ACCESS_KEY_ID=test",
        "-e",
        "AWS_SECRET_ACCESS_KEY=test",
        "-e",
        `ATTACHMENTS_BUCKET=${state.outputs.AttachmentsBucket}`,
        "-e",
        `LINEAR_API_URL=http://host.docker.internal:${STUB_PORT}/graphql`,
        "-e",
        "LINEAR_API_KEY=local-rehearsal",
        "-e",
        "TRIAGE_INITIAL_DELAY_SECONDS=1",
        "-e",
        "TRIAGE_SWEEP_INTERVAL_SECONDS=2",
        WORKER_IMAGE,
        ...entry,
      ]);
      assert(started.code === 0, started.out);
      await waitFor(
        async () =>
          (
            await exec(["docker", "logs", `pw-support-worker-${SUFFIX}`])
          ).out.includes("[worker] extraction self-test passed"),
        "worker self-test line",
        60_000,
      );
      const detail = await submitSmoke(
        `http://127.0.0.1:${CONTAINER_API_PORT}`,
      );
      const logs = await exec([
        "docker",
        "logs",
        `pw-support-worker-${SUFFIX}`,
      ]);
      assert(/\[worker\] started/.test(logs.out), "worker did not log a start");
      return `${detail}; worker container logged self-test and start`;
    },
  );
} finally {
  for (const proc of processes) await proc.stop();
  for (const name of containers) await exec(["docker", "rm", "-f", name]);
  await exec(["docker", "rmi", "-f", API_IMAGE, WORKER_IMAGE]);
  await stub.stop();
  rmSync(work, { recursive: true, force: true });
}

console.log(
  `\nLocalStack Lambda (T15): ${state.lambdaOk ? "worked" : "did not work"}: ${state.lambdaDetail.slice(0, 400)}`,
);
process.exit(steps.summarize());
