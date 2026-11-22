import { RemovalPolicy } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { AVAILABILITY_ZONES } from "./stack-base";
export const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;

export class SupportNetwork extends Construct {
  readonly vpc: ec2.Vpc;
  readonly serviceSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, "Vpc", {
      availabilityZones: AVAILABILITY_ZONES,
      natGateways: 1,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "app",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
        {
          name: "data",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      flowLogs: {
        all: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            new logs.LogGroup(this, "FlowLogs", {
              retention: LOG_RETENTION,
              removalPolicy: RemovalPolicy.RETAIN,
            }),
          ),
        },
      },
    });
    this.vpc.addGatewayEndpoint("S3", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    this.serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSg", {
      vpc: this.vpc,
      description: "API, worker, migration task, and Lambda step",
      allowAllOutbound: true,
    });
  }
}
