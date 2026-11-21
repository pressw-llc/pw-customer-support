import { describe, expect, test } from "bun:test";
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

  test("creates the wake queue with a dead-letter queue", () => {
    template.resourceCountIs("AWS::SQS::Queue", 2);
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-triage-wake",
      RedrivePolicy: { maxReceiveCount: 5 },
    });
    template.hasResourceProperties("AWS::SQS::Queue", {
      QueueName: "pw-support-triage-wake-dlq",
    });
  });

  test("exposes the secrets prefix convention", () => {
    expect(SECRETS_PREFIX).toBe("pw-support/");
  });
});
