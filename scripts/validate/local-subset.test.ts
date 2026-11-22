import { describe, expect, test } from "bun:test";
import {
  buildSubset,
  type CfnTemplate,
  logicalIdFor,
  referencedIds,
  withLambdaStep,
  withOutputs,
} from "./local-subset";

const source: CfnTemplate = {
  Resources: {
    Bucket: {
      Type: "AWS::S3::Bucket",
      DeletionPolicy: "Retain",
      Properties: {},
    },
    Policy: {
      Type: "AWS::S3::BucketPolicy",
      Properties: { Bucket: { Ref: "Bucket" } },
    },
    Dlq: { Type: "AWS::SQS::Queue", Properties: { QueueName: "x-dlq" } },
    Queue: {
      Type: "AWS::SQS::Queue",
      DependsOn: ["Dlq", "Cluster"],
      Properties: {
        QueueName: "x",
        RedrivePolicy: {
          deadLetterTargetArn: { "Fn::GetAtt": ["Dlq", "Arn"] },
        },
      },
    },
    Orphan: {
      Type: "AWS::SQS::QueuePolicy",
      Properties: { Queues: [{ Ref: "Missing" }] },
    },
    Cluster: { Type: "AWS::RDS::DBCluster", Properties: {} },
    Alarm: {
      Type: "AWS::CloudWatch::Alarm",
      Properties: {
        Dimensions: [{ Value: { "Fn::GetAtt": "Queue.QueueName" } }],
      },
    },
    Region: {
      Type: "AWS::SNS::Topic",
      Properties: { Name: { Ref: "AWS::Region" } },
    },
  },
};

describe("referencedIds", () => {
  test("finds Ref and GetAtt in nested values and string form", () => {
    expect(
      referencedIds({
        a: [{ Ref: "One" }, { "Fn::GetAtt": ["Two", "Arn"] }],
        b: { "Fn::GetAtt": "Three.Arn" },
      }),
    ).toEqual(["One", "Two", "Three"]);
    expect(referencedIds("plain")).toEqual([]);
  });
});

describe("buildSubset", () => {
  const subset = buildSubset(source);

  test("keeps supported types and drops the rest", () => {
    expect(subset.kept.sort()).toEqual(
      ["Bucket", "Dlq", "Policy", "Region"].sort(),
    );
    expect(subset.dropped).toEqual(
      expect.arrayContaining(["Cluster", "Alarm", "Orphan", "Queue"]),
    );
  });

  test("cascades the drop to resources that reference a dropped one", () => {
    expect(subset.template.Resources.Queue).toBeUndefined();
    expect(subset.template.Resources.Orphan).toBeUndefined();
  });

  test("removes retention policies so a stack can be deleted", () => {
    expect(subset.template.Resources.Bucket?.DeletionPolicy).toBeUndefined();
  });

  test("keeps dependencies on kept resources only", () => {
    const wide = buildSubset(source, [
      "AWS::SQS::Queue",
      "AWS::RDS::DBCluster",
      "AWS::S3::Bucket",
    ]);
    expect(wide.template.Resources.Queue?.DependsOn).toEqual([
      "Dlq",
      "Cluster",
    ]);
    expect(wide.template.Resources.Dlq?.DependsOn).toBeUndefined();
  });
});

describe("template additions", () => {
  const base = buildSubset({
    Resources: {
      Queue: { Type: "AWS::SQS::Queue", Properties: { QueueName: "q" } },
    },
  }).template;

  test("adds the Lambda step with the pipeline event source settings", () => {
    const template = withLambdaStep(base, {
      codeBucket: "code",
      codeKey: "index.zip",
      role: "arn:aws:iam::000000000000:role/local",
      environment: { A: "1" },
      timeout: 10,
      memorySize: 1024,
      batchSize: 5,
      maxConcurrency: 5,
      eventSourceArn: { "Fn::GetAtt": ["Queue", "Arn"] },
    });
    const mapping = template.Resources.LinearOutboundMapping?.Properties;
    expect(mapping?.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    expect(mapping?.BatchSize).toBe(5);
    expect(
      template.Resources.LinearOutboundFunction?.Properties?.Code as object,
    ).toEqual({ S3Bucket: "code", S3Key: "index.zip" });
  });

  test("refuses a missing queue", () => {
    expect(() =>
      withLambdaStep(base, {
        codeBucket: "c",
        codeKey: "k",
        role: "r",
        environment: {},
        timeout: 1,
        memorySize: 1,
        batchSize: 1,
        maxConcurrency: 1,
        eventSourceArn: "",
      }),
    ).toThrow("needs an event source ARN");
  });

  test("adds outputs and finds a resource by property", () => {
    const withOut = withOutputs(base, { QueueUrl: "Queue" });
    expect(withOut.Outputs?.QueueUrl?.Value).toEqual({ Ref: "Queue" });
    expect(
      logicalIdFor(base, "AWS::SQS::Queue", (p) => p.QueueName === "q"),
    ).toBe("Queue");
    expect(logicalIdFor(base, "AWS::SQS::Queue", () => false)).toBeUndefined();
  });
});
