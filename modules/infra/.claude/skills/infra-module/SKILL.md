---

name: infra-module
description: Work in the infra module: the AWS CDK stack. Use when you add or change cloud resources or the secrets prefix.
---

# infra module

## Admin hosting and secrets

`AdminSite` creates a private S3 bucket and a CloudFront distribution with origin access control, security headers, and an index.html fallback for client routes. Pass the Cognito issuer and audience with the `cognitoIssuer` and `cognitoAudience` context keys. Commit no real ids.

`SecretsAccess` creates a read and a write managed policy scoped to `arn:...:secret:pw-support/*`. Attach them to the API and worker roles in Phase 6.

## Ownership

`modules/infra` owns the CDK app and `SupportStack` in `us-east-1`. The stack holds the attachments bucket, the triage wake queue with its DLQ, and the Secrets Manager prefix constant.

## Rules

- Add a resource only when a local equivalent exists in `docker-compose.yml` or `scripts/stack-setup.ts`.
- Take shared names from the contracts `RESOURCE_NAMES` constant.
- Keep `bun run synth` free of AWS credentials.
- Assert resources with `aws-cdk-lib/assertions`. Do not use snapshots.
- Deploy only on an owner instruction.

## Commands

```bash
bun run synth
bun test modules/infra
```
