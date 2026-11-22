import { describe, expect, test } from "bun:test";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  TRIAGE_DEFAULTS,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  API_PORT,
  LAMBDA_BATCH_SIZE,
  LAMBDA_TIMEOUT_SECONDS,
  WORKER_COMMAND,
  WORKER_MEMORY_MIB,
} from "./app-stack";
import { loadStageConfig } from "./load-config";
import { createSupportStacks, stackIds } from "./stacks";
import {
  ANTHROPIC_SECRET_NAME,
  AWS_REGION,
  MIGRATE_COMMAND,
  SECRETS_PREFIX,
} from "./support-stack";

function build(
  stage: "production" | "staging" = "production",
  values: Record<string, unknown> = {},
) {
  const config = loadStageConfig({
    stage,
    placeholders: true,
    readContext: (key) => values[key],
    env: {},
  });
  const stacks = createSupportStacks(new App(), config);
  return {
    ...stacks,
    config,
    foundationT: Template.fromStack(stacks.foundation),
    appT: Template.fromStack(stacks.app),
    oidcT: Template.fromStack(stacks.oidc),
  };
}

const prod = build();
const { foundationT, appT, oidcT } = prod;

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource?: unknown;
  Condition?: unknown;
};

function statements(template: Template): Statement[] {
  return Object.values(template.findResources("AWS::IAM::Policy"))
    .concat(Object.values(template.findResources("AWS::IAM::ManagedPolicy")))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}

const asList = (value: string | string[]) =>
  Array.isArray(value) ? value : [value];

function containerEnv(template: Template, containerName: string) {
  const defs = Object.values(
    template.findResources("AWS::ECS::TaskDefinition"),
  ).flatMap((task) => task.Properties.ContainerDefinitions);
  const container = defs.find(
    (def: { Name: string }) => def.Name === containerName,
  );
  expect(container, containerName).toBeDefined();
  return container as {
    Environment: { Name: string; Value: unknown }[];
    Secrets: { Name: string; ValueFrom: unknown }[];
    Command?: string[];
    Memory?: number;
  };
}

const envOf = (container: ReturnType<typeof containerEnv>) =>
  Object.fromEntries(container.Environment.map((e) => [e.Name, e.Value]));

