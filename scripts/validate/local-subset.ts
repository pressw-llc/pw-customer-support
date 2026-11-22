export interface CfnTemplate {
  AWSTemplateFormatVersion?: string;
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, { Value: unknown }>;
  [key: string]: unknown;
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | string[];
  [key: string]: unknown;
}

export const LOCALSTACK_TYPES = [
  "AWS::S3::Bucket",
  "AWS::S3::BucketPolicy",
  "AWS::SQS::Queue",
  "AWS::SQS::QueuePolicy",
  "AWS::SNS::Topic",
  "AWS::SecretsManager::Secret",
];

export function referencedIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(referencedIds);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct: string[] = [];
    if (typeof record.Ref === "string") direct.push(record.Ref);
    const getAtt = record["Fn::GetAtt"];
    if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
      direct.push(getAtt[0]);
    } else if (typeof getAtt === "string") {
      direct.push(getAtt.split(".")[0] as string);
    }
    return [...direct, ...Object.values(record).flatMap(referencedIds)];
  }
  return [];
}

function dependsOn(resource: CfnResource): string[] {
  return resource.DependsOn === undefined
    ? []
    : Array.isArray(resource.DependsOn)
      ? resource.DependsOn
      : [resource.DependsOn];
}

const PSEUDO = /^AWS::/;

export interface Subset {
  template: CfnTemplate;
  kept: string[];
  dropped: string[];
}

export function buildSubset(
  source: CfnTemplate,
  types: string[] = LOCALSTACK_TYPES,
): Subset {
  const keep = new Map<string, CfnResource>();
  for (const [id, resource] of Object.entries(source.Resources)) {
    if (types.includes(resource.Type)) keep.set(id, structuredClone(resource));
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, resource] of keep) {
      const needs = [
        ...referencedIds(resource.Properties),
        ...dependsOn(resource),
      ].filter((ref) => !PSEUDO.test(ref) && ref !== id);
      if (needs.some((ref) => !keep.has(ref))) {
        keep.delete(id);
        changed = true;
      }
    }
  }

  const resources = Object.fromEntries(
    [...keep].map(([id, resource]) => {
      const { DeletionPolicy: _d, UpdateReplacePolicy: _u, ...rest } = resource;
      const remaining = dependsOn(rest).filter((dep) => keep.has(dep));
      const { DependsOn: _dep, ...withoutDeps } = rest;
      return [
        id,
        remaining.length > 0
          ? { ...withoutDeps, DependsOn: remaining }
          : withoutDeps,
      ];
    }),
  );
  return {
    template: {
      AWSTemplateFormatVersion: "2010-09-09",
      Resources: resources as Record<string, CfnResource>,
    },
    kept: [...keep.keys()],
    dropped: Object.keys(source.Resources).filter((id) => !keep.has(id)),
  };
}

export interface LambdaStep {
  codeBucket: string;
  codeKey: string;
  role: string;
  environment: Record<string, string>;
  timeout: number;
  memorySize: number;
  batchSize: number;
  maxConcurrency: number;
  eventSourceArn: unknown;
  runtime?: string;
}

export function withLambdaStep(
  template: CfnTemplate,
  step: LambdaStep,
): CfnTemplate {
  if (step.eventSourceArn === undefined || step.eventSourceArn === "") {
    throw new Error("the Lambda step needs an event source ARN");
  }
  return {
    ...template,
    Resources: {
      ...template.Resources,
      LinearOutboundFunction: {
        Type: "AWS::Lambda::Function",
        Properties: {
          FunctionName: "pw-support-linear-outbound",
          Runtime: step.runtime ?? "nodejs22.x",
          Handler: "index.handler",
          Role: step.role,
          Timeout: step.timeout,
          MemorySize: step.memorySize,
          Code: { S3Bucket: step.codeBucket, S3Key: step.codeKey },
          Environment: { Variables: step.environment },
        },
      },
      LinearOutboundMapping: {
        Type: "AWS::Lambda::EventSourceMapping",
        Properties: {
          FunctionName: { Ref: "LinearOutboundFunction" },
          EventSourceArn: step.eventSourceArn,
          BatchSize: step.batchSize,
          FunctionResponseTypes: ["ReportBatchItemFailures"],
          ScalingConfig: { MaximumConcurrency: step.maxConcurrency },
        },
      },
    },
  };
}

export function withOutputs(
  template: CfnTemplate,
  outputs: Record<string, string>,
): CfnTemplate {
  return {
    ...template,
    Outputs: Object.fromEntries(
      Object.entries(outputs).map(([name, logicalId]) => [
        name,
        { Value: { Ref: logicalId } },
      ]),
    ),
  };
}

export function logicalIdFor(
  template: CfnTemplate,
  type: string,
  match: (properties: Record<string, unknown>) => boolean,
): string | undefined {
  return Object.entries(template.Resources).find(
    ([, resource]) =>
      resource.Type === type && match(resource.Properties ?? {}),
  )?.[0];
}
