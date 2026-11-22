import { describe, expect, test } from "bun:test";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  resourceNames,
  TRIAGE_DEFAULTS,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  API_PORT,
  LAMBDA_BATCH_SIZE,
  LAMBDA_RDS_CA_PATH,
  LAMBDA_TIMEOUT_SECONDS,
  WORKER_COMMAND,
  WORKER_MEMORY_MIB,
} from "./app-stack";
import {
  BOUNDARY_ACTIONS,
  boundaryArn,
  executionStatements,
  TAG_ACTIONS,
} from "./execution-policy";
import { loadStageConfig } from "./load-config";
import { createSupportStacks, stackIds } from "./stacks";
import { AWS_REGION, MIGRATE_COMMAND, secretsPath } from "./support-stack";

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

const names = resourceNames("production");
const prod = build();
const { foundationT, appT, oidcT } = prod;

type Statement = {
  Sid?: string;
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

  test("only the load balancer security group is open to the internet, on 80 and 443 only", () => {
    const groups = Object.entries(
      appT.findResources("AWS::EC2::SecurityGroup"),
    );
    const open = groups.filter(([, group]) =>
      (group.Properties.SecurityGroupIngress ?? []).some(
        (rule: { CidrIp?: string }) => rule.CidrIp === "0.0.0.0/0",
      ),
    );
    expect(open.map(([id]) => id).join()).toContain("LBSecurityGroup");
    expect(open).toHaveLength(1);
    const rules = (open[0]?.[1].Properties.SecurityGroupIngress ?? []) as {
      FromPort: number;
    }[];
    const ports = rules.map((rule) => rule.FromPort);
    expect(ports.sort((a, b) => a - b)).toEqual([80, 443]);
    for (const instance of Object.values(
      foundationT.findResources("AWS::RDS::DBInstance"),
    )) {
      expect(instance.Properties.PubliclyAccessible).toBe(false);
    }
    for (const service of Object.values(
      appT.findResources("AWS::ECS::Service"),
    )) {
      expect(
        service.Properties.NetworkConfiguration.AwsvpcConfiguration
          .AssignPublicIp,
      ).toBe("DISABLED");
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

  test("runs the migration as a one-off task that reads the database secret by ARN", () => {
    const migrate = containerEnv(foundationT, "migrate");
    expect(migrate.Command).toEqual(MIGRATE_COMMAND);
    expect(envOf(migrate).NODE_ENV).toBe("production");
    expect(envOf(migrate).DB_SECRET_ARN).toBeDefined();
    expect(migrate.Secrets ?? []).toEqual([]);
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
    for (const name of [names.triageWakeQueue, names.linearAdapterQueue]) {
      const queue = byName(name);
      expect(queue?.Properties.RedrivePolicy.maxReceiveCount).toBe(5);
      expect(queue?.Properties.RedrivePolicy.deadLetterTargetArn).toBeDefined();
      expect(byName(`${name}-dlq`)).toBeDefined();
      expect(queue?.Properties.SqsManagedSseEnabled).toBe(true);
    }
  });

  test("holds failed messages for 14 days in the DLQs", () => {
    for (const name of [names.triageWakeDlq, names.linearAdapterDlq]) {
      expect(byName(name)?.Properties.MessageRetentionPeriod).toBe(14 * 86400);
      expect(byName(name)?.Properties.RedrivePolicy).toBeUndefined();
    }
  });

  test("sets explicit visibility timeouts from the shared constants", () => {
    expect(byName(names.triageWakeQueue)?.Properties.VisibilityTimeout).toBe(
      TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
    );
    expect(byName(names.linearAdapterQueue)?.Properties.VisibilityTimeout).toBe(
      LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
    );
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
    expect(env.ADMIN_REQUIRED_GROUP).toBe(prod.config.adminRequiredGroup);
    expect(env.ADMIN_REQUIRED_GROUP).not.toBe("");
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
    expect(api.Secrets ?? []).toEqual([]);
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
    expect(worker.Secrets.map((secret) => secret.Name)).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
    foundationT.hasResourceProperties("AWS::SecretsManager::Secret", {
      Name: resourceNames("production").anthropicSecret,
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

describe("database credentials", () => {
  const consumers = () => {
    const functions = Object.values(
      appT.findResources("AWS::Lambda::Function"),
    ).filter((fn) => fn.Properties.PackageType === "Image");
    return [
      envOf(containerEnv(foundationT, "migrate")),
      envOf(containerEnv(appT, "web")),
      envOf(containerEnv(appT, "worker")),
      Object.fromEntries(
        Object.entries(functions[0]?.Properties.Environment.Variables),
      ),
    ];
  };

  test("no task definition or function receives the password as an environment value or secret", () => {
    for (const template of [foundationT, appT]) {
      const text = JSON.stringify(
        Object.values(
          template.toJSON().Resources as Record<string, { Type: string }>,
        ).filter(
          (resource) =>
            !["AWS::RDS::DBCluster", "AWS::SecretsManager::Secret"].includes(
              resource.Type,
            ),
        ),
      );
      expect(text).not.toContain("DB_PASSWORD");
      expect(text).not.toContain(":password::");
      for (const task of Object.values(
        template.findResources("AWS::ECS::TaskDefinition"),
      )) {
        for (const container of task.Properties.ContainerDefinitions) {
          for (const secret of container.Secrets ?? []) {
            expect(JSON.stringify(secret.ValueFrom)).not.toContain(
              "Secret5E91",
            );
            expect(secret.Name).toBe("ANTHROPIC_API_KEY");
          }
        }
      }
    }
  });

  test("the migration task, API, worker, and Lambda all receive the secret ARN and the verified-TLS settings", () => {
    for (const env of consumers()) {
      expect(env.DB_SECRET_ARN).toBeDefined();
      expect(env.DB_HOST).toBeDefined();
      expect(env.DB_USER).toBe("support");
      expect(env.DATABASE_URL).toBeUndefined();
    }
    expect(consumers()[3]?.RDS_CA_BUNDLE_PATH).toBe(LAMBDA_RDS_CA_PATH);
  });

  test("each role reads exactly the database secret and no wildcard secret", () => {
    for (const [template, rolePart] of [
      [foundationT, "MigrationTask"],
      [appT, "ApiTaskRole"],
      [appT, "WorkerTaskRole"],
      [appT, "LinearOutbound"],
    ] as const) {
      const policies = Object.values(
        template.findResources("AWS::IAM::Policy"),
      ).filter((policy) => JSON.stringify(policy).includes(rolePart));
      const reads = policies.flatMap((policy) =>
        policy.Properties.PolicyDocument.Statement.filter(
          (statement: Statement) =>
            asList(statement.Action).includes("secretsmanager:GetSecretValue"),
        ),
      );
      const dbReads = reads.filter((statement: Statement) =>
        JSON.stringify(statement.Resource).includes("DatabaseClusterSecret"),
      );
      expect(dbReads.length, rolePart).toBeGreaterThan(0);
      for (const statement of dbReads) {
        expect(asList(statement.Action).sort()).toEqual([
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetSecretValue",
        ]);
        expect(statement.Resource).not.toBe("*");
      }
    }
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
    for (const template of [foundationT, appT]) {
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
    for (const template of [foundationT, appT]) {
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
        `:secret:${secretsPath(resourceNames("production"))}*`,
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
  const SUBJECT_KEY = "token.actions.githubusercontent.com:sub";
  const REPO = "pressw-llc/pw-customer-support";
  const stagingStack = build("staging");

  const role = (template: Template) =>
    Object.values(template.findResources("AWS::IAM::Role")).find((candidate) =>
      JSON.stringify(candidate.Properties.AssumeRolePolicyDocument).includes(
        "AssumeRoleWithWebIdentity",
      ),
    );
  const deployStatements = (template: Template): Statement[] =>
    Object.values(template.findResources("AWS::IAM::Policy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );
  const executionStatementsOf = (template: Template): Statement[] =>
    Object.values(template.findResources("AWS::IAM::ManagedPolicy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );

  test("each role trusts exactly its own GitHub environment subject and nothing else", () => {
    for (const [template, stage] of [
      [oidcT, "production"],
      [stagingStack.oidcT, "staging"],
    ] as const) {
      const trust =
        role(template)?.Properties.AssumeRolePolicyDocument.Statement[0];
      expect(trust.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(trust.Condition.StringEquals).toEqual({
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        [SUBJECT_KEY]: `repo:${REPO}:environment:${stage}`,
      });
      expect(trust.Condition.StringLike).toBeUndefined();
      expect(JSON.stringify(trust)).not.toContain("refs/heads");
    }
  });

  test("every stage creates the GitHub OIDC provider in its own account", () => {
    oidcT.hasResourceProperties("AWS::IAM::OIDCProvider", {
      Url: "https://token.actions.githubusercontent.com",
      ClientIdList: ["sts.amazonaws.com"],
    });
    stagingStack.oidcT.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  });

  test("the staging role cannot assume any production bootstrap role, and the reverse", () => {
    const productionQualifier = resourceNames("production").bootstrapQualifier;
    const stagingQualifier = resourceNames("staging").bootstrapQualifier;
    const assumed = (template: Template) =>
      deployStatements(template)
        .filter((s) => asList(s.Action).includes("sts:AssumeRole"))
        .flatMap((s) => asList(s.Resource as string | string[]))
        .map((resource) => JSON.stringify(resource));
    const staging = assumed(stagingStack.oidcT);
    expect(staging.length).toBe(4);
    for (const resource of staging) {
      expect(resource).toContain(`cdk-${stagingQualifier}-`);
      expect(resource).not.toContain(productionQualifier);
      expect(resource).not.toContain("cdk-*");
      expect(resource).not.toContain('"*"');
    }
    for (const resource of assumed(oidcT)) {
      expect(resource).toContain(`cdk-${productionQualifier}-`);
      expect(resource).not.toContain(stagingQualifier);
    }
  });

  test("the deploy role touches only its own stacks, migration task, task roles, and bootstrap version", () => {
    for (const [template, stage] of [
      [oidcT, "production"],
      [stagingStack.oidcT, "staging"],
    ] as const) {
      const actions = deployStatements(template)
        .flatMap((s) => asList(s.Action))
        .sort();
      expect(actions).toEqual([
        "cloudformation:DescribeStacks",
        "ecs:DescribeTasks",
        "ecs:RunTask",
        "iam:PassRole",
        "ssm:GetParameter",
        "sts:AssumeRole",
      ]);
      const text = JSON.stringify(deployStatements(template));
      if (stage === "production") expect(text).not.toContain("Staging");
      else expect(text).toContain("PwSupportStaging");
      expect(text).not.toContain(`"*"`);
      const pass = deployStatements(template).find((s) =>
        asList(s.Action).includes("iam:PassRole"),
      );
      expect(pass?.Condition).toEqual({
        StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
      });
      expect(role(template)?.Properties.MaxSessionDuration).toBe(3600);
    }
  });

  test("the stacks synthesize with their own bootstrap qualifier", () => {
    for (const [stack, stage] of [
      [prod, "production"],
      [stagingStack, "staging"],
    ] as const) {
      const qualifier = resourceNames(stage).bootstrapQualifier;
      for (const template of [stack.foundationT, stack.appT]) {
        const text = JSON.stringify(template.toJSON());
        expect(text).toContain(`/cdk-bootstrap/${qualifier}/version`);
        expect(text).not.toContain("hnb659fds");
      }
      const assets = JSON.stringify(
        stack.foundation.node.root.node.children
          .filter((child) => "synthesizer" in child)
          .map(() => qualifier),
      );
      expect(assets).toContain(qualifier);
    }
    expect(resourceNames("production").bootstrapQualifier).not.toBe(
      resourceNames("staging").bootstrapQualifier,
    );
  });

  test("the execution policy has no wildcard action, no AdministratorAccess, and no unconditioned creation", () => {
    for (const template of [oidcT, stagingStack.oidcT]) {
      const policies = Object.values(
        template.findResources("AWS::IAM::ManagedPolicy"),
      );
      expect(policies.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(template.toJSON())).not.toContain(
        "AdministratorAccess",
      );
      const all = executionStatementsOf(template);
      for (const statement of all) {
        for (const action of asList(statement.Action)) {
          expect(action).not.toBe("*");
          expect(action).not.toBe("*:*");
          expect(action).not.toMatch(/^(iam|sts|organizations|kms):\*$/);
        }
        expect(statement.Resource).not.toBe("*:*");
      }
      const wildcardResource = all.filter((s) => s.Resource === "*");
      for (const statement of wildcardResource) {
        const actions = asList(statement.Action);
        const readOnly = actions.every((action) =>
          /:(Describe|List|Get)/.test(action),
        );
        expect(
          readOnly ||
            statement.Condition !== undefined ||
            isJustified(statement),
        ).toBe(true);
      }
    }
  });

  test("the execution policy is split under the managed policy size limit", () => {
    for (const template of [oidcT, stagingStack.oidcT]) {
      expect(
        Object.keys(template.findResources("AWS::IAM::ManagedPolicy")).length,
      ).toBeLessThanOrEqual(10);
      for (const policy of Object.values(
        template.findResources("AWS::IAM::ManagedPolicy"),
      )) {
        expect(
          JSON.stringify(policy.Properties.PolicyDocument).replace(/\s/g, "")
            .length,
        ).toBeLessThan(6144);
      }
    }
  });

  test("the execution policy scopes stage resources by name or tag and states why the rest cannot be", () => {
    for (const stage of ["production", "staging"] as const) {
      const statements = executionStatements({
        stage,
        account: "000000000000",
      });
      const text = JSON.stringify(statements);
      const other =
        stage === "production" ? "pw-support-staging" : "pw-support-production";
      expect(text).not.toContain(other);
      const tagKey = `aws:ResourceTag/${resourceNames(stage).stageTag}`;
      expect(text).toContain(tagKey);
      expect(text).toContain(`aws:RequestTag/${resourceNames(stage).stageTag}`);
      const unscoped = statements.filter(
        (s) => s.resources.includes("*") && s.effect !== "Deny",
      );
      expect(unscoped.length).toBeGreaterThan(0);
      for (const statement of unscoped) {
        const readOnly = statement.actions.every((action) =>
          /:(Describe|List|Get)/.test(action),
        );
        expect(
          readOnly ||
            statement.conditions !== undefined ||
            statement.unscopedBecause,
          statement.sid,
        ).toBeTruthy();
        if (statement.unscopedBecause) {
          expect(statement.unscopedBecause.endsWith(".")).toBe(true);
        }
      }
    }
  });

  test("PassRole is limited to stage roles and to the services that take them", () => {
    for (const stage of ["production", "staging"] as const) {
      const pass = executionStatements({
        stage,
        account: "000000000000",
      }).filter((s) => s.actions.includes("iam:PassRole"));
      expect(pass).toHaveLength(1);
      expect(pass[0]?.conditions).toEqual({
        StringEquals: {
          "iam:PassedToService": [
            "ecs-tasks.amazonaws.com",
            "lambda.amazonaws.com",
            "vpc-flow-logs.amazonaws.com",
          ],
        },
      });
      for (const resource of pass[0]?.resources ?? []) {
        expect(resource).not.toMatch(/role\/\*$/);
        expect(resource).toContain(
          stage === "production" ? "role/PwSupport" : "role/PwSupportStaging",
        );
      }
    }
  });

  test("asset and image reads name only the stage's own bootstrap qualifier", () => {
    for (const stage of ["production", "staging"] as const) {
      const other = resourceNames(
        stage === "production" ? "staging" : "production",
      );
      const own = resourceNames(stage);
      const text = JSON.stringify(
        executionStatements({ stage, account: "000000000000" }).filter((s) =>
          [
            "OwnAssetObjects",
            "OwnContainerImages",
            "BootstrapVersion",
          ].includes(s.sid),
        ),
      );
      expect(text).toContain(`cdk-${own.bootstrapQualifier}-assets-`);
      expect(text).toContain(`cdk-${own.bootstrapQualifier}-container-assets-`);
      expect(text).not.toContain(other.bootstrapQualifier);
    }
  });

  test("the execution policies carry the stage in their names", () => {
    const names = Object.values(
      stagingStack.oidcT.findResources("AWS::IAM::ManagedPolicy"),
    ).map((policy) => policy.Properties.ManagedPolicyName as string);
    for (const name of names) expect(name).toContain("pw-support-staging-");
    stagingStack.oidcT.hasOutput(
      "CloudFormationExecutionPolicies",
      Match.anyValue(),
    );
    stagingStack.oidcT.hasOutput("BootstrapQualifier", {
      Value: resourceNames("staging").bootstrapQualifier,
    });
  });
});

describe("data protection per stage", () => {
  const STATEFUL = [
    "AWS::RDS::DBCluster",
    "AWS::S3::Bucket",
    "AWS::Logs::LogGroup",
    "AWS::SecretsManager::Secret",
  ];
  const policies = (template: Template, type: string) =>
    Object.values(
      template.toJSON().Resources as Record<
        string,
        { Type: string; DeletionPolicy?: string }
      >,
    )
      .filter((resource) => resource.Type === type)
      .map((resource) => resource.DeletionPolicy);

  test("production retains every stateful resource and protects the database", () => {
    for (const template of [foundationT, appT]) {
      for (const type of STATEFUL) {
        for (const policy of policies(template, type)) {
          expect(policy, type).toBe("Retain");
        }
      }
    }
    foundationT.hasResourceProperties("AWS::RDS::DBCluster", {
      DeletionProtection: true,
      StorageEncrypted: true,
      BackupRetentionPeriod: 14,
    });
  });

  test("staging deletes its stateful resources so it can be torn down and re-created", () => {
    const staging = build("staging");
    let checked = 0;
    for (const template of [staging.foundationT, staging.appT]) {
      for (const type of STATEFUL) {
        for (const policy of policies(template, type)) {
          expect(policy, type).toBe("Delete");
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
    staging.foundationT.hasResourceProperties("AWS::RDS::DBCluster", {
      DeletionProtection: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 14,
    });
  });

  test("every bucket in both stages stays private, encrypted, and TLS-only", () => {
    for (const stack of [prod, build("staging")]) {
      for (const template of [stack.foundationT, stack.appT]) {
        for (const bucket of Object.values(
          template.findResources("AWS::S3::Bucket"),
        )) {
          expect(
            bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,
          ).toBe(true);
          expect(bucket.Properties.BucketEncryption).toBeDefined();
        }
      }
    }
  });
});

describe("stage tag", () => {
  const TAGGED_TYPES = [
    "AWS::EC2::VPC",
    "AWS::EC2::Subnet",
    "AWS::EC2::SecurityGroup",
    "AWS::EC2::NatGateway",
    "AWS::SQS::Queue",
    "AWS::RDS::DBCluster",
    "AWS::S3::Bucket",
    "AWS::ECS::Cluster",
    "AWS::ECS::Service",
    "AWS::ECS::TaskDefinition",
    "AWS::ElasticLoadBalancingV2::LoadBalancer",
    "AWS::ElasticLoadBalancingV2::TargetGroup",
    "AWS::Lambda::Function",
    "AWS::SecretsManager::Secret",
    "AWS::IAM::Role",
    "AWS::CloudFront::Distribution",
    "AWS::Logs::LogGroup",
    "AWS::SNS::Topic",
  ];

  function tagged(
    resource: { Properties?: Record<string, unknown> },
    stage: string,
  ) {
    const tags =
      resource.Properties?.Tags ?? resource.Properties?.TagSpecifications;
    const list = Array.isArray(tags)
      ? tags
      : Object.entries((tags ?? {}) as Record<string, string>).map(
          ([Key, Value]) => ({ Key, Value }),
        );
    return list.some(
      (tag: { Key?: string; Value?: unknown }) =>
        tag.Key === "pw-support:stage" && tag.Value === stage,
    );
  }

  test("every taggable resource in all three stacks carries the stage tag", () => {
    for (const stage of ["production", "staging"] as const) {
      const stack = build(stage);
      const seen = new Set<string>();
      for (const template of [stack.foundationT, stack.appT, stack.oidcT]) {
        const resources = template.toJSON().Resources as Record<
          string,
          { Type: string; Properties?: Record<string, unknown> }
        >;
        for (const [id, resource] of Object.entries(resources)) {
          const supportsTags =
            resource.Properties && "Tags" in resource.Properties;
          if (supportsTags || TAGGED_TYPES.includes(resource.Type)) {
            if (resource.Type === "AWS::ECS::TaskDefinition" && !supportsTags)
              continue;
            expect(
              tagged(resource, stage),
              `${stage} ${resource.Type} ${id}`,
            ).toBe(true);
            seen.add(resource.Type);
          }
        }
      }
      for (const type of [
        "AWS::EC2::VPC",
        "AWS::SQS::Queue",
        "AWS::RDS::DBCluster",
        "AWS::S3::Bucket",
        "AWS::ECS::Cluster",
        "AWS::Lambda::Function",
        "AWS::SecretsManager::Secret",
        "AWS::IAM::Role",
        "AWS::CloudFront::Distribution",
        "AWS::ElasticLoadBalancingV2::LoadBalancer",
      ]) {
        expect(seen.has(type), `${stage} ${type}`).toBe(true);
      }
    }
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

  test("passes the admin email domains to the API only when configured", () => {
    expect(
      envOf(containerEnv(appT, "web")).ADMIN_ALLOWED_EMAIL_DOMAINS,
    ).toBeUndefined();
    const stack = build("production", {
      adminAllowedEmailDomains: "pressw.com",
    });
    expect(
      envOf(containerEnv(Template.fromStack(stack.app), "web"))
        .ADMIN_ALLOWED_EMAIL_DOMAINS,
    ).toBe("pressw.com");
  });

  test("rejects an empty admin group in production", () => {
    expect(() => build("production", { adminRequiredGroup: "" })).toThrow(
      "adminRequiredGroup must not be empty in production",
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

describe("stage-specific physical names", () => {
  const NAME_KEYS = /(Name|Names)$/;
  const SKIP = new Set([
    "TagKey",
    "DBName",
    "Key",
    "ParameterName",
    "StreamPrefix",
  ]);

  function collect(template: Template, found: Map<string, string[]>) {
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;
    for (const [id, resource] of Object.entries(resources)) {
      for (const [key, value] of Object.entries(resource.Properties ?? {})) {
        if (
          typeof value === "string" &&
          NAME_KEYS.test(key) &&
          !SKIP.has(key)
        ) {
          const owner = `${resource.Type}:${id}`;
          found.set(value, [...(found.get(value) ?? []), owner]);
        }
      }
    }
  }

  function physicalNames(stack: ReturnType<typeof build>) {
    const found = new Map<string, string[]>();
    for (const template of [stack.foundationT, stack.appT, stack.oidcT]) {
      collect(template, found);
    }
    return found;
  }

  const staging = build("staging");
  const production = build("production");

  test("production and staging in one account share no explicit physical name", () => {
    const a = physicalNames(production);
    const b = physicalNames(staging);
    const shared = [...a.keys()].filter(
      (name) => b.has(name) && !/^[A-Za-z0-9-]*\/?(true|false)$/.test(name),
    );
    const owned = shared.filter((name) =>
      [...(a.get(name) ?? []), ...(b.get(name) ?? [])].some((owner) =>
        /SQS::Queue|SecretsManager::Secret|IAM::Role|S3::Bucket|ECS::Cluster|Lambda::Function|ECS::Service|Logs::LogGroup/.test(
          owner,
        ),
      ),
    );
    expect(owned).toEqual([]);
  });

  test("the explicit names cover queues, secrets, and the deploy role per stage", () => {
    for (const [stack, stage] of [
      [production, "production"],
      [staging, "staging"],
    ] as const) {
      const expected = resourceNames(stage);
      const found = physicalNames(stack);
      for (const name of [
        expected.triageWakeQueue,
        expected.triageWakeDlq,
        expected.linearAdapterQueue,
        expected.linearAdapterDlq,
        expected.databaseSecret,
        expected.anthropicSecret,
        expected.githubDeployRole,
      ]) {
        expect(found.has(name), name).toBe(true);
      }
    }
    expect(resourceNames("production").triageWakeQueue).not.toBe(
      resourceNames("staging").triageWakeQueue,
    );
  });

  test("the local stage keeps today's names", () => {
    const local = resourceNames("local");
    expect(local.triageWakeQueue).toBe("pw-support-triage-wake");
    expect(local.linearAdapterDlq).toBe("pw-support-adapter-linear-dlq");
    expect(local.attachmentsBucket).toBe("pw-support-attachments");
    expect(local.secretsScope).toBe("global");
  });

  test("API, worker, migration, and Lambda carry the stage and the same stage names", () => {
    for (const [stack, stage] of [
      [production, "production"],
      [staging, "staging"],
    ] as const) {
      const expected = resourceNames(stage);
      const envs = [
        envOf(containerEnv(stack.foundationT, "migrate")),
        envOf(containerEnv(stack.appT, "web")),
        envOf(containerEnv(stack.appT, "worker")),
        Object.fromEntries(
          Object.entries(
            Object.values(
              stack.appT.findResources("AWS::Lambda::Function"),
            ).find((fn) => fn.Properties.PackageType === "Image")?.Properties
              .Environment.Variables,
          ),
        ),
      ];
      for (const env of envs) {
        expect(env.SUPPORT_STAGE).toBe(stage);
        expect(env.SECRETS_SCOPE).toBe(expected.secretsScope);
      }
      for (const env of [envs[1], envs[2]]) {
        expect(env?.TRIAGE_WAKE_QUEUE).toBe(expected.triageWakeQueue);
      }
      const queues = stack.foundationT.findResources("AWS::SQS::Queue");
      const queueNames = Object.values(queues).map(
        (queue) => queue.Properties.QueueName,
      );
      expect(queueNames).toContain(envs[1]?.TRIAGE_WAKE_QUEUE as string);
    }
  });

  test("the secrets policies are scoped to the stage's secrets path", () => {
    const text = JSON.stringify(
      Object.values(
        staging.foundationT.findResources("AWS::IAM::ManagedPolicy"),
      ),
    );
    expect(text).toContain(":secret:pw-support/staging/*");
    expect(text).not.toContain(":secret:pw-support/production/");
  });

  test("every stage creates the GitHub OIDC provider in its own account", () => {
    production.oidcT.resourceCountIs("AWS::IAM::OIDCProvider", 1);
    staging.oidcT.resourceCountIs("AWS::IAM::OIDCProvider", 1);
  });
});

function isJustified(statement: Statement): boolean {
  return statement.Sid !== undefined;
}

describe("role permissions boundary", () => {
  const stagingStack = build("staging");

  test("every role the stacks create carries the stage boundary", () => {
    for (const [stack, stage] of [
      [prod, "production"],
      [stagingStack, "staging"],
    ] as const) {
      const name = resourceNames(stage).permissionsBoundary;
      let roles = 0;
      for (const template of [stack.foundationT, stack.appT]) {
        for (const role of Object.values(
          template.findResources("AWS::IAM::Role"),
        )) {
          roles += 1;
          expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
            `policy/${name}`,
          );
        }
      }
      expect(roles).toBeGreaterThan(8);
    }
  });

  test("the boundary admits only the services the stacks use and no IAM or STS", () => {
    const policy = Object.values(
      oidcT.findResources("AWS::IAM::ManagedPolicy"),
    ).find(
      (candidate) =>
        candidate.Properties.ManagedPolicyName ===
        resourceNames("production").permissionsBoundary,
    );
    const actions = policy?.Properties.PolicyDocument.Statement.flatMap(
      (statement: Statement) => asList(statement.Action),
    );
    expect(actions).toEqual(BOUNDARY_ACTIONS);
    for (const action of actions) {
      expect(action).not.toMatch(/^(iam|sts|organizations|account|kms):/);
    }
  });

  test("the execution role creates roles only with the stage boundary and cannot change it", () => {
    for (const stage of ["production", "staging"] as const) {
      const statements = executionStatements({
        stage,
        account: "000000000000",
      });
      const arn = boundaryArn(stage, "000000000000");
      const allowed = statements.filter((s) => s.effect !== "Deny");
      for (const statement of allowed) {
        for (const action of statement.actions) {
          expect(action).not.toBe("iam:UpdateAssumeRolePolicy");
          expect(action).not.toBe("iam:DeleteRolePermissionsBoundary");
        }
        if (
          statement.actions.some((a) =>
            ["iam:CreateRole", "iam:PutRolePermissionsBoundary"].includes(a),
          )
        ) {
          expect(statement.conditions).toEqual({
            StringEquals: { "iam:PermissionsBoundary": arn },
          });
        }
      }
      const sids = statements
        .filter((s) => s.effect === "Deny")
        .map((s) => s.sid);
      expect(sids).toEqual(
        expect.arrayContaining([
          "DenyUnboundedRoles",
          "DenyBoundaryRemoval",
          "DenyBoundaryPolicyChanges",
        ]),
      );
      const unbounded = statements.find((s) => s.sid === "DenyUnboundedRoles");
      expect(unbounded?.conditions).toEqual({
        StringNotEquals: { "iam:PermissionsBoundary": arn },
      });
      expect(
        statements.find((s) => s.sid === "DenyBoundaryPolicyChanges")
          ?.resources,
      ).toEqual([arn]);
    }
  });

  test("the rendered execution policy keeps the explicit denies", () => {
    const text = JSON.stringify(
      Object.values(oidcT.findResources("AWS::IAM::ManagedPolicy")).flatMap(
        (policy) => policy.Properties.PolicyDocument.Statement,
      ),
    );
    for (const sid of [
      "DenyUnboundedRoles",
      "DenyBoundaryRemoval",
      "DenyBoundaryPolicyChanges",
      "DenyStageTagChange",
      "DenyStageTagRemoval",
    ]) {
      expect(text, sid).toContain(`"Sid":"${sid}"`);
    }
    expect(text).toContain('"Effect":"Deny"');
  });
});

describe("stage tag conditions", () => {
  const stages = ["production", "staging"] as const;
  const hasKey = (condition: unknown, key: string) =>
    JSON.stringify(condition ?? {}).includes(key);

  test("every allowed tag action on a wildcard resource is tag-on-create or tag-existing, never open", () => {
    for (const stage of stages) {
      const tag = `aws:ResourceTag/${resourceNames(stage).stageTag}`;
      const request = `aws:RequestTag/${resourceNames(stage).stageTag}`;
      let audited = 0;
      for (const statement of executionStatements({
        stage,
        account: "000000000000",
      })) {
        if (statement.effect === "Deny") continue;
        const tagging = statement.actions.filter((a) =>
          TAG_ACTIONS.includes(a),
        );
        if (tagging.length === 0 || !statement.resources.includes("*"))
          continue;
        audited += 1;
        const conditions = statement.conditions as Record<
          string,
          Record<string, unknown>
        >;
        const onCreate =
          hasKey(conditions, "CreateAction") ||
          (hasKey(conditions, request) && conditions.Null?.[tag] === "true");
        const onExisting =
          conditions.StringEquals?.[tag] === stage &&
          JSON.stringify(
            conditions["ForAllValues:StringNotEquals"]?.["aws:TagKeys"],
          ) === JSON.stringify([resourceNames(stage).stageTag]);
        expect(onCreate || onExisting, `${stage} ${statement.sid}`).toBe(true);
      }
      expect(audited).toBeGreaterThanOrEqual(5);
    }
  });

  test("CloudFront tagging cannot retag an existing distribution into this stage", () => {
    for (const stage of stages) {
      const tag = `aws:ResourceTag/${resourceNames(stage).stageTag}`;
      const statements = executionStatements({
        stage,
        account: "000000000000",
      });
      const creating = statements.filter(
        (s) =>
          s.effect !== "Deny" &&
          s.actions.includes("cloudfront:TagResource") &&
          s.sid === "DistributionTagOnCreate",
      );
      expect(creating).toHaveLength(1);
      expect(
        (creating[0]?.conditions as { Null: Record<string, string> }).Null[tag],
      ).toBe("true");
      const creates = statements.find(
        (s) => s.sid === "DistributionsCreateTagged",
      );
      expect(creates?.actions).not.toContain("cloudfront:TagResource");
      const existing = statements.find(
        (s) => s.sid === "DistributionTagExisting",
      );
      expect(
        (existing?.conditions as { StringEquals: Record<string, string> })
          .StringEquals[tag],
      ).toBe(stage);
      const change = statements.find(
        (s) => s.sid === "DistributionsChangeTagged",
      );
      expect(change?.actions).not.toContain("cloudfront:UntagResource");
    }
  });

  test("EC2 and load balancer tagging follow the same split", () => {
    for (const stage of stages) {
      const statements = executionStatements({
        stage,
        account: "000000000000",
      });
      const sids = statements.map((s) => s.sid);
      for (const sid of [
        "NetworkTagOnCreate",
        "TagExistingNetworkResources",
        "LoadBalancerTagOnCreate",
        "LoadBalancerTagExisting",
      ]) {
        expect(sids).toContain(sid);
      }
      const network = statements.find((s) => s.sid === "NetworkChangeTagged");
      expect(network?.actions).not.toContain("ec2:DeleteTags");
      const balancer = statements.find(
        (s) => s.sid === "LoadBalancerChangeTagged",
      );
      expect(balancer?.actions).not.toContain("elasticloadbalancing:AddTags");
      expect(balancer?.actions).not.toContain(
        "elasticloadbalancing:RemoveTags",
      );
    }
  });

  test("the stage key cannot change or be removed after creation on any tagging action", () => {
    for (const stage of stages) {
      const key = resourceNames(stage).stageTag;
      const statements = executionStatements({
        stage,
        account: "000000000000",
      });
      const change = statements.find((s) => s.sid === "DenyStageTagChange");
      const removal = statements.find((s) => s.sid === "DenyStageTagRemoval");
      expect(change?.effect).toBe("Deny");
      expect(removal?.effect).toBe("Deny");
      for (const action of TAG_ACTIONS)
        expect(change?.actions).toContain(action);
      for (const action of [
        "ec2:DeleteTags",
        "elasticloadbalancing:RemoveTags",
        "cloudfront:UntagResource",
        "sqs:UntagQueue",
        "iam:UntagRole",
      ]) {
        expect(removal?.actions).toContain(action);
      }
      expect(JSON.stringify(change?.conditions)).toContain(key);
      expect(JSON.stringify(removal?.conditions)).toContain(key);
      expect(JSON.stringify(change?.conditions)).toContain('"Null"');
    }
  });
});
