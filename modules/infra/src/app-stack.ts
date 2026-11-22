import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  RESOURCE_NAMES,
} from "@pw-support/contracts";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  type StackProps,
} from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecsPatterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";
import { AdminSite } from "./admin-site";
import { AWS_REGION, type StageConfig } from "./config";
import { DB_NAME } from "./database";
import { LOG_RETENTION } from "./network";
import { RegionalStack } from "./stack-base";
import {
  databaseSecrets,
  grantServiceRole,
  imageAssetOptions,
  REPO_ROOT,
  type SupportStack,
} from "./support-stack";

export const API_PORT = 8787;
export const DB_PORT = 5432;
export const LAMBDA_BATCH_SIZE = 5;
export const LAMBDA_TIMEOUT_SECONDS = Math.floor(
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS / 6,
);
export const WORKER_MEMORY_MIB = 4096;
export const WORKER_HEAP_BYTES = 3 * 1024 * 1024 * 1024;
export const WORKER_COMMAND = [
  "bun",
  "pipelines/support-triage/fargate-entries/production.ts",
];

export interface SupportAppStackProps extends StackProps {
  foundation: SupportStack;
  config: StageConfig;
}

export class SupportAppStack extends RegionalStack {
  readonly apiService: ecsPatterns.ApplicationLoadBalancedFargateService;
  readonly workerService: ecs.FargateService;
  readonly linearOutbound: lambda.DockerImageFunction;
  readonly adminSite: AdminSite;
  readonly apiUrl: string;

