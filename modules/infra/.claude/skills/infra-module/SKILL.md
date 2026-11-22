---

name: infra-module
description: Work in the infra module: the AWS CDK stacks, stage config, and the cdk-nag checks. Use when you add or change cloud resources, the stage config, IAM scope, or the secrets prefix.
---

# infra module

## Ownership

`modules/infra` owns the CDK app in `us-east-1`. It defines three stacks per stage, built by `createSupportStacks` in `src/stacks.ts`.

| Stack                 | File                       | Holds                                                                                                                                |
| --------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PwSupport`           | `src/support-stack.ts`     | VPC, Aurora Serverless v2, attachments bucket, queues with DLQs and alarms, secrets policies, ECS cluster, migration task definition |
| `PwSupportApp`        | `src/app-stack.ts`         | API service behind an ALB, worker service, `linear-outbound` Lambda, admin site and its runtime config                               |
| `PwSupportGithubOidc` | `src/github-oidc-stack.ts` | The GitHub Actions deploy role, trusted for this repository on `main` or the `production` environment                                |

The foundation stack deploys first. `scripts/deploy/main.ts` runs the migration task between the foundation and app stacks. The app stack adds its own database ingress rules to avoid a stack cycle.

## Stage config

`src/config.ts` resolves a `StageConfig` from CDK context, `modules/infra/stage.<stage>.json`, and `SUPPORT_STAGE_CONFIG`. The file is gitignored. `stage.example.json` shows the keys. `bun run synth` passes `-c placeholders=true`, so synth runs with no account. A deploy never uses placeholders and lists every missing value. An empty `mcpRequiredGroup` fails in production even with placeholders. `linearApiUrl` cannot be set in production.

## Rules

- Commit no account id, domain, pool id, client id, or key.
- Take shared names and timeouts from the contracts `RESOURCE_NAMES` and visibility constants.
- Keep `bun run synth` free of AWS credentials and lookups. `RegionalStack` fixes the availability zones.
- Give every queue a DLQ with redrive and an alarm. Keep the Lambda timeout at one sixth of the adapter queue visibility timeout or less.
- Keep the managed-agent step on Fargate. The only Lambda is the `linear-outbound` step.
- Reference secrets by ARN or by prefix. Never put a secret value in an environment variable or a template.
- Scope IAM to named resources. Add a wildcard only for an action that AWS does not scope, and justify it in `src/nag-suppressions.ts` in one line.
- Assert resources with the CDK assertions module. Do not use snapshots. `src/nag.test.ts` runs cdk-nag AwsSolutions and fails on any unsuppressed finding.
- `src/index.ts` exports the surface that `scripts/deploy/main.ts` uses.
- Deploy only on an owner instruction.

## Commands

```bash
bun run synth
bun test modules/infra
bun run deploy --dry-run
bun run validate:deploy
```