describe("foundation stack", () => {
  test("deploys to a dedicated account in us-east-1 with termination protection", () => {
    expect(prod.foundation.region).toBe("us-east-1");
    expect(AWS_REGION).toBe("us-east-1");
    expect(prod.foundation.terminationProtection).toBe(true);
    expect(prod.app.terminationProtection).toBe(true);
    expect(build("staging").foundation.terminationProtection).toBe(false);
  });

  test("names stacks per stage", () => {
    expect(stackIds("production").foundation).toBe("PwSupport");
    expect(stackIds("staging").app).toBe("PwSupportStagingApp");
  });

  test("keeps the database private, encrypted, backed up, and protected", () => {
    foundationT.hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      StorageEncrypted: true,
      DeletionProtection: true,
      BackupRetentionPeriod: 14,
      EnableIAMDatabaseAuthentication: true,
      EnableCloudwatchLogsExports: ["postgresql"],
      ServerlessV2ScalingConfiguration: Match.objectLike({ MinCapacity: 0.5 }),
    });
    const instances = foundationT.findResources("AWS::RDS::DBInstance");
    expect(Object.keys(instances).length).toBe(2);
    for (const instance of Object.values(instances)) {
      expect(instance.Properties.PubliclyAccessible).toBe(false);
      expect(instance.Properties.DBInstanceClass).toBe("db.serverless");
    }
    expect(
      Object.values(foundationT.findResources("AWS::RDS::DBCluster"))[0]
        ?.DeletionPolicy,
    ).toBe("Retain");
  });

  test("puts the database in isolated subnets and takes the password from Secrets Manager", () => {
    const cluster = JSON.stringify(
      Object.values(foundationT.findResources("AWS::RDS::DBCluster"))[0]
        ?.Properties,
    );
    expect(cluster).toContain("{{resolve:secretsmanager:");
    const group = JSON.stringify(
      Object.values(foundationT.findResources("AWS::RDS::DBSubnetGroup"))[0]
        ?.Properties.SubnetIds,
    );
    expect(group).toContain("dataSubnet1");
    expect(group).toContain("dataSubnet2");
    expect(group).not.toMatch(/publicSubnet|appSubnet/);
    const subnets = foundationT.findResources("AWS::EC2::Subnet");
    const dataSubnets = Object.values(subnets).filter((subnet) =>
      JSON.stringify(subnet.Properties.Tags).includes('"data"'),
    );
    expect(dataSubnets.length).toBe(2);
    for (const subnet of dataSubnets) {
      expect(subnet.Properties.MapPublicIpOnLaunch).not.toBe(true);
    }
    foundationT.hasResourceProperties("AWS::SecretsManager::RotationSchedule", {
      RotationRules: { ScheduleExpression: "rate(30 days)" },
    });
    foundationT.hasResourceProperties("AWS::Serverless::Application", {
      Parameters: Match.objectLike({ vpcSubnetIds: Match.anyValue() }),
    });
  });

  test("never opens a security group to the internet", () => {
    for (const template of [foundationT]) {
      const groups = template.findResources("AWS::EC2::SecurityGroup");
      for (const group of Object.values(groups)) {
        for (const rule of group.Properties.SecurityGroupIngress ?? []) {
          expect(rule.CidrIp).not.toBe("0.0.0.0/0");
        }
      }
    }
  });

  test("allows Postgres only from named security groups", () => {
    const ingress = Object.values(
      appT.findResources("AWS::EC2::SecurityGroupIngress"),
    ).filter((rule) => rule.Properties.FromPort === 5432);
    expect(ingress.length).toBe(3);
    for (const rule of ingress) {
      expect(rule.Properties.SourceSecurityGroupId).toBeDefined();
      expect(rule.Properties.CidrIp).toBeUndefined();
    }
  });

  test("creates private buckets that require TLS", () => {
    for (const template of [foundationT, appT]) {
      const buckets = template.findResources("AWS::S3::Bucket");
      expect(Object.keys(buckets).length).toBeGreaterThan(0);
      for (const bucket of Object.values(buckets)) {
        expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
        expect(
          bucket.Properties.BucketEncryption.ServerSideEncryptionConfiguration,
        ).toBeDefined();
      }
      template.hasResourceProperties("AWS::S3::BucketPolicy", {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: "Deny",
              Condition: { Bool: { "aws:SecureTransport": "false" } },
            }),
          ]),
        },
      });
    }
    expect(
      Object.keys(foundationT.findResources("AWS::S3::Bucket")),
    ).toHaveLength(1);
  });

  test("retains the attachments bucket and versions it", () => {
    const bucket = Object.values(
      foundationT.findResources("AWS::S3::Bucket"),
    )[0];
    expect(bucket?.DeletionPolicy).toBe("Retain");
    expect(bucket?.Properties.VersioningConfiguration).toEqual({
      Status: "Enabled",
    });
  });

  test("runs the migration as a one-off task with the database secrets", () => {
    const migrate = containerEnv(foundationT, "migrate");
    expect(migrate.Command).toEqual(MIGRATE_COMMAND);
    expect(envOf(migrate).NODE_ENV).toBe("production");
    expect(migrate.Secrets.map((secret) => secret.Name).sort()).toEqual([
      "DB_HOST",
      "DB_PASSWORD",
      "DB_PORT",
      "DB_USER",
    ]);
    expect(foundationT.findResources("AWS::ECS::Service")).toEqual({});
    foundationT.hasOutput("MigrationTaskDefinitionArn", Match.anyValue());
    foundationT.hasOutput("ClusterName", Match.anyValue());
    foundationT.hasOutput("ServiceSubnets", Match.anyValue());
    foundationT.hasOutput("ServiceSecurityGroupId", Match.anyValue());
  });
});

