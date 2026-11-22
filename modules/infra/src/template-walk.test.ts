import { describe, expect, test } from "bun:test";
import { resourceNames } from "@pw-support/contracts";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { BOUNDARY_ACTIONS, executionStatements } from "./execution-policy";
import { loadStageConfig } from "./load-config";
import { createSupportStacks } from "./stacks";

type Resource = { Type: string; Properties?: Record<string, unknown> };
type Resources = Record<string, Resource>;
type Statement = { Effect: string; Action?: string | string[] };

const config = loadStageConfig({
  stage: "production",
  placeholders: true,
  readContext: () => undefined,
  env: {},
});
const stacks = createSupportStacks(new App(), config);
const templates = {
  foundation: Template.fromStack(stacks.foundation),
  app: Template.fromStack(stacks.app),
};
const resourcesOf = (template: Template) =>
  template.toJSON().Resources as Resources;
const all = Object.entries(templates).flatMap(([stack, template]) =>
  Object.entries(resourcesOf(template)).map(
    ([id, resource]) => ({ stack, id, resource }) as const,
  ),
);

const asList = (value: string | string[] | undefined) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

function logicalIdOf(value: unknown): string | undefined {
  const record = value as Record<string, unknown> | undefined;
  const getAtt = record?.["Fn::GetAtt"];
  if (Array.isArray(getAtt)) return String(getAtt[0]);
  return typeof record?.Ref === "string" ? record.Ref : undefined;
}

function covers(patterns: string[], action: string): boolean {
  return patterns.some((pattern) =>
    new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      "i",
    ).test(action),
  );
}

const boundaryName = resourceNames("production").permissionsBoundary;

function hasBoundary(resource: Resource): boolean {
  return JSON.stringify(resource.Properties?.PermissionsBoundary).includes(
    `policy/${boundaryName}`,
  );
}

describe("resources that create IAM roles outside our templates", () => {
  test("no template uses a transform, a nested stack, or a hosted rotation", () => {
    for (const [stack, template] of Object.entries(templates)) {
      const json = template.toJSON() as Record<string, unknown>;
      expect(json.Transform, `${stack} Transform`).toBeUndefined();
    }
    for (const { stack, id, resource } of all) {
      expect(resource.Type, `${stack}/${id}`).not.toMatch(
        /^AWS::Serverless::|^AWS::CloudFormation::(Stack|CustomResource|Macro)$/,
      );
      if (resource.Type === "AWS::SecretsManager::RotationSchedule") {
        expect(
          resource.Properties?.HostedRotationLambda,
          `${stack}/${id}`,
        ).toBeUndefined();
      }
    }
  });

  test("every custom resource runs a function from the same template whose role carries the boundary", () => {
    const providers = all.filter(({ resource }) =>
      resource.Type.startsWith("Custom::"),
    );
    expect(providers.length).toBeGreaterThan(0);
    for (const { stack, id, resource } of providers) {
      const resources = resourcesOf(templates[stack as keyof typeof templates]);
      const fnId = logicalIdOf(resource.Properties?.ServiceToken);
      const fn = fnId ? resources[fnId] : undefined;
      expect(fn?.Type, `${stack}/${id} ServiceToken`).toBe(
        "AWS::Lambda::Function",
      );
      const roleId = logicalIdOf(fn?.Properties?.Role);
      const role = roleId ? resources[roleId] : undefined;
      expect(role?.Type, `${stack}/${id} role`).toBe("AWS::IAM::Role");
      expect(hasBoundary(role as Resource), `${stack}/${id} boundary`).toBe(
        true,
      );
    }
  });

  test("every function, task, and flow log names a role defined in its own template with the boundary", () => {
    const references: [string, unknown][] = [];
    for (const { stack, id, resource } of all) {
      const properties = resource.Properties ?? {};
      const label = `${stack}/${id}`;
      if (resource.Type === "AWS::Lambda::Function") {
        references.push([label, properties.Role]);
      }
      if (resource.Type === "AWS::ECS::TaskDefinition") {
        references.push([`${label} task`, properties.TaskRoleArn]);
        references.push([`${label} execution`, properties.ExecutionRoleArn]);
      }
      if (resource.Type === "AWS::EC2::FlowLog") {
        references.push([label, properties.DeliverLogsPermissionArn]);
      }
    }
    expect(references.length).toBeGreaterThan(8);
    for (const [label, reference] of references) {
      const stack = label.split("/")[0] as keyof typeof templates;
      const role = resourcesOf(templates[stack])[
        logicalIdOf(reference) as string
      ];
      expect(role?.Type, label).toBe("AWS::IAM::Role");
      expect(hasBoundary(role as Resource), `${label} boundary`).toBe(true);
    }
  });

  test("every action the roles are granted fits inside the boundary", () => {
    const actions = new Set<string>();
    for (const { resource } of all) {
      if (
        resource.Type !== "AWS::IAM::Policy" &&
        resource.Type !== "AWS::IAM::ManagedPolicy"
      ) {
        continue;
      }
      const document = resource.Properties?.PolicyDocument as {
        Statement: Statement[];
      };
      for (const statement of document.Statement) {
        if (statement.Effect !== "Allow") continue;
        for (const action of asList(statement.Action)) actions.add(action);
      }
    }
    const outside = [...actions].filter(
      (action) => !covers(BOUNDARY_ACTIONS, action),
    );
    expect(outside).toEqual([]);
  });
});

const NO_CALLER_ACTION = "invoked by CloudFormation, not the execution role";

