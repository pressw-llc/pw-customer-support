import type { Stack } from "aws-cdk-lib";
import { NagSuppressions } from "cdk-nag";
import type { createSupportStacks } from "./stacks";

type Stacks = ReturnType<typeof createSupportStacks>;

const RULES = {
  s1: {
    id: "AwsSolutions-S1",
    reason:
      "Object access is audited by application events; add a log bucket if compliance asks.",
  },
  ecs2: {
    id: "AwsSolutions-ECS2",
    reason:
      "The inline variables hold names and ids, never secrets; credentials use ECS secrets.",
  },
  iam4Lambda: {
    id: "AwsSolutions-IAM4",
    reason:
      "AWS managed Lambda execution policies are the supported baseline for these functions.",
  },
  iam5Managed: {
    id: "AwsSolutions-IAM5",
    reason:
      "A construct managed by CDK or AWS needs its wildcard; the stack does not own the policy.",
  },
};

function suppress(
  stack: Stack,
  path: string,
  rules: { id: string; reason: string }[],
): void {
  NagSuppressions.addResourceSuppressionsByPath(
    stack,
    `/${stack.stackName}/${path}`,
    rules,
    true,
  );
}

function suppressProviders(
  stack: Stack,
  prefixes: string[],
  rules: { id: string; reason: string }[],
): void {
  for (const child of stack.node.children) {
    if (prefixes.some((prefix) => child.node.id.startsWith(prefix))) {
      NagSuppressions.addResourceSuppressions(child, rules, true);
    }
  }
}

export function applySuppressions(stacks: Stacks): void {
  const { foundation, app, oidc } = stacks;

  suppress(foundation, "AttachmentsBucket", [RULES.s1]);
  suppress(foundation, "MigrationTask", [RULES.ecs2, RULES.iam5Managed]);
  suppress(foundation, "SecretsAccess", [
    {
      id: "AwsSolutions-IAM5",
      reason:
        "Integration secrets are created at runtime under one prefix, so the ARN cannot be exact.",
    },
  ]);
  suppressProviders(
    foundation,
    ["LogRetention"],
    [
      {
        id: "AwsSolutions-IAM4",
        reason:
          "The CDK log retention provider uses the AWS managed execution policy.",
      },
      {
        id: "AwsSolutions-IAM5",
        reason:
          "The CDK log retention provider needs a wildcard to manage log groups.",
      },
      {
        id: "AwsSolutions-L1",
        reason:
          "The CDK log retention provider runtime is chosen by aws-cdk-lib.",
      },
    ],
  );

  suppress(app, "AlbLogs", [
    {
      id: "AwsSolutions-S1",
      reason:
        "This bucket is the log destination; a log bucket for it adds no signal.",
    },
  ]);
  suppress(app, "AdminSite/Bucket", [RULES.s1]);
  suppress(app, "AdminSite/Distribution", [
    {
      id: "AwsSolutions-CFR3",
      reason:
        "The private staff site relies on API audit events; CloudFront logs are off in V1.",
    },
    {
      id: "AwsSolutions-CFR4",
      reason:
        "The default CloudFront certificate fixes the minimum TLS version until a custom domain exists.",
    },
  ]);
  suppress(app, "Api/LB/SecurityGroup", [
    {
      id: "AwsSolutions-EC23",
      reason: "The intake endpoint is public by design and serves HTTPS only.",
    },
  ]);
  suppress(app, "Api/TaskDef", [RULES.ecs2, RULES.iam5Managed]);
  suppress(app, "WorkerTask", [RULES.ecs2, RULES.iam5Managed]);
  suppress(app, "ApiTaskRole", [
    {
      id: "AwsSolutions-IAM5",
      reason:
        "Attachment objects live under the bucket root, so object access needs the bucket wildcard.",
    },
  ]);
  suppress(app, "WorkerTaskRole", [
    {
      id: "AwsSolutions-IAM5",
      reason:
        "Attachment objects live under the bucket root, so object access needs the bucket wildcard.",
    },
  ]);
  suppress(app, "LinearOutbound/ServiceRole", [RULES.iam4Lambda]);
  suppressProviders(
    app,
    ["Custom::CDKBucketDeployment"],
    [
      {
        id: "AwsSolutions-L1",
        reason:
          "The BucketDeployment provider runtime is chosen by aws-cdk-lib.",
      },
      {
        id: "AwsSolutions-IAM4",
        reason:
          "The BucketDeployment provider uses the AWS managed execution policy.",
      },
      {
        id: "AwsSolutions-IAM5",
        reason:
          "The BucketDeployment provider copies arbitrary objects between two buckets.",
      },
    ],
  );

  suppress(oidc, "DeployRole/DefaultPolicy", [
    {
      id: "AwsSolutions-IAM5",
      reason:
        "Stack, task definition, and role names carry a generated suffix under the PwSupport prefix.",
    },
  ]);
}