describe("queues", () => {
  const queues = foundationT.findResources("AWS::SQS::Queue");
  const byName = (name: string) =>
    Object.values(queues).find((queue) => queue.Properties.QueueName === name);

  test("creates four queues, each main queue redriving to its DLQ after five receives", () => {
    expect(Object.keys(queues)).toHaveLength(4);
    for (const name of [
      "pw-support-triage-wake",
      "pw-support-adapter-linear",
    ]) {
      const queue = byName(name);
      expect(queue?.Properties.RedrivePolicy.maxReceiveCount).toBe(5);
      expect(queue?.Properties.RedrivePolicy.deadLetterTargetArn).toBeDefined();
      expect(byName(`${name}-dlq`)).toBeDefined();
      expect(queue?.Properties.SqsManagedSseEnabled).toBe(true);
    }
  });

  test("holds failed messages for 14 days in the DLQs", () => {
    for (const name of [
      "pw-support-triage-wake-dlq",
      "pw-support-adapter-linear-dlq",
    ]) {
      expect(byName(name)?.Properties.MessageRetentionPeriod).toBe(14 * 86400);
      expect(byName(name)?.Properties.RedrivePolicy).toBeUndefined();
    }
  });

  test("sets explicit visibility timeouts from the shared constants", () => {
    expect(byName("pw-support-triage-wake")?.Properties.VisibilityTimeout).toBe(
      TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
    );
    expect(
      byName("pw-support-adapter-linear")?.Properties.VisibilityTimeout,
    ).toBe(LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS);
    expect(TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS).toBeGreaterThan(
      TRIAGE_DEFAULTS.leaseSeconds,
    );
  });

  test("denies plain HTTP on every queue", () => {
    foundationT.resourceCountIs("AWS::SQS::QueuePolicy", 4);
  });

  test("alarms on a DLQ message and on the oldest message age, all to one topic", () => {
    const alarms = Object.values(
      foundationT.findResources("AWS::CloudWatch::Alarm"),
    );
    const metrics = alarms.map((alarm) => alarm.Properties.MetricName).sort();
    expect(metrics).toEqual([
      "ApproximateAgeOfOldestMessage",
      "ApproximateAgeOfOldestMessage",
      "ApproximateNumberOfMessagesVisible",
      "ApproximateNumberOfMessagesVisible",
    ]);
    for (const alarm of alarms) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
    }
    foundationT.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateNumberOfMessagesVisible",
      Threshold: 0,
      ComparisonOperator: "GreaterThanThreshold",
    });
    foundationT.hasResourceProperties("AWS::CloudWatch::Alarm", {
      MetricName: "ApproximateAgeOfOldestMessage",
      Threshold: 900,
    });
    foundationT.resourceCountIs("AWS::SNS::Topic", 1);
  });

  test("subscribes an alarm email only when configured", () => {
    foundationT.resourceCountIs("AWS::SNS::Subscription", 0);
    const withEmail = Template.fromStack(
      build("production", { alarmEmail: "ops@example.com" }).foundation,
    );
    withEmail.hasResourceProperties("AWS::SNS::Subscription", {
      Protocol: "email",
      Endpoint: "ops@example.com",
    });
  });
});

describe("API service", () => {
  const api = containerEnv(appT, "web");
  const env = envOf(api);

  test("runs in production mode behind an HTTPS load balancer with a /health check", () => {
    expect(env.NODE_ENV).toBe("production");
    expect(env.API_PORT).toBe(String(API_PORT));
    appT.hasResourceProperties("AWS::ElasticLoadBalancingV2::TargetGroup", {
      HealthCheckPath: "/health",
    });
    appT.hasResourceProperties("AWS::ECS::Service", {
      LoadBalancers: [Match.objectLike({ ContainerPort: API_PORT })],
    });
    appT.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Protocol: "HTTPS",
      Port: 443,
      SslPolicy: Match.anyValue(),
    });
    appT.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
      Protocol: "HTTP",
      DefaultActions: [
        Match.objectLike({
          Type: "redirect",
          RedirectConfig: Match.anyValue(),
        }),
      ],
    });
    appT.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
      Scheme: "internet-facing",
      LoadBalancerAttributes: Match.arrayWith([
        { Key: "access_logs.s3.enabled", Value: "true" },
        {
          Key: "routing.http.drop_invalid_header_fields.enabled",
          Value: "true",
        },
      ]),
    });
  });

  test("requires the MCP group and wires the Cognito settings", () => {
    expect(env.MCP_REQUIRED_GROUP).toBe(prod.config.mcpRequiredGroup);
    expect(env.MCP_REQUIRED_GROUP).not.toBe("");
    expect(env.COGNITO_ISSUER).toBe(prod.config.cognitoIssuer);
    expect(env.COGNITO_AUDIENCE).toBe(prod.config.adminClientId);
    expect(env.MCP_AUDIENCE).toBe(prod.config.mcpClientId);
    expect(JSON.stringify(env.ADMIN_ORIGINS)).toContain("https://");
  });

  test("sets no local override and no secret value", () => {
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(
        /LINEAR_API_URL|AWS_ENDPOINT_URL|KEY|TOKEN|PASSWORD/,
      );
    }
    expect(api.Secrets.map((secret) => secret.Name).sort()).toEqual([
      "DB_HOST",
      "DB_PASSWORD",
      "DB_PORT",
      "DB_USER",
    ]);
    for (const secret of api.Secrets) {
      expect(JSON.stringify(secret.ValueFrom)).toContain("Ref");
    }
  });

  test("runs in private subnets with rolling deploys and a circuit breaker", () => {
    appT.hasResourceProperties("AWS::ECS::Service", {
      LaunchType: "FARGATE",
      DesiredCount: 2,
      DeploymentConfiguration: Match.objectLike({
        MinimumHealthyPercent: 100,
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "DISABLED" }),
      },
    });
    appT.hasResourceProperties("AWS::ApplicationAutoScaling::ScalableTarget", {
      MinCapacity: 2,
      MaxCapacity: 4,
    });
  });

  test("keeps log groups with retention", () => {
    const groups = Object.values(appT.findResources("AWS::Logs::LogGroup"));
    expect(groups.length).toBeGreaterThanOrEqual(3);
    for (const group of groups) {
      expect(group.Properties.RetentionInDays).toBe(30);
    }
  });

  test("serves plain HTTP only outside production", () => {
    const staging = build("staging");
    const listeners = Object.values(
      Template.fromStack(staging.app).findResources(
        "AWS::ElasticLoadBalancingV2::Listener",
      ),
    );
    expect(listeners.map((l) => l.Properties.Protocol)).toEqual(["HTTP"]);
    expect(staging.config.certificateArn).toBeUndefined();
  });
});