const TYPE_ACTIONS: Record<string, string[] | typeof NO_CALLER_ACTION> = {
  "AWS::ApplicationAutoScaling::ScalableTarget": [
    "application-autoscaling:RegisterScalableTarget",
  ],
  "AWS::ApplicationAutoScaling::ScalingPolicy": [
    "application-autoscaling:PutScalingPolicy",
  ],
  "AWS::CloudFront::Distribution": ["cloudfront:CreateDistribution"],
  "AWS::CloudFront::OriginAccessControl": [
    "cloudfront:CreateOriginAccessControl",
  ],
  "AWS::CloudFront::ResponseHeadersPolicy": [
    "cloudfront:CreateResponseHeadersPolicy",
  ],
  "AWS::CloudWatch::Alarm": ["cloudwatch:PutMetricAlarm"],
  "AWS::EC2::EIP": ["ec2:AllocateAddress"],
  "AWS::EC2::FlowLog": ["ec2:CreateFlowLogs"],
  "AWS::EC2::InternetGateway": ["ec2:CreateInternetGateway"],
  "AWS::EC2::NatGateway": ["ec2:CreateNatGateway"],
  "AWS::EC2::Route": ["ec2:CreateRoute"],
  "AWS::EC2::RouteTable": ["ec2:CreateRouteTable"],
  "AWS::EC2::SecurityGroup": ["ec2:CreateSecurityGroup"],
  "AWS::EC2::SecurityGroupEgress": ["ec2:AuthorizeSecurityGroupEgress"],
  "AWS::EC2::SecurityGroupIngress": ["ec2:AuthorizeSecurityGroupIngress"],
  "AWS::EC2::Subnet": ["ec2:CreateSubnet"],
  "AWS::EC2::SubnetRouteTableAssociation": ["ec2:AssociateRouteTable"],
  "AWS::EC2::VPC": ["ec2:CreateVpc"],
  "AWS::EC2::VPCEndpoint": ["ec2:CreateVpcEndpoint"],
  "AWS::EC2::VPCGatewayAttachment": ["ec2:AttachInternetGateway"],
  "AWS::ECS::Cluster": ["ecs:CreateCluster"],
  "AWS::ECS::Service": ["ecs:CreateService"],
  "AWS::ECS::TaskDefinition": ["ecs:RegisterTaskDefinition"],
  "AWS::ElasticLoadBalancingV2::Listener": [
    "elasticloadbalancing:CreateListener",
  ],
  "AWS::ElasticLoadBalancingV2::LoadBalancer": [
    "elasticloadbalancing:CreateLoadBalancer",
  ],
  "AWS::ElasticLoadBalancingV2::TargetGroup": [
    "elasticloadbalancing:CreateTargetGroup",
  ],
  "AWS::IAM::ManagedPolicy": ["iam:CreatePolicy"],
  "AWS::IAM::Policy": ["iam:PutRolePolicy"],
  "AWS::IAM::Role": ["iam:CreateRole", "iam:PassRole"],
  "AWS::Lambda::EventSourceMapping": ["lambda:CreateEventSourceMapping"],
  "AWS::Lambda::Function": ["lambda:CreateFunction"],
  "AWS::Lambda::LayerVersion": [
    "lambda:PublishLayerVersion",
    "lambda:GetLayerVersion",
    "lambda:DeleteLayerVersion",
  ],
  "AWS::Logs::LogGroup": ["logs:CreateLogGroup"],
  "AWS::RDS::DBCluster": ["rds:CreateDBCluster"],
  "AWS::RDS::DBInstance": ["rds:CreateDBInstance"],
  "AWS::RDS::DBSubnetGroup": ["rds:CreateDBSubnetGroup"],
  "AWS::S3::Bucket": ["s3:CreateBucket"],
  "AWS::S3::BucketPolicy": ["s3:PutBucketPolicy"],
  "AWS::SQS::Queue": ["sqs:CreateQueue"],
  "AWS::SQS::QueuePolicy": ["sqs:SetQueueAttributes"],
  "AWS::SecretsManager::Secret": ["secretsmanager:CreateSecret"],
  "AWS::SNS::Topic": ["sns:CreateTopic"],
  "AWS::SNS::TopicPolicy": ["sns:SetTopicAttributes"],
  "Custom::CDKBucketDeployment": NO_CALLER_ACTION,
  "Custom::LogRetention": NO_CALLER_ACTION,
};

describe("the execution policy covers every resource type in the templates", () => {
  const allowed = executionStatements({
    stage: "production",
    account: config.account,
    certificateArn: config.certificateArn,
  })
    .filter((statement) => statement.effect !== "Deny")
    .flatMap((statement) => statement.actions);

  test("every resource type has a mapping", () => {
    const types = [...new Set(all.map(({ resource }) => resource.Type))].sort();
    expect(types.filter((type) => !(type in TYPE_ACTIONS))).toEqual([]);
  });

  test("every mapped action is allowed by at least one statement", () => {
    const types = new Set(all.map(({ resource }) => resource.Type));
    const missing: string[] = [];
    for (const [type, actions] of Object.entries(TYPE_ACTIONS)) {
      if (!types.has(type) || actions === NO_CALLER_ACTION) continue;
      for (const action of actions) {
        if (!covers(allowed, action)) missing.push(`${type} needs ${action}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the mapping lists no type the templates no longer use", () => {
    const types = new Set(all.map(({ resource }) => resource.Type));
    expect(
      Object.keys(TYPE_ACTIONS).filter((type) => !types.has(type)),
    ).toEqual([]);
  });
});
