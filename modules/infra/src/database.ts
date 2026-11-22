import { Duration, type RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import type { SupportNetwork } from "./network";
import { LOG_RETENTION } from "./network";

export const DB_NAME = "support";
export const DB_USER = "support";

export interface SupportDatabaseProps {
  network: SupportNetwork;
  secretName: string;
  removalPolicy: RemovalPolicy;
  deletionProtection: boolean;
}

export class SupportDatabase extends Construct {
  readonly cluster: rds.DatabaseCluster;
  readonly secret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: SupportDatabaseProps) {
    super(scope, id);

    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_9,
      }),
      credentials: rds.Credentials.fromGeneratedSecret(DB_USER, {
        secretName: props.secretName,
      }),
      defaultDatabaseName: DB_NAME,
      vpc: props.network.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      writer: rds.ClusterInstance.serverlessV2("Writer", {
        publiclyAccessible: false,
        enablePerformanceInsights: true,
      }),
      readers: [
        rds.ClusterInstance.serverlessV2("Reader", {
          scaleWithWriter: true,
          publiclyAccessible: false,
          enablePerformanceInsights: true,
        }),
      ],
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 8,
      storageEncrypted: true,
      deletionProtection: props.deletionProtection,
      removalPolicy: props.removalPolicy,
      backup: { retention: Duration.days(14) },
      iamAuthentication: true,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: LOG_RETENTION,
      copyTagsToSnapshot: true,
    });

    this.cluster.connections.allowDefaultPortFrom(
      props.network.serviceSecurityGroup,
      "API, worker, migration, and Lambda access",
    );

    (
      this.cluster.node.findChild("Secret") as secretsmanager.Secret
    ).applyRemovalPolicy(props.removalPolicy);
    this.secret = this.cluster.secret as secretsmanager.ISecret;
    this.cluster.addRotationSingleUser({
      automaticallyAfter: Duration.days(30),
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });
  }
}
