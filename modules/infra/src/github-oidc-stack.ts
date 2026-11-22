import { resourceNames } from "@pw-support/contracts";
import {
  BootstraplessSynthesizer,
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import {
  AWS_REGION,
  GITHUB_REPOSITORY,
  type StageConfig,
  stackIds,
} from "./config";
import { executionStatements, type ScopedStatement } from "./execution-policy";

export const OIDC_ISSUER = "token.actions.githubusercontent.com";
export const MAX_POLICY_CHARS = 2_800;

export interface GithubOidcStackProps extends StackProps {
  config: StageConfig;
  repository?: string;
}

export function trustedSubject(repository: string, stage: string): string {
  return `repo:${repository}:environment:${stage}`;
}

export function toPolicyStatement(
  statement: ScopedStatement,
): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: statement.sid,
    actions: statement.actions,
    resources: statement.resources,
    conditions: statement.conditions,
  });
}

export function chunkStatements(
  statements: ScopedStatement[],
  limit = MAX_POLICY_CHARS,
): ScopedStatement[][] {
  const chunks: ScopedStatement[][] = [];
  let current: ScopedStatement[] = [];
  let size = 0;
  for (const statement of statements) {
    const length = JSON.stringify({
      Sid: statement.sid,
      Action: statement.actions,
      Resource: statement.resources,
      Condition: statement.conditions,
    }).length;
    if (size + length > limit && current.length > 0) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(statement);
    size += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export class GithubOidcStack extends Stack {
  readonly deployRole: iam.Role;
  readonly executionPolicies: iam.ManagedPolicy[];

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.config.account, region: AWS_REGION },
      synthesizer: new BootstraplessSynthesizer(),
    });
    const repository = props.repository ?? GITHUB_REPOSITORY;
    const stage = props.config.stage;
    const names = resourceNames(stage);
    const ids = stackIds(stage);
    const account = this.account;
    const partition = this.partition;

    const providerArn =
      stage === "production"
        ? new iam.CfnOIDCProvider(this, "Provider", {
            url: `https://${OIDC_ISSUER}`,
            clientIdList: ["sts.amazonaws.com"],
          }).attrArn
        : `arn:${partition}:iam::${account}:oidc-provider/${OIDC_ISSUER}`;

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: names.githubDeployRole,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: {
          [`${OIDC_ISSUER}:aud`]: "sts.amazonaws.com",
          [`${OIDC_ISSUER}:sub`]: trustedSubject(repository, stage),
        },
      }),
    });

    const qualifier = names.bootstrapQualifier;
    const bootstrapRoles = [
      "deploy",
      "file-publishing",
      "image-publishing",
      "lookup",
    ].map(
      (kind) =>
        `arn:${partition}:iam::${account}:role/cdk-${qualifier}-${kind}-role-${account}-${AWS_REGION}`,
    );
    const stacks = [ids.foundation, ids.app, ids.oidc];
    const stackArn = (name: string) =>
      `arn:${partition}:cloudformation:${AWS_REGION}:${account}:stack/${name}/*`;
    const taskDefinitions = [ids.foundation].map(
      (name) =>
        `arn:${partition}:ecs:${AWS_REGION}:${account}:task-definition/${name}MigrationTask*`,
    );
    const taskRoles = `arn:${partition}:iam::${account}:role/${ids.foundation}-MigrationTask*`;

    for (const statement of [
      {
        sid: "AssumeOwnBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoles,
      },
      {
        sid: "ReadOwnStackOutputs",
        actions: ["cloudformation:DescribeStacks"],
        resources: stacks.map(stackArn),
      },
      {
        sid: "ReadOwnBootstrapVersion",
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:${partition}:ssm:${AWS_REGION}:${account}:parameter/cdk-bootstrap/${qualifier}/version`,
        ],
      },
      {
        sid: "RunOwnMigrationTask",
        actions: ["ecs:RunTask"],
        resources: taskDefinitions,
        conditions: {
          ArnLike: {
            "ecs:cluster": `arn:${partition}:ecs:${AWS_REGION}:${account}:cluster/${ids.foundation}-*`,
          },
        },
      },
      {
        sid: "WatchOwnMigrationTask",
        actions: ["ecs:DescribeTasks"],
        resources: [
          `arn:${partition}:ecs:${AWS_REGION}:${account}:task/${ids.foundation}-*/*`,
        ],
      },
    ] satisfies ScopedStatement[]) {
      this.deployRole.addToPolicy(toPolicyStatement(statement));
    }
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassOwnTaskRoles",
        actions: ["iam:PassRole"],
        resources: [taskRoles],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );

    const chunks = chunkStatements(
      executionStatements({
        stage,
        account,
        partition,
        certificateArn: props.config.certificateArn,
      }),
    );
    this.executionPolicies = chunks.map((chunk, index) => {
      const policy = new iam.ManagedPolicy(
        this,
        `ExecutionPolicy${index + 1}`,
        {
          managedPolicyName: `${names.cfnExecutionPolicy}-${index + 1}`,
          description: `CloudFormation execution permissions for the ${stage} stacks`,
        },
      );
      for (const statement of chunk) {
        policy.addStatements(toPolicyStatement(statement));
      }
      return policy;
    });

    new CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn });
    new CfnOutput(this, "BootstrapQualifier", { value: qualifier });
    new CfnOutput(this, "CloudFormationExecutionPolicies", {
      value: this.executionPolicies
        .map((policy) => policy.managedPolicyArn)
        .join(","),
    });
  }
}
