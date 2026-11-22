import { describe, expect, test } from "bun:test";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  TRIAGE_DEFAULTS,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { AWS_REGION, SECRETS_PREFIX, SupportStack } from "./index";

const stack = new SupportStack(new App(), "TestStack", {
  env: { region: AWS_REGION },
});
const template = Template.fromStack(stack);

describe("SupportStack", () => {
  test("deploys to us-east-1", () => {
    expect(stack.region).toBe("us-east-1");
  });

  test("creates one attachments bucket that blocks public access", () => {
    template.resourceCountIs("AWS::S3::Bucket", 1);
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } },
        ],
      },
    });
  });

  test("requires TLS on the bucket", () => {
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
  });

  test("creates the Linear adapter queue with a dead-letter queue", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-adapter-linear",
      RedrivePolicy: { maxReceiveCount: 5 },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-adapter-linear-dlq",
    });
  });

  test("creates the wake queue with a dead-letter queue", () => {
    template.resourceCountIs("AWS::SQS::Queue", 4);
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-triage-wake",
      RedrivePolicy: { maxReceiveCount: 5 },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-triage-wake-dlq",
    });
  });

  test("sets an explicit visibility timeout on the wake and adapter queues", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-triage-wake",
      VisibilityTimeout: TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-adapter-linear",
      VisibilityTimeout: LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
    });
    expect(TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS).toBeGreaterThan(
      TRIAGE_DEFAULTS.leaseSeconds,
    );
  });

  test("exposes the secrets prefix convention", () => {
    expect(SECRETS_PREFIX).toBe("pw-support/");
  });
});
