import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { AWS_REGION, GITHUB_REPOSITORY, type StageConfig } from "./config";

export const OIDC_ISSUER = "token.actions.githubusercontent.com";
export const DEPLOY_ROLE_NAME = "pw-support-github-deploy";
export const DEFAULT_QUALIFIER = "hnb659fds";

export interface GithubOidcStackProps extends StackProps {
  config: StageConfig;
  repository?: string;
  qualifier?: string;
}

export function trustedSubjects(repository: string, stage: string): string[] {
  return [
    `repo:${repository}:ref:refs/heads/main`,
    `repo:${repository}:environment:${stage}`,
  ];
}

export class GithubOidcStack extends Stack {
  readonly deployRole: iam.Role;

  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, {
      ...props,
      env: { account: props.config.account, region: AWS_REGION },
    });
    const repository = props.repository ?? GITHUB_REPOSITORY;
    const qualifier = props.qualifier ?? DEFAULT_QUALIFIER;

    const provider = new iam.CfnOIDCProvider(this, "Provider", {
      url: `https://${OIDC_ISSUER}`,
      clientIdList: ["sts.amazonaws.com"],
    });

    this.deployRole = new iam.Role(this, "DeployRole", {
      roleName: DEPLOY_ROLE_NAME,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.attrArn, {
        StringEquals: { [`${OIDC_ISSUER}:aud`]: "sts.amazonaws.com" },
        StringLike: {
          [`${OIDC_ISSUER}:sub`]: trustedSubjects(
            repository,
            props.config.stage,
          ),
        },
      }),
    });

    const account = this.account;
    const bootstrapRoles = [
      "deploy",
      "file-publishing",
      "image-publishing",
      "lookup",
    ].map(
      (kind) =>
        `arn:${this.partition}:iam::${account}:role/cdk-${qualifier}-${kind}-role-${account}-${AWS_REGION}`,
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "AssumeCdkBootstrapRoles",
        actions: ["sts:AssumeRole"],
        resources: bootstrapRoles,
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ReadStackOutputs",
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:${this.partition}:cloudformation:${AWS_REGION}:${account}:stack/PwSupport*/*`,
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RunMigrationTask",
        actions: ["ecs:RunTask"],
        resources: [
          `arn:${this.partition}:ecs:${AWS_REGION}:${account}:task-definition/PwSupport*`,
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WatchMigrationTask",
        actions: ["ecs:DescribeTasks"],
        resources: [
          `arn:${this.partition}:ecs:${AWS_REGION}:${account}:task/*`,
        ],
      }),
    );
    this.deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "PassTaskRoles",
        actions: ["iam:PassRole"],
        resources: [`arn:${this.partition}:iam::${account}:role/PwSupport*`],
        conditions: {
          StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" },
        },
      }),
    );

    new CfnOutput(this, "DeployRoleArn", { value: this.deployRole.roleArn });
  }
}
