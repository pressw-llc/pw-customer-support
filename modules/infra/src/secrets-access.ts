import { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export const SECRETS_READ_ACTIONS = [
  "secretsmanager:GetSecretValue",
  "secretsmanager:DescribeSecret",
];

export const SECRETS_WRITE_ACTIONS = [
  "secretsmanager:CreateSecret",
  "secretsmanager:PutSecretValue",
  "secretsmanager:UpdateSecret",
];

export function secretsPrefixArn(stack: Stack, prefix: string): string {
  return `arn:${stack.partition}:secretsmanager:${stack.region}:${stack.account}:secret:${prefix}*`;
}

export class SecretsAccess extends Construct {
  readonly readPolicy: iam.ManagedPolicy;
  readonly writePolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: { prefix: string }) {
    super(scope, id);
    const resource = secretsPrefixArn(Stack.of(this), props.prefix);

    this.readPolicy = new iam.ManagedPolicy(this, "ReadPolicy", {
      description: "Read integration secrets under the support prefix",
      statements: [
        new iam.PolicyStatement({
          actions: SECRETS_READ_ACTIONS,
          resources: [resource],
        }),
      ],
    });

    this.writePolicy = new iam.ManagedPolicy(this, "WritePolicy", {
      description: "Write integration secrets under the support prefix",
      statements: [
        new iam.PolicyStatement({
          actions: [...SECRETS_READ_ACTIONS, ...SECRETS_WRITE_ACTIONS],
          resources: [resource],
        }),
      ],
    });
  }
}