describe("worker service", () => {
  const worker = containerEnv(appT, "worker");

  test("runs the production entry on Fargate with an extraction-sized memory limit", () => {
    expect(worker.Command).toEqual(WORKER_COMMAND);
    expect(worker.Memory).toBe(WORKER_MEMORY_MIB);
    expect(envOf(worker).NODE_ENV).toBe("production");
    expect(envOf(worker).BUN_JSC_forceRAMSize).toBeDefined();
    expect(Number(envOf(worker).BUN_JSC_forceRAMSize)).toBeLessThan(
      WORKER_MEMORY_MIB * 1024 * 1024,
    );
    expect(envOf(worker).TRIAGE_AGENT_ID).toBe(prod.config.triageAgentId);
    appT.hasResourceProperties("AWS::ECS::TaskDefinition", {
      Cpu: "1024",
      Memory: String(WORKER_MEMORY_MIB),
      RequiresCompatibilities: ["FARGATE"],
    });
    expect(worker.Secrets.map((secret) => secret.Name).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DB_HOST",
      "DB_PASSWORD",
      "DB_PORT",
      "DB_USER",
    ]);
    foundationT.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: ANTHROPIC_SECRET_NAME,
    });
  });

  test("keeps managed-agent work on Fargate: the only Lambda is the Linear step", () => {
    const functions = Object.values(
      appT.findResources("AWS::Lambda::Function"),
    );
    const own = functions.filter((fn) => fn.Properties.PackageType === "Image");
    expect(own).toHaveLength(1);
    expect(JSON.stringify(own[0]?.Properties.Environment)).not.toMatch(
      /ANTHROPIC|TRIAGE/,
    );
  });
});

