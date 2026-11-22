import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCE_NAMES } from "@pw-support/contracts";
import {
  CfnOutput,
  DockerBuildSecret,
  RemovalPolicy,
  type StackProps,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as ecs from "aws-cdk-lib/aws-ecs";
import type * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { AWS_REGION, type StageConfig } from "./config";
import { DB_NAME, SupportDatabase } from "./database";
import { LOG_RETENTION, SupportNetwork } from "./network";
import { SupportQueues } from "./queues";
import { SecretsAccess } from "./secrets-access";
import { RegionalStack } from "./stack-base";

export { AWS_REGION };
export const SECRETS_PREFIX = RESOURCE_NAMES.secretsPrefix;
export const ANTHROPIC_SECRET_NAME = "pw-support-anthropic/api-key";

export const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
export const BUILD_SECRET_PATH = ".deploy/github_token";

export function imageAssetOptions(target: string) {
  return {
    file: "Dockerfile",
    target,
    platform: ecr_assets.Platform.LINUX_AMD64,
    buildSecrets: {
      github_token: DockerBuildSecret.fromSrc(BUILD_SECRET_PATH),
    },
  };
}

export const MIGRATE_COMMAND = ["bun", "scripts/db-migrate.ts"];

export interface SupportStackProps extends StackProps {
  config: StageConfig;
}

export class SupportStack extends RegionalStack {
  readonly config: StageConfig;
  readonly network: SupportNetwork;
  readonly database: SupportDatabase;
  readonly attachmentsBucket: s3.Bucket;
  readonly queues: SupportQueues;
  readonly secretsAccess: SecretsAccess;
  readonly anthropicSecret: secretsmanager.Secret;
  readonly cluster: ecs.Cluster;
  readonly apiImage: ecr_assets.DockerImageAsset;
  readonly migrationTask: ecs.FargateTaskDefinition;

  constructor(scope: Construct, id: string, props: SupportStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.config.account, region: AWS_REGION },
      terminationProtection: props.config.stage === "production",
    });
    this.config = props.config;

    this.network = new SupportNetwork(this, "Network");
    this.database = new SupportDatabase(this, "Database", {
      network: this.network,
    });

    this.attachmentsBucket = new s3.Bucket(this, "AttachmentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.queues = new SupportQueues(this, "Queues", {
      alarmEmail: props.config.alarmEmail,
    });

    this.anthropicSecret = new secretsmanager.Secret(this, "AnthropicKey", {
      secretName: ANTHROPIC_SECRET_NAME,
      description:
        "Anthropic API key for the triage worker. Set it with put-secret-value after the first deploy.",
    });

    this.secretsAccess = new SecretsAccess(this, "SecretsAccess", {
      prefix: SECRETS_PREFIX,
    });

    this.cluster = new ecs.Cluster(this, "Cluster", {
      vpc: this.network.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    this.apiImage = new ecr_assets.DockerImageAsset(this, "AppImage", {
      directory: REPO_ROOT,
      ...imageAssetOptions("api"),
    });

    this.migrationTask = new ecs.FargateTaskDefinition(this, "MigrationTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    this.migrationTask.addContainer("migrate", {
      image: ecs.ContainerImage.fromDockerImageAsset(this.apiImage),
      command: MIGRATE_COMMAND,
      readonlyRootFilesystem: false,
      environment: { NODE_ENV: "production", DB_NAME },
      secrets: databaseSecrets(this.database),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "migrate",
        logGroup: new logs.LogGroup(this, "MigrationLogs", {
          retention: LOG_RETENTION,
          removalPolicy: RemovalPolicy.RETAIN,
        }),
      }),
    });
    this.database.secret.grantRead(this.migrationTask.taskRole);

    new CfnOutput(this, "ClusterName", { value: this.cluster.clusterName });
    new CfnOutput(this, "MigrationTaskDefinitionArn", {
      value: this.migrationTask.taskDefinitionArn,
    });
    new CfnOutput(this, "ServiceSubnets", {
      value: this.network.vpc
        .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
        .subnetIds.join(","),
    });
    new CfnOutput(this, "ServiceSecurityGroupId", {
      value: this.network.serviceSecurityGroup.securityGroupId,
    });
    new CfnOutput(this, "AttachmentsBucketName", {
      value: this.attachmentsBucket.bucketName,
    });
  }
}

export function databaseSecrets(
  database: SupportDatabase,
): Record<string, ecs.Secret> {
  return {
    DB_HOST: ecs.Secret.fromSecretsManager(database.secret, "host"),
    DB_PORT: ecs.Secret.fromSecretsManager(database.secret, "port"),
    DB_USER: ecs.Secret.fromSecretsManager(database.secret, "username"),
    DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, "password"),
  };
}

export function grantServiceRole(
  role: iam.IRole,
  stack: SupportStack,
  access: "api" | "worker",
): void {
  stack.database.secret.grantRead(role);
  if (access === "api") {
    stack.attachmentsBucket.grantRead(role);
    stack.attachmentsBucket.grantPut(role);
    stack.queues.triageWakeQueue.grantSendMessages(role);
    role.addManagedPolicy(stack.secretsAccess.writePolicy);
  } else {
    stack.attachmentsBucket.grantRead(role);
    stack.queues.triageWakeQueue.grantConsumeMessages(role);
    stack.queues.triageWakeQueue.grantSendMessages(role);
    stack.queues.linearAdapterQueue.grantSendMessages(role);
    role.addManagedPolicy(stack.secretsAccess.readPolicy);
  }
}
