import { describe, expect, test } from "bun:test";
import {
  LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS,
  TRIAGE_DEFAULTS,
  TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS,
} from "@pw-support/contracts";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  AWS_REGION,
  cognitoFromContext,
  SECRETS_PREFIX,
  SupportStack,
} from "./index";

const stack = new SupportStack(new App(), "TestStack", {
  env: { region: AWS_REGION },
});
const template = Template.fromStack(stack);

describe("SupportStack", () => {
  test("deploys to us-east-1", () => {
    expect(stack.region).toBe("us-east-1");
  });

  test("creates the attachments and admin buckets, both blocking public access", () => {
    template.resourceCountIs("AWS::S3::Bucket", 2);
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

describe("admin hosting", () => {
  test("serves the admin app from a private bucket through CloudFront with OAC", () => {
    template.resourceCountIs("AWS::CloudFront::Distribution", 1);
    template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
    template.hasResourceProperties("AWS::CloudFront::OriginAccessControl", {
      OriginAccessControlConfig: Match.objectLike({
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
      }),
    });
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: "index.html",
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: "redirect-to-https",
        }),
      }),
    });
    const buckets = template.findResources("AWS::S3::Bucket");
    for (const bucket of Object.values(buckets)) {
      expect(
        bucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,
      ).toBe(true);
    }
  });

  test("falls back to index.html for client-side routes", () => {
    template.hasResourceProperties("AWS::CloudFront::Distribution", {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: "/index.html",
          }),
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: "/index.html",
          }),
        ]),
      }),
    });
  });

  test("adds security headers", () => {
    template.hasResourceProperties("AWS::CloudFront::ResponseHeadersPolicy", {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({
          FrameOptions: { FrameOption: "DENY", Override: true },
        }),
      }),
    });
  });

  test("emits no Cognito output without context", () => {
    const names = Object.keys(template.toJSON().Outputs ?? {});
    expect(names.some((name) => name.includes("AdminOidc"))).toBe(false);
  });

  test("emits the Cognito settings from context without committing ids", () => {
    const app = new App({
      context: {
        cognitoIssuer: "https://idp.example/pool",
        cognitoAudience: "client-a, client-b",
      },
    });
    const withCognito = Template.fromStack(
      new SupportStack(app, "WithCognito", { env: { region: AWS_REGION } }),
    );
    const outputs = withCognito.toJSON().Outputs as Record<
      string,
      { Value: string }
    >;
    const value = (prefix: string) =>
      Object.entries(outputs).find(([name]) => name.startsWith(prefix))?.[1]
        .Value;
    expect(value("AdminSiteAdminOidcAuthority")).toBe(
      "https://idp.example/pool",
    );
    expect(value("AdminSiteAdminOidcAudience")).toBe("client-a,client-b");
  });

  test("reads Cognito settings only when both context values are strings", () => {
    expect(cognitoFromContext(() => undefined)).toBeUndefined();
    expect(
      cognitoFromContext((key) => (key === "cognitoIssuer" ? "x" : undefined)),
    ).toBeUndefined();
    expect(
      cognitoFromContext((key) => (key === "cognitoIssuer" ? "" : " , ")),
    ).toBeUndefined();
    expect(
      cognitoFromContext((key) =>
        key === "cognitoIssuer" ? "https://i" : "a,b",
      ),
    ).toEqual({ issuer: "https://i", audience: ["a", "b"] });
  });
});

describe("secrets access", () => {
  const statements = (): { Action: string[]; Resource: unknown }[] =>
    Object.values(template.findResources("AWS::IAM::ManagedPolicy")).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement,
    );

  test("scopes both managed policies to the secrets prefix", () => {
    template.resourceCountIs("AWS::IAM::ManagedPolicy", 2);
    for (const statement of statements()) {
      expect(JSON.stringify(statement.Resource)).toContain(
        `:secret:${SECRETS_PREFIX}*`,
      );
      expect(JSON.stringify(statement.Resource)).not.toBe('"*"');
    }
  });

  test("grants read on one policy and write on the other", () => {
    const actions = statements().map((statement) => statement.Action);
    const read = actions.find(
      (list) => !list.includes("secretsmanager:CreateSecret"),
    );
    const write = actions.find((list) =>
      list.includes("secretsmanager:CreateSecret"),
    );
    expect(read).toContain("secretsmanager:GetSecretValue");
    expect(read).not.toContain("secretsmanager:PutSecretValue");
    expect(write).toContain("secretsmanager:PutSecretValue");
    expect(write).toContain("secretsmanager:GetSecretValue");
  });
});