describe("linear-outbound Lambda", () => {
  const fn = Object.values(appT.findResources("AWS::Lambda::Function")).find(
    (candidate) => candidate.Properties.PackageType === "Image",
  );

  test("is an image function in the private subnets with the pipeline timeout", () => {
    expect(fn?.Properties.Timeout).toBe(LAMBDA_TIMEOUT_SECONDS);
    expect(fn?.Properties.Architectures).toEqual(["x86_64"]);
    expect(fn?.Properties.VpcConfig.SubnetIds.length).toBe(2);
    expect(fn?.Properties.Environment.Variables.NODE_ENV).toBe("production");
    expect(fn?.Properties.Environment.Variables.DB_SECRET_ARN).toBeDefined();
    expect(JSON.stringify(fn?.Properties.Environment)).not.toContain(
      "DB_PASSWORD",
    );
  });

  test("keeps the queue visibility timeout at six times the function timeout or more", () => {
    expect(LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(
      LAMBDA_TIMEOUT_SECONDS * 6,
    );
  });

  test("consumes the adapter queue with partial batch responses", () => {
    appT.hasResourceProperties("AWS::Lambda::EventSourceMapping", {
      BatchSize: LAMBDA_BATCH_SIZE,
      FunctionResponseTypes: ["ReportBatchItemFailures"],
      ScalingConfig: { MaximumConcurrency: 5 },
      EventSourceArn: Match.anyValue(),
    });
    appT.resourceCountIs("AWS::Lambda::EventSourceMapping", 1);
  });

  test("alarms on function errors, API health, 5xx responses, and a stopped worker", () => {
    const metrics = Object.values(appT.findResources("AWS::CloudWatch::Alarm"))
      .map((alarm) => alarm.Properties.MetricName)
      .sort();
    expect(metrics).toEqual([
      "Errors",
      "HTTPCode_Target_5XX_Count",
      "HealthyHostCount",
      "RunningTaskCount",
    ]);
  });
});

describe("IAM scope", () => {
  const WILDCARD_ALLOWED = [
    "ecr:GetAuthorizationToken",
    "ec2:CreateNetworkInterface",
    "ec2:DescribeNetworkInterfaces",
    "ec2:DeleteNetworkInterface",
    "ec2:AssignPrivateIpAddresses",
    "ec2:UnassignPrivateIpAddresses",
    "cloudfront:GetInvalidation",
    "cloudfront:CreateInvalidation",
    "logs:PutRetentionPolicy",
    "logs:DeleteRetentionPolicy",
  ];

  test("gives wildcard resources only to actions that AWS does not scope", () => {
    for (const template of [foundationT, appT, oidcT]) {
      for (const statement of statements(template)) {
        if (statement.Resource === "*") {
          for (const action of asList(statement.Action)) {
            expect(WILDCARD_ALLOWED).toContain(action);
          }
        }
      }
    }
  });

  test("never grants a service wildcard action", () => {
    for (const template of [foundationT, appT, oidcT]) {
      for (const statement of statements(template)) {
        for (const action of asList(statement.Action)) {
          expect(action).not.toMatch(/^\w+:\*$/);
          expect(action).not.toBe("*");
        }
      }
    }
  });

  test("scopes the API role to the attachments bucket, the wake queue, and the secrets prefix", () => {
    const api = Object.values(appT.findResources("AWS::IAM::Policy")).find(
      (policy) => JSON.stringify(policy).includes("ApiTaskRole"),
    );
    const actions = asList(
      api?.Properties.PolicyDocument.Statement.flatMap((s: Statement) =>
        asList(s.Action),
      ),
    );
    expect(actions).toContain("sqs:SendMessage");
    expect(actions).not.toContain("sqs:ReceiveMessage");
    expect(
      actions.some(
        (action) => action === "s3:PutObject" || action.startsWith("s3:Abort"),
      ),
    ).toBe(true);
    const api_role = Object.values(appT.findResources("AWS::IAM::Role")).find(
      (role) =>
        JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes(
          "ecs-tasks",
        ) &&
        JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes(
          "WritePolicy",
        ),
    );
    expect(api_role).toBeDefined();
  });

  test("gives the worker read access to secrets and consume access to the wake queue only", () => {
    const worker = Object.values(appT.findResources("AWS::IAM::Role")).find(
      (role) =>
        JSON.stringify(role.Properties.ManagedPolicyArns ?? []).includes(
          "ReadPolicy",
        ) &&
        JSON.stringify(role.Properties.AssumeRolePolicyDocument).includes(
          "ecs-tasks",
        ),
    );
    expect(worker).toBeDefined();
    const policy = Object.values(appT.findResources("AWS::IAM::Policy")).find(
      (candidate) => JSON.stringify(candidate).includes("WorkerTaskRole"),
    );
    const actions = policy?.Properties.PolicyDocument.Statement.flatMap(
      (s: Statement) => asList(s.Action),
    );
    expect(actions).toContain("sqs:ReceiveMessage");
    expect(actions).toContain("sqs:SendMessage");
  });

  test("scopes both secrets policies to the prefix", () => {
    foundationT.resourceCountIs("AWS::IAM::ManagedPolicy", 2);
    for (const statement of statements(foundationT).filter((s) =>
      JSON.stringify(s.Resource).includes("secret:"),
    )) {
      expect(JSON.stringify(statement.Resource)).toContain(
        `:secret:${SECRETS_PREFIX}*`,
      );
    }
  });

  test("grants read on one secrets policy and write on the other", () => {
    const actions = Object.values(
      foundationT.findResources("AWS::IAM::ManagedPolicy"),
    ).map((policy) =>
      asList(policy.Properties.PolicyDocument.Statement[0].Action),
    );
    const read = actions.find(
      (list) => !list.includes("secretsmanager:CreateSecret"),
    );
    const write = actions.find((list) =>
      list.includes("secretsmanager:CreateSecret"),
    );
    expect(read).toContain("secretsmanager:GetSecretValue");
    expect(read).not.toContain("secretsmanager:PutSecretValue");
    expect(write).toContain("secretsmanager:PutSecretValue");
  });
});

describe("admin hosting", () => {
  test("serves the admin app from a private bucket through CloudFront with OAC", () => {
    appT.resourceCountIs("AWS::CloudFront::Distribution", 1);
    appT.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
      }),
    });
    appT.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
        }),
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponsePagePath: "/index.html" }),
          Match.objectLike({ ErrorCode: 404, ResponsePagePath: "/index.html" }),
        ]),
      }),
    });
    appT.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          FrameOptions: { FrameOption: "DENY", Override: true },
        }),
      }),
    });
  });

  test("deploys the built app with a runtime config and invalidates the cache", () => {
    appT.hasResourceProperties("Custom::CDKBucketDeployment", {
      Prune: true,
      DistributionPaths: ["/*"],
    });
    const outputs = Object.keys(appT.toJSON().Outputs);
    for (const name of ["AdminCallbackUrl", "AdminSignedOutUrl", "ApiUrl"]) {
      expect(
        outputs.some((output) => output.includes(name)),
        name,
      ).toBe(true);
    }
  });
});

