---
name: infra-module
description: Work in the infra module: the AWS CDK stack. Use when you add or change cloud resources or the secrets prefix.
---

# infra module

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
