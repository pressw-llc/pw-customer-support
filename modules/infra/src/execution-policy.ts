import { resourceNames } from "@pw-support/contracts";
import { AWS_REGION, type StageName, stackIds } from "./config";

export interface ScopedStatement {
  sid: string;
  effect?: "Allow" | "Deny";
  actions: string[];
  resources: string[];
  conditions?: Record<string, Record<string, string | string[]>>;
  unscopedBecause?: string;
}

export interface ExecutionPolicyInput {
  stage: StageName;
  account: string;
  partition?: string;
  certificateArn?: string;
}

export const TAG_ACTIONS = [
  "ec2:CreateTags",
  "ec2:DeleteTags",
  "elasticloadbalancing:AddTags",
  "elasticloadbalancing:RemoveTags",
  "cloudfront:TagResource",
  "cloudfront:UntagResource",
  "rds:AddTagsToResource",
  "rds:RemoveTagsFromResource",
  "sqs:TagQueue",
  "sqs:UntagQueue",
  "sns:TagResource",
  "sns:UntagResource",
  "lambda:TagResource",
  "lambda:UntagResource",
  "logs:TagResource",
  "logs:UntagResource",
  "secretsmanager:TagResource",
  "secretsmanager:UntagResource",
  "ecs:TagResource",
  "ecs:UntagResource",
  "cloudwatch:TagResource",
  "cloudwatch:UntagResource",
  "iam:TagRole",
  "iam:UntagRole",
  "iam:TagPolicy",
  "iam:UntagPolicy",
  "s3:PutBucketTagging",
];

export const UNTAG_ACTIONS = TAG_ACTIONS.filter((action) =>
  /(Untag|Remove|DeleteTags)/.test(action),
);

export const BOUNDARY_ACTIONS = [
  "logs:*",
  "s3:*",
  "sqs:*",
  "secretsmanager:*",
  "ecr:*",
  "ec2:CreateNetworkInterface",
  "ec2:DescribeNetworkInterfaces",
  "ec2:DeleteNetworkInterface",
  "ec2:AssignPrivateIpAddresses",
  "ec2:UnassignPrivateIpAddresses",
  "cloudfront:CreateInvalidation",
  "cloudfront:GetInvalidation",
  "lambda:InvokeFunction",
  "sns:Publish",
  "cloudwatch:PutMetricData",
];

export function boundaryArn(
  stage: StageName,
  account: string,
  partition = "aws",
): string {
  return `arn:${partition}:iam::${account}:policy/${resourceNames(stage).permissionsBoundary}`;
}

const SERVICE_LINKED_ROLES = [
  "ecs.amazonaws.com",
  "elasticloadbalancing.amazonaws.com",
  "rds.amazonaws.com",
  "ecs.application-autoscaling.amazonaws.com",
];

