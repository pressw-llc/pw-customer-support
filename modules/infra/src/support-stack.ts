import {
  RESOURCE_NAMES,
  TRIAGE_WAKE_MAX_RECEIVES,
} from "@pw-support/contracts";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";

export const SECRETS_PREFIX = RESOURCE_NAMES.secretsPrefix;
export const AWS_REGION = "us-east-1";

export class SupportStack extends Stack {
  readonly attachmentsBucket: s3.Bucket;
  readonly triageWakeQueue: sqs.Queue;
  readonly triageWakeDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.attachmentsBucket = new s3.Bucket(this, "AttachmentsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.triageWakeDlq = new sqs.Queue(this, "TriageWakeDlq", {
      queueName: RESOURCE_NAMES.triageWakeDlq,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    });

    this.triageWakeQueue = new sqs.Queue(this, "TriageWakeQueue", {
      queueName: RESOURCE_NAMES.triageWakeQueue,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        queue: this.triageWakeDlq,
        maxReceiveCount: TRIAGE_WAKE_MAX_RECEIVES,
      },
    });
  }
}