describe("GitHub OIDC bootstrap stack", () => {
  const role = Object.values(oidcT.findResources("AWS::IAM::Role"))[0];
  const trust = role?.Properties.AssumeRolePolicyDocument.Statement[0];

  test("trusts one repository on main or the production environment", () => {
    expect(trust.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(trust.Condition.StringEquals).toEqual({
      "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    });
    expect(
      trust.Condition.StringLike["token.actions.githubusercontent.com:sub"],
    ).toEqual([
      "repo:pressw-llc/pw-customer-support:ref:refs/heads/main",
      "repo:pressw-llc/pw-customer-support:environment:production",
    ]);
    oidcT.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
  });

  test("limits permissions to CDK bootstrap roles and the migration task", () => {
    const allowed = statements(oidcT)
      .flatMap((s) => asList(s.Action))
      .sort();
    expect(allowed).toEqual([
      "cloudformation:DescribeStacks",
      "ecs:DescribeTasks",
      "ecs:RunTask",
      "iam:PassRole",
      "sts:AssumeRole",
    ]);
    const assume = statements(oidcT).find((s) => s.Action === "sts:AssumeRole");
    expect(JSON.stringify(assume?.Resource)).toContain(
      "cdk-hnb659fds-deploy-role",
    );
    expect(JSON.stringify(assume?.Resource)).not.toContain('"*"');
    const pass = statements(oidcT).find((s) => s.Action === "iam:PassRole");
    expect(pass?.Condition).toEqual({
      StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
    });
    expect(role?.Properties.MaxSessionDuration).toBe(3600);
  });
});

describe("stage rules", () => {
  test("the production stage uses placeholders for every missing value in synth", () => {
    expect(prod.config.placeholders).toEqual(
      expect.arrayContaining(["account", "mcpRequiredGroup", "certificateArn"]),
    );
    expect(prod.config.account).toBe("000000000000");
  });

  test("rejects an empty MCP required group in production even when placeholders are on", () => {
    expect(() => build("production", { mcpRequiredGroup: "" })).toThrow(
      "mcpRequiredGroup must not be empty in production",
    );
  });

  test("rejects LINEAR_API_URL in production", () => {
    expect(() => build("production", { linearApiUrl: "http://stub" })).toThrow(
      "linearApiUrl cannot be set in production",
    );
  });

  test("adds extra admin origins to the API", () => {
    const stack = build("production", {
      extraAdminOrigins: "https://admin.example.com",
    });
    const container = containerEnv(Template.fromStack(stack.app), "web");
    expect(JSON.stringify(envOf(container).ADMIN_ORIGINS)).toContain(
      "https://admin.example.com",
    );
  });
});