export function executionStatements(
  input: ExecutionPolicyInput,
): ScopedStatement[] {
  const { stage, account } = input;
  const partition = input.partition ?? "aws";
  const names = resourceNames(stage);
  const ids = stackIds(stage);
  const stacks = [ids.foundation, ids.app];
  const lower = stacks.map((name) => name.toLowerCase());
  const tag = `aws:ResourceTag/${names.stageTag}`;
  const requestTag = `aws:RequestTag/${names.stageTag}`;
  const arn = (service: string, resource: string, withRegion = true) =>
    `arn:${partition}:${service}:${withRegion ? AWS_REGION : ""}:${service === "s3" ? "" : account}:${resource}`;
  const stageTagged = { StringEquals: { [tag]: stage } };
  const createTagged = { StringEquals: { [requestTag]: stage } };
  const tagExisting = {
    StringEquals: { [tag]: stage },
    "ForAllValues:StringNotEquals": { "aws:TagKeys": [names.stageTag] },
  };
  const boundary = boundaryArn(stage, account, partition);
  const withBoundary = {
    StringEquals: { "iam:PermissionsBoundary": boundary },
  };

  const statements: ScopedStatement[] = [
    {
      sid: "StageStacks",
      actions: ["cloudformation:*"],
      resources: [
        ...stacks.map((name) => arn("cloudformation", `stack/${name}/*`)),
        ...stacks.map((name) => arn("cloudformation", `stack/${name}-*/*`)),
      ],
    },
    {
      sid: "StageRoles",
      actions: [
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:PutRolePolicy",
        "iam:GetRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:TagRole",
        "iam:UntagRole",
      ],
      resources: stacks.map((name) => arn("iam", `role/${name}-*`, false)),
    },
    {
      sid: "CreateBoundedRoles",
      actions: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"],
      resources: stacks.map((name) => arn("iam", `role/${name}-*`, false)),
      conditions: withBoundary,
    },
    {
      sid: "DenyUnboundedRoles",
      effect: "Deny",
      actions: ["iam:CreateRole", "iam:PutRolePermissionsBoundary"],
      resources: ["*"],
      conditions: {
        StringNotEquals: { "iam:PermissionsBoundary": boundary },
      },
    },
    {
      sid: "DenyBoundaryRemoval",
      effect: "Deny",
      actions: ["iam:DeleteRolePermissionsBoundary"],
      resources: ["*"],
    },
    {
      sid: "DenyBoundaryPolicyChanges",
      effect: "Deny",
      actions: [
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:SetDefaultPolicyVersion",
      ],
      resources: [boundary],
    },
    {
      sid: "PassStageRoles",
      actions: ["iam:PassRole"],
      resources: stacks.map((name) => arn("iam", `role/${name}-*`, false)),
      conditions: {
        StringEquals: {
          "iam:PassedToService": [
            "ecs-tasks.amazonaws.com",
            "lambda.amazonaws.com",
            "vpc-flow-logs.amazonaws.com",
          ],
        },
      },
    },
    {
      sid: "AttachOnlyKnownPolicies",
      actions: ["iam:AttachRolePolicy", "iam:DetachRolePolicy"],
      resources: stacks.map((name) => arn("iam", `role/${name}-*`, false)),
      conditions: {
        ArnLike: {
          "iam:PolicyARN": [
            `arn:${partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole`,
            `arn:${partition}:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole`,
            ...stacks.map((name) => arn("iam", `policy/${name}-*`, false)),
          ],
        },
      },
    },
    {
      sid: "StageManagedPolicies",
      actions: [
        "iam:CreatePolicy",
        "iam:CreatePolicyVersion",
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:GetPolicy",
        "iam:GetPolicyVersion",
        "iam:ListPolicyVersions",
        "iam:TagPolicy",
      ],
      resources: stacks.map((name) => arn("iam", `policy/${name}-*`, false)),
    },
    {
      sid: "ServiceLinkedRoles",
      actions: ["iam:CreateServiceLinkedRole"],
      resources: [arn("iam", "role/aws-service-role/*", false)],
      conditions: {
        StringEquals: { "iam:AWSServiceName": SERVICE_LINKED_ROLES },
      },
      unscopedBecause:
        "Service-linked roles are account-wide singletons that AWS names, so only the service name can limit them.",
    },
    {
      sid: "NetworkReadOnly",
      actions: ["ec2:Describe*"],
      resources: ["*"],
      unscopedBecause:
        "EC2 Describe actions do not support resource-level permissions.",
    },
    {
      sid: "NetworkCreateTagged",
      actions: [
        "ec2:CreateVpc",
        "ec2:CreateSubnet",
        "ec2:CreateRouteTable",
        "ec2:CreateInternetGateway",
        "ec2:CreateNatGateway",
        "ec2:AllocateAddress",
        "ec2:CreateSecurityGroup",
        "ec2:CreateVpcEndpoint",
        "ec2:CreateFlowLogs",
      ],
      resources: ["*"],
      conditions: createTagged,
      unscopedBecause:
        "New EC2 resources have no ARN yet, so the mandatory stage tag on the request limits them.",
    },
    {
      sid: "NetworkTagOnCreate",
      actions: ["ec2:CreateTags"],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "ec2:CreateAction": [
            "CreateVpc",
            "CreateSubnet",
            "CreateRouteTable",
            "CreateInternetGateway",
            "CreateNatGateway",
            "AllocateAddress",
            "CreateSecurityGroup",
            "CreateVpcEndpoint",
            "CreateFlowLogs",
          ],
        },
      },
      unscopedBecause:
        "Tagging at creation has no ARN yet; the create action name limits it.",
    },
    {
      sid: "NetworkChangeTagged",
      actions: [
        "ec2:DeleteVpc",
        "ec2:ModifyVpcAttribute",
        "ec2:DeleteSubnet",
        "ec2:ModifySubnetAttribute",
        "ec2:DeleteRouteTable",
        "ec2:AssociateRouteTable",
        "ec2:DisassociateRouteTable",
        "ec2:CreateRoute",
        "ec2:DeleteRoute",
        "ec2:DeleteInternetGateway",
        "ec2:AttachInternetGateway",
        "ec2:DetachInternetGateway",
        "ec2:DeleteNatGateway",
        "ec2:ReleaseAddress",
        "ec2:DeleteSecurityGroup",
        "ec2:AuthorizeSecurityGroupIngress",
        "ec2:AuthorizeSecurityGroupEgress",
        "ec2:RevokeSecurityGroupIngress",
        "ec2:RevokeSecurityGroupEgress",
        "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
        "ec2:UpdateSecurityGroupRuleDescriptionsEgress",
        "ec2:DeleteVpcEndpoints",
        "ec2:ModifyVpcEndpoint",
        "ec2:DeleteFlowLogs",
      ],
      resources: ["*"],
      conditions: stageTagged,
      unscopedBecause:
        "Existing EC2 resources are matched by the stage tag because their ids are generated.",
    },
    {
      sid: "TagExistingNetworkResources",
      actions: ["ec2:DeleteTags"],
      resources: ["*"],
      conditions: tagExisting,
      unscopedBecause:
        "Existing EC2 resources are matched by the stage tag, and the stage key itself cannot change.",
    },
    {
      sid: "DatabaseByName",
      actions: [
        "rds:CreateDBCluster",
        "rds:ModifyDBCluster",
        "rds:DeleteDBCluster",
        "rds:CreateDBInstance",
        "rds:ModifyDBInstance",
        "rds:DeleteDBInstance",
        "rds:CreateDBSubnetGroup",
        "rds:ModifyDBSubnetGroup",
        "rds:DeleteDBSubnetGroup",
        "rds:AddTagsToResource",
        "rds:RemoveTagsFromResource",
        "rds:ListTagsForResource",
      ],
      resources: lower.flatMap((prefix) =>
        ["cluster", "db", "subgrp"].map((kind) =>
          arn("rds", `${kind}:${prefix}-*`),
        ),
      ),
    },
    {
      sid: "DatabaseGlobalReads",
      actions: ["rds:Describe*"],
      resources: ["*"],
      unscopedBecause:
        "RDS Describe actions do not support resource-level permissions.",
    },
    {
      sid: "DatabaseParameterGroupsAndSecurity",
      actions: [
        "rds:CreateDBClusterParameterGroup",
        "rds:DeleteDBClusterParameterGroup",
      ],
      resources: lower.map((prefix) => arn("rds", `cluster-pg:${prefix}-*`)),
    },
    {
      sid: "StageSecrets",
      actions: [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
        "secretsmanager:RotateSecret",
        "secretsmanager:CancelRotateSecret",
        "secretsmanager:PutResourcePolicy",
        "secretsmanager:DeleteResourcePolicy",
        "secretsmanager:GetResourcePolicy",
      ],
      resources: [arn("secretsmanager", `secret:${names.anthropicSecret}-*`)],
    },
    {
      sid: "RandomPassword",
      actions: ["secretsmanager:GetRandomPassword"],
      resources: ["*"],
      unscopedBecause: "GetRandomPassword has no resource.",
    },
    {
      sid: "StageQueues",
      actions: [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueueTags",
      ],
      resources: [arn("sqs", `pw-support-${stage}-*`)],
    },
    {
      sid: "StageTopics",
      actions: [
        "sns:CreateTopic",
        "sns:DeleteTopic",
        "sns:GetTopicAttributes",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
        "sns:Unsubscribe",
        "sns:TagResource",
        "sns:UntagResource",
        "sns:ListTagsForResource",
      ],
      resources: stacks.map((name) => arn("sns", `${name}-*`)),
    },
    {
      sid: "StageBuckets",
      actions: [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:PutBucketPolicy",
        "s3:GetBucketPolicy",
        "s3:DeleteBucketPolicy",
        "s3:PutEncryptionConfiguration",
        "s3:GetEncryptionConfiguration",
        "s3:PutBucketPublicAccessBlock",
        "s3:GetBucketPublicAccessBlock",
        "s3:PutBucketVersioning",
        "s3:GetBucketVersioning",
        "s3:PutLifecycleConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:PutBucketOwnershipControls",
        "s3:PutBucketTagging",
        "s3:GetBucketTagging",
        "s3:PutBucketAcl",
        "s3:GetBucketAcl",
        "s3:ListBucket",
      ],
      resources: lower.map((prefix) => `arn:${partition}:s3:::${prefix}-*`),
    },
    {
      sid: "StageContainers",
      actions: [
        "ecs:CreateCluster",
        "ecs:DeleteCluster",
        "ecs:UpdateCluster",
        "ecs:UpdateClusterSettings",
        "ecs:PutClusterCapacityProviders",
        "ecs:CreateService",
        "ecs:UpdateService",
        "ecs:DeleteService",
        "ecs:TagResource",
        "ecs:UntagResource",
      ],
      resources: stacks.flatMap((name) => [
        arn("ecs", `cluster/${name}-*`),
        arn("ecs", `service/${name}-*/*`),
      ]),
    },
    {
      sid: "ContainerGlobalActions",
      actions: [
        "ecs:Describe*",
        "ecs:RegisterTaskDefinition",
        "ecs:DeregisterTaskDefinition",
      ],
      resources: ["*"],
      unscopedBecause:
        "ECS task definitions and Describe actions do not support resource-level permissions.",
    },
    {
      sid: "LoadBalancerCreateTagged",
      actions: [
        "elasticloadbalancing:CreateLoadBalancer",
        "elasticloadbalancing:CreateTargetGroup",
        "elasticloadbalancing:CreateListener",
        "elasticloadbalancing:CreateRule",
      ],
      resources: ["*"],
      conditions: createTagged,
      unscopedBecause:
        "Load balancer names are generated, so the stage tag on the request limits creation.",
    },
    {
      sid: "LoadBalancerTagOnCreate",
      actions: ["elasticloadbalancing:AddTags"],
      resources: ["*"],
      conditions: {
        ...createTagged,
        StringEqualsIfExists: {
          "elasticloadbalancing:CreateAction": [
            "CreateLoadBalancer",
            "CreateTargetGroup",
            "CreateListener",
            "CreateRule",
          ],
        },
        Null: { [tag]: "true" },
      },
      unscopedBecause:
        "Tagging at creation has no ARN yet; the request tag, the create action, and an untagged target limit it.",
    },
    {
      sid: "LoadBalancerTagExisting",
      actions: [
        "elasticloadbalancing:AddTags",
        "elasticloadbalancing:RemoveTags",
      ],
      resources: ["*"],
      conditions: tagExisting,
      unscopedBecause:
        "Existing load balancers are matched by the stage tag, and the stage key itself cannot change.",
    },
    {
      sid: "LoadBalancerChangeTagged",
      actions: [
        "elasticloadbalancing:ModifyLoadBalancerAttributes",
        "elasticloadbalancing:SetSecurityGroups",
        "elasticloadbalancing:SetSubnets",
        "elasticloadbalancing:DeleteLoadBalancer",
        "elasticloadbalancing:ModifyTargetGroup",
        "elasticloadbalancing:ModifyTargetGroupAttributes",
        "elasticloadbalancing:DeleteTargetGroup",
        "elasticloadbalancing:ModifyListener",
        "elasticloadbalancing:DeleteListener",
        "elasticloadbalancing:ModifyRule",
        "elasticloadbalancing:DeleteRule",
        "elasticloadbalancing:RegisterTargets",
        "elasticloadbalancing:DeregisterTargets",
      ],
      resources: ["*"],
      conditions: stageTagged,
      unscopedBecause:
        "Existing load balancers and target groups are matched by the stage tag because their names are generated.",
    },
    {
      sid: "LoadBalancerReads",
      actions: ["elasticloadbalancing:Describe*"],
      resources: ["*"],
      unscopedBecause:
        "Load balancer Describe actions do not support resource-level permissions.",
    },
    {
      sid: "StageFunctions",
      actions: [
        "lambda:CreateFunction",
        "lambda:DeleteFunction",
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:PutFunctionConcurrency",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags",
      ],
      resources: stacks.map((name) => arn("lambda", `function:${name}-*`)),
    },
    {
      sid: "StageLayers",
      actions: [
        "lambda:PublishLayerVersion",
        "lambda:GetLayerVersion",
        "lambda:DeleteLayerVersion",
      ],
      resources: [arn("lambda", "layer:*"), arn("lambda", "layer:*:*")],
      unscopedBecause:
        "CloudFormation generates layer names and layers support no tag condition, so only the account and region limit them.",
    },
    {
      sid: "StageEventSources",
      actions: [
        "lambda:CreateEventSourceMapping",
        "lambda:UpdateEventSourceMapping",
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping",
      ],
      resources: ["*"],
      conditions: {
        ArnLike: {
          "lambda:FunctionArn": stacks.map((name) =>
            arn("lambda", `function:${name}-*`),
          ),
        },
      },
      unscopedBecause:
        "Event source mappings have generated ids, so the function ARN condition limits them.",
    },
    {
      sid: "DistributionsCreateTagged",
      actions: [
        "cloudfront:CreateDistribution",
        "cloudfront:CreateDistributionWithTags",
      ],
      resources: ["*"],
      conditions: createTagged,
      unscopedBecause:
        "New distributions have no ARN yet, so the stage tag on the request limits them.",
    },
    {
      sid: "DistributionTagOnCreate",
      actions: ["cloudfront:TagResource"],
      resources: ["*"],
      conditions: { ...createTagged, Null: { [tag]: "true" } },
      unscopedBecause:
        "A new distribution has no ARN yet; the request tag and an untagged target limit it, so an existing distribution cannot be retagged.",
    },
    {
      sid: "DistributionTagExisting",
      actions: ["cloudfront:TagResource", "cloudfront:UntagResource"],
      resources: ["*"],
      conditions: tagExisting,
      unscopedBecause:
        "Existing distributions are matched by the stage tag, and the stage key itself cannot change.",
    },
    {
      sid: "DistributionsChangeTagged",
      actions: [
        "cloudfront:UpdateDistribution",
        "cloudfront:DeleteDistribution",
        "cloudfront:GetDistribution",
        "cloudfront:CreateInvalidation",
      ],
      resources: ["*"],
      conditions: stageTagged,
      unscopedBecause:
        "Existing distributions are matched by the stage tag because their ids are generated.",
    },
    {
      sid: "DistributionPoliciesAndOrigins",
      actions: [
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:GetOriginAccessControl",
        "cloudfront:CreateResponseHeadersPolicy",
        "cloudfront:UpdateResponseHeadersPolicy",
        "cloudfront:DeleteResponseHeadersPolicy",
        "cloudfront:GetResponseHeadersPolicy",
        "cloudfront:ListTagsForResource",
        "cloudfront:ListDistributions",
      ],
      resources: ["*"],
      unscopedBecause:
        "CloudFront origin access controls and response header policies support neither names nor tags in IAM.",
    },
    {
      sid: "StageLogGroups",
      actions: [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:DeleteRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:ListTagsForResource",
        "logs:ListTagsLogGroup",
        "logs:TagLogGroup",
      ],
      resources: [
        ...stacks.map((name) => arn("logs", `log-group:${name}-*`)),
        ...stacks.map((name) => arn("logs", `log-group:${name}-*:*`)),
        ...lower.map((prefix) =>
          arn("logs", `log-group:/aws/rds/cluster/${prefix}-*`),
        ),
      ],
    },
    {
      sid: "LogDelivery",
      actions: [
        "logs:DescribeLogGroups",
        "logs:CreateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:GetLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
      ],
      resources: ["*"],
      unscopedBecause:
        "CloudWatch Logs delivery and describe actions for flow logs and load balancer logs have no resource-level permissions.",
    },
    {
      sid: "StageAlarms",
      actions: [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
      ],
      resources: stacks.map((name) => arn("cloudwatch", `alarm:${name}-*`)),
    },
    {
      sid: "AlarmReads",
      actions: ["cloudwatch:DescribeAlarms", "cloudwatch:ListTagsForResource"],
      resources: ["*"],
      unscopedBecause:
        "CloudWatch alarm Describe actions do not support resource-level permissions.",
    },
    {
      sid: "ServiceAutoScaling",
      actions: [
        "application-autoscaling:RegisterScalableTarget",
        "application-autoscaling:DeregisterScalableTarget",
        "application-autoscaling:PutScalingPolicy",
        "application-autoscaling:DeleteScalingPolicy",
        "application-autoscaling:Describe*",
      ],
      resources: ["*"],
      unscopedBecause:
        "Application Auto Scaling targets and policies have generated ids and no tag conditions.",
    },
    {
      sid: "DenyStageTagChange",
      effect: "Deny",
      actions: TAG_ACTIONS,
      resources: ["*"],
      conditions: {
        "ForAnyValue:StringEquals": { "aws:TagKeys": [names.stageTag] },
        Null: { [tag]: "false" },
      },
    },
    {
      sid: "DenyStageTagRemoval",
      effect: "Deny",
      actions: UNTAG_ACTIONS,
      resources: ["*"],
      conditions: {
        "ForAnyValue:StringEquals": { "aws:TagKeys": [names.stageTag] },
      },
    },
    {
      sid: "OwnAssetObjects",
      actions: ["s3:GetObject"],
      resources: [
        `arn:${partition}:s3:::cdk-${names.bootstrapQualifier}-assets-${account}-${AWS_REGION}/*`,
      ],
    },
    {
      sid: "OwnContainerImages",
      actions: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      resources: [
        arn(
          "ecr",
          `repository/cdk-${names.bootstrapQualifier}-container-assets-${account}-${AWS_REGION}`,
        ),
      ],
    },
    {
      sid: "BootstrapVersion",
      actions: ["ssm:GetParameter", "ssm:GetParameters"],
      resources: [
        arn(
          "ssm",
          `parameter/cdk-bootstrap/${names.bootstrapQualifier}/version`,
        ),
      ],
    },
    {
      sid: "RdsManagedMasterSecret",
      actions: [
        "secretsmanager:CreateSecret",
        "secretsmanager:DeleteSecret",
        "secretsmanager:DescribeSecret",
        "secretsmanager:TagResource",
        "secretsmanager:UntagResource",
      ],
      resources: [arn("secretsmanager", "secret:rds!cluster-*")],
      unscopedBecause:
        "RDS names the managed master secret after the cluster id, which exists only after the cluster is created.",
    },
    {
      sid: "RdsManagedSecretKey",
      actions: ["kms:DescribeKey", "kms:Decrypt", "kms:GenerateDataKey"],
      resources: ["*"],
      conditions: {
        StringEquals: {
          "kms:ViaService": `secretsmanager.${AWS_REGION}.amazonaws.com`,
        },
      },
      unscopedBecause:
        "The default aws/secretsmanager key has an AWS-generated id, so only the Secrets Manager service limits it.",
    },
  ];

  if (input.certificateArn) {
    statements.push({
      sid: "ApiCertificate",
      actions: ["acm:DescribeCertificate"],
      resources: [input.certificateArn],
    });
  }
  return statements;
}
