# Phase 6 Validation Report

Target environment: local only. The dedicated AWS account and the npmjs organization do not exist yet. Nothing in this run publishes to a real registry or deploys to AWS.
Path exercised: `bash scripts/validate/phase-6-evidence.sh`. The script rebuilds the stack from empty, runs `bun run check` with no API key, then runs the release rehearsal, the deploy rehearsal, the plugin build, and the skills audit.

```text
A22  NOT RUN  The stack has no AWS account to deploy to. Local stand-in, deploy.log: 14 PASS lines, including "PASS deploy --dry-run succeeds with placeholder config", "PASS deploy the S3, SQS, and Secrets Manager subset of the stack: 13 resources deployed, 64 need real AWS", "PASS deploy the linear-outbound Lambda step into LocalStack Lambda (T15)", "PASS smoke: API, worker, deployed queues, and Linear stub produce a ticket", "PASS the worker container processes one job to a stub ticket".
A23  NOT RUN  The npmjs organization and its token do not exist. Local stand-in, release.log: 9 PASS lines, including "PASS release --publish pushes one tarball to both", "PASS both registries hold the same tarball", "PASS a fresh app installs and builds from registry A", "PASS a fresh app installs and builds from registry B", "PASS a second publish is idempotent".
A26  PASS     skills-audit.log: 13 pass, 0 fail. The audit runs inside `bun run check`. Each module and `apps/server` holds a skill. The root holds the pipelines skills, the managed-agents skills, and the repository skill.

3 criteria: 1 pass, 0 fail, 2 not run
```

T15 is now verified on both paths. The Lambda step runs behind an SQS poller and inside LocalStack Lambda. LocalStack 3 lacks the `nodejs22.x` runtime, so the rehearsal runs the same bundle on `nodejs20.x`.

T14 stays not verified. A Claude artifact needs the widget bundle on a public CDN and a public API.

The plugin bundle builds, and `claude plugin validate` passes on it: plugin.log "Validation passed".

Owner commands for the two real actions, with prerequisites in `docs/runbook.md`:

```bash
SUPPORT_API_URL=https://<api host> bun run release --publish
bun run deploy --stage production
```

What only the real run can prove:

- Most stack resources need real AWS: RDS, ECS, the load balancer, CloudFront, IAM, and the VPC. deploy.log states the exact count.
- Database password rotation against a real RDS instance. The local test rotates the password on Compose Postgres and LocalStack Secrets Manager.
- The smoke test's Linear query ran against the stub only.
- `bun install @pressw-llc/support-react` from npmjs and from GitHub Packages.