  constructor(scope: Construct, id: string, props: SupportAppStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.config.account, region: AWS_REGION },
      terminationProtection: props.config.stage === "production",
    });
    const { foundation, config } = props;
    const production = config.stage === "production";
    const https = config.certificateArn !== undefined;

    const logGroup = (name: string) =>
      new logs.LogGroup(this, name, {
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.RETAIN,
      });

    const albLogs = new s3.Bucket(this, "AlbLogs", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: Duration.days(90) }],
    });

    const apiRole = new iam.Role(this, "ApiTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    grantServiceRole(apiRole, foundation, "api");

    const workerRole = new iam.Role(this, "WorkerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });
    grantServiceRole(workerRole, foundation, "worker");

    const image = ecs.ContainerImage.fromDockerImageAsset(foundation.apiImage);

    const apiEnvironment: Record<string, string> = {
      NODE_ENV: "production",
      API_PORT: String(API_PORT),
      DB_NAME,
      ATTACHMENTS_BUCKET: foundation.attachmentsBucket.bucketName,
      TRIAGE_WAKE_QUEUE: RESOURCE_NAMES.triageWakeQueue,
      COGNITO_ISSUER: config.cognitoIssuer,
      COGNITO_AUDIENCE: config.adminClientId,
      MCP_AUDIENCE: config.mcpClientId,
      MCP_REQUIRED_GROUP: config.mcpRequiredGroup,
    };

    this.apiService = new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "Api",
      {
        cluster: foundation.cluster,
        cpu: 512,
        memoryLimitMiB: 1024,
        desiredCount: production ? 2 : 1,
        assignPublicIp: false,
        taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        publicLoadBalancer: true,
        protocol: https
          ? elbv2.ApplicationProtocol.HTTPS
          : elbv2.ApplicationProtocol.HTTP,
        certificate: https
          ? acm.Certificate.fromCertificateArn(
              this,
              "ApiCertificate",
              config.certificateArn as string,
            )
          : undefined,
        redirectHTTP: https,
        sslPolicy: https ? elbv2.SslPolicy.RECOMMENDED_TLS : undefined,
        idleTimeout: Duration.seconds(120),
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
        circuitBreaker: { rollback: true },
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskImageOptions: {
          image,
          containerPort: API_PORT,
          taskRole: apiRole,
          environment: apiEnvironment,
          secrets: databaseSecrets(foundation.database),
          logDriver: ecs.LogDrivers.awsLogs({
            streamPrefix: "api",
            logGroup: logGroup("ApiLogs"),
          }),
        },
      },
    );
    this.apiService.targetGroup.configureHealthCheck({
      path: "/health",
      healthyHttpCodes: "200",
      interval: Duration.seconds(15),
      healthyThresholdCount: 2,
    });
    this.apiService.loadBalancer.logAccessLogs(albLogs);
    this.apiService.loadBalancer.setAttribute(
      "routing.http.drop_invalid_header_fields.enabled",
      "true",
    );
    const scaling = this.apiService.service.autoScaleTaskCount({
      minCapacity: production ? 2 : 1,
      maxCapacity: 4,
    });
    scaling.scaleOnCpuUtilization("Cpu", { targetUtilizationPercent: 60 });

    this.apiUrl = https
      ? `https://${config.apiDomain}`
      : `http://${this.apiService.loadBalancer.loadBalancerDnsName}`;

    this.adminSite = new AdminSite(this, "AdminSite", {
      apiUrl: this.apiUrl,
      oidc: {
        authority: config.cognitoIssuer,
        clientId: config.adminClientId,
        logoutUrl: config.adminLogoutUrl,
      },
    });
    const adminOrigins = [this.adminSite.origin, ...config.extraAdminOrigins];
    this.apiService.taskDefinition.defaultContainer?.addEnvironment(
      "ADMIN_ORIGINS",
      adminOrigins.join(","),
    );

    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", {
      cpu: 1024,
      memoryLimitMiB: WORKER_MEMORY_MIB,
      taskRole: workerRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    workerTask.addContainer("worker", {
      image,
      command: WORKER_COMMAND,
      memoryLimitMiB: WORKER_MEMORY_MIB,
      environment: {
        NODE_ENV: "production",
        DB_NAME,
        ATTACHMENTS_BUCKET: foundation.attachmentsBucket.bucketName,
        TRIAGE_WAKE_QUEUE: RESOURCE_NAMES.triageWakeQueue,
        TRIAGE_AGENT_ID: config.triageAgentId,
        BUN_JSC_forceRAMSize: String(WORKER_HEAP_BYTES),
      },
      secrets: {
        ...databaseSecrets(foundation.database),
        ANTHROPIC_API_KEY: ecs.Secret.fromSecretsManager(
          foundation.anthropicSecret,
        ),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "worker",
        logGroup: logGroup("WorkerLogs"),
      }),
    });
    this.workerService = new ecs.FargateService(this, "WorkerService", {
      cluster: foundation.cluster,
      taskDefinition: workerTask,
      desiredCount: 1,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
    });

    this.linearOutbound = new lambda.DockerImageFunction(
      this,
      "LinearOutbound",
      {
        code: lambda.DockerImageCode.fromImageAsset(REPO_ROOT, {
          ...imageAssetOptions("lambda"),
        }),
        architecture: lambda.Architecture.X86_64,
        memorySize: 1024,
        timeout: Duration.seconds(LAMBDA_TIMEOUT_SECONDS),
        vpc: foundation.network.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        logGroup: logGroup("LinearOutboundLogs"),
        environment: {
          NODE_ENV: "production",
          DB_SECRET_ARN: foundation.database.secret.secretArn,
          DB_NAME,
        },
      },
    );
    foundation.database.secret.grantRead(this.linearOutbound);
    this.linearOutbound.role?.addManagedPolicy(
      foundation.secretsAccess.readPolicy,
    );
    this.linearOutbound.addEventSource(
      new SqsEventSource(foundation.queues.linearAdapterQueue, {
        batchSize: LAMBDA_BATCH_SIZE,
        reportBatchItemFailures: true,
        maxConcurrency: 5,
      }),
    );

    this.allowDatabase(foundation, "Api", this.apiService.service);
    this.allowDatabase(foundation, "Worker", this.workerService);
    this.allowDatabase(foundation, "Lambda", this.linearOutbound);

    this.addAlarms(foundation);

    new CfnOutput(this, "ApiUrl", { value: this.apiUrl });
    new CfnOutput(this, "ApiLoadBalancerDns", {
      value: this.apiService.loadBalancer.loadBalancerDnsName,
    });
  }

  private allowDatabase(
    foundation: SupportStack,
    name: string,
    source: ec2.IConnectable,
  ): void {
    const database = foundation.database.cluster.connections.securityGroups[0];
    new ec2.CfnSecurityGroupIngress(this, `${name}ToDatabase`, {
      groupId: (database as ec2.ISecurityGroup).securityGroupId,
      ipProtocol: "tcp",
      fromPort: DB_PORT,
      toPort: DB_PORT,
      sourceSecurityGroupId:
        source.connections.securityGroups[0]?.securityGroupId,
      description: `${name} to Postgres`,
    });
  }

  private addAlarms(foundation: SupportStack): void {
    const target = this.apiService.targetGroup;
    foundation.queues.addAlarm(
      new cloudwatch.Alarm(this, "ApiUnhealthyHosts", {
        alarmDescription:
          "The API has no healthy task behind the load balancer.",
        metric: target.metrics.healthyHostCount({
          period: Duration.minutes(1),
          statistic: "Minimum",
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );
    foundation.queues.addAlarm(
      new cloudwatch.Alarm(this, "ApiServerErrors", {
        alarmDescription: "The API returns repeated 5xx responses.",
        metric: this.apiService.loadBalancer.metrics.httpCodeTarget(
          elbv2.HttpCodeTarget.TARGET_5XX_COUNT,
          { period: Duration.minutes(5), statistic: "Sum" },
        ),
        threshold: 10,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    foundation.queues.addAlarm(
      new cloudwatch.Alarm(this, "LinearOutboundErrors", {
        alarmDescription: "The linear-outbound Lambda step fails.",
        metric: this.linearOutbound.metricErrors({
          period: Duration.minutes(5),
          statistic: "Sum",
        }),
        threshold: 3,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }),
    );
    foundation.queues.addAlarm(
      new cloudwatch.Alarm(this, "WorkerNotRunning", {
        alarmDescription: "The triage worker has no running task.",
        metric: new cloudwatch.Metric({
          namespace: "ECS/ContainerInsights",
          metricName: "RunningTaskCount",
          dimensionsMap: {
            ClusterName: foundation.cluster.clusterName,
            ServiceName: this.workerService.serviceName,
          },
          period: Duration.minutes(1),
          statistic: "Minimum",
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 5,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      }),
    );
  }
}
