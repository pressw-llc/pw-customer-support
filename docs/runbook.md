# Runbook

This runbook covers the first deploy, routine operations, and recovery for PressW Customer Support V1. The stack runs in a dedicated AWS account in `us-east-1`.

An agent never runs the owner actions below. The AWS account and the npmjs organization do not exist yet.

## First deploy

Do the steps in order. Each step names what it unblocks.

### 1. AWS account, CDK bootstrap, and the OIDC role

- [ ] Create the dedicated AWS account and note its 12 digit id.
- [ ] Sign in to the account with admin credentials.
- [ ] Request an ACM certificate in `us-east-1` for the API host name, for example `support-api.<your domain>`. Validate it. Note the certificate ARN.
- [ ] Copy `modules/infra/stage.example.json` to `modules/infra/stage.production.json`. Fill `account` and `certificateArn` now. Leave the Cognito, agent, and group values for steps 2 to 4. The file is gitignored.
- [ ] Deploy the stage's OIDC stack with the admin credentials. It needs no bootstrap. It creates the GitHub deploy role, the account's GitHub OIDC provider (production only), and the stage's CloudFormation execution policies.

```bash
GITHUB_TOKEN=<read:packages token> bun run deploy --stage production --oidc
```

- [ ] Bootstrap CDK for this stage with the same admin credentials. The command uses the stage's own qualifier (`pwsproduct`), its own toolkit stack (`CDKToolkit-pwsproduct`), and the execution policies from the previous step instead of `AdministratorAccess`.

```bash
GITHUB_TOKEN=<read:packages token> bun run deploy --stage production --bootstrap
```

- [ ] Copy the `DeployRoleArn` output of the OIDC stack. Add it to the GitHub repository as the variable `AWS_DEPLOY_ROLE_ARN`.
- [ ] Create the GitHub environment `production`. Restrict its deployment branches to `main` and add a required reviewer.
- [ ] Add the repository variable `SUPPORT_STAGE_CONFIG` with the JSON of the stage file, and the secret `PACKAGES_READ_TOKEN` if the default token cannot read `@pressw-llc` packages.

The role trusts only `repo:pressw-llc/pw-customer-support:environment:production`. It does not trust the `main` branch alone, because the environment adds the required reviewer and branch rule, and a branch-only subject would let any workflow on `main` deploy. It can assume only the four bootstrap roles of its own qualifier, read its own stacks and bootstrap version, run its own migration task, and pass its own task roles.

#### Stage isolation

The strongest isolation is one AWS account per stage. The PRD names one dedicated production account, so production runs alone there. A staging stage in the same account relies on these controls:

- Each stage has its own CDK qualifier, toolkit stack, bootstrap roles, assets bucket, and image repository.
- Each stage's GitHub role trusts only its own environment subject and can assume only its own qualifier's bootstrap roles. The deploy preflight refuses a stage deployed through another stage's role or without its own bootstrap.
- Each stage's CloudFormation execution role holds only the stage execution policies, never `AdministratorAccess`. Statements are scoped by stage name prefix or by the `pw-support:stage` tag, which every taggable resource in all three stacks carries.
- Only the production OIDC stack creates the account-wide GitHub OIDC provider. Deploy it first.

These statements cannot be scoped by name or tag, with the reason:

| Statement | Why it stays broad |
| --- | --- |
| EC2, RDS, ELB, ECS, CloudWatch, Auto Scaling `Describe*` and `List*` | AWS offers no resource-level permissions for them |
| `iam:CreateServiceLinkedRole` | Service-linked roles are account-wide singletons that AWS names, limited by service name |
| EC2 and load balancer creation, CloudFront distribution creation | New resources have no ARN, limited by the required stage tag on the request |
| Changing existing EC2, load balancer, and distribution resources | Their ids are generated, limited by the stage tag on the resource |
| `ecs:RegisterTaskDefinition`, task definition describe | Task definitions have no resource-level permissions |
| CloudFront origin access controls and response header policies | IAM supports neither names nor tags for them |
| Application Auto Scaling targets and policies | Their ids are generated and they have no tag conditions |
| CloudWatch Logs delivery for flow logs and load balancer logs | The delivery actions have no resource-level permissions |
| `secretsmanager:GetRandomPassword` | The action has no resource |
| Lambda event source mappings | Limited by the function ARN condition because mapping ids are generated |

The execution policy was checked by synth and by assertions. The first real bootstrap may show a missing action. Add it to `modules/infra/src/execution-policy.ts`, keep the scope, and redeploy the OIDC stack.

### 2. Cognito app clients on the telemetry pool

The pool lives in the `pw-telemetry-platform` account. Create two app clients on it.

| Client | Used by | Flow | Callback URLs | Sign-out URLs |
| --- | --- | --- | --- | --- |
| Admin | Admin site | Authorization code with PKCE, no secret | `<admin origin>/auth/callback` | `<admin origin>/signed-out` |
| MCP | Laptop plugin | Authorization code with PKCE, no secret | `http://127.0.0.1:53682/callback` | none |

- [ ] The admin origin is the CloudFront URL that step 6 prints as `AdminUrl`. Create the admin client with the temporary callback `https://localhost/auth/callback`. Replace it with the exact URLs after step 6.
- [ ] Allow the scopes `openid`, `profile`, and `email` on both clients.
- [ ] Note the pool issuer `https://cognito-idp.us-east-1.amazonaws.com/<poolId>` and the two client ids.
- [ ] Create two Cognito groups. `support-staff` holds the engineers who use the laptop plugin. The API requires it on `/mcp`. `support-admins` holds the PressW admins who sign in to the admin site. The API requires it on `/admin`, which can write integration secrets. Add people to the group they need. Keep `support-admins` small.
- [ ] The admin site sends the ID token. The ID token carries `cognito:groups` and `email`, so the group check passes. The plugin sends the access token to `/mcp`, and the same group claim applies.
- [ ] Note the hosted UI domain. Set `adminLogoutUrl` to `https://<hosted UI domain>/logout?client_id={client_id}&logout_uri={logout_uri}`.
- [ ] Put `cognitoIssuer`, `adminClientId`, `mcpClientId`, `mcpRequiredGroup`, `adminRequiredGroup`, and `adminLogoutUrl` in the stage file. Add `adminAllowedEmailDomains` to also limit admin sign-in by email domain.

### 3. Anthropic agent and Jev

- [ ] Run `ANTHROPIC_API_KEY=<key> bun run agent:sync`. It prints the agent id. Put it in the stage file as `triageAgentId`.
- [ ] Keep the Anthropic and Jev keys ready for step 7. They never go in the stage file. The Jev key goes through the admin site. The Anthropic key goes straight into Secrets Manager.

### 4. Linear

- [ ] Create or choose the support team and a sandbox team for the smoke test.
- [ ] Create a Linear API key that can create issues and comments on those teams.
- [ ] Note both team ids.
- [ ] Create the webhook after step 6, because it needs the API URL. It posts to `<API URL>/webhooks/linear`, covers Comment events, and is scoped to the support teams. Save its signing secret for step 7.

### 5. npmjs organization and tokens

- [ ] Create the `pressw-llc` organization on npmjs.
- [ ] Create a publish token for it. Export it as `NPM_TOKEN` when you release.
- [ ] Create a GitHub token with `write:packages` for `GH_PACKAGES_TOKEN`.

### 6. First deploy

The first deploy skips the smoke test, because the keys do not exist yet.

```bash
GITHUB_TOKEN=<read:packages token> bun run deploy --stage production --skip-smoke
```

- [ ] Copy the outputs `ApiUrl`, `AdminUrl`, `AdminCallbackUrl`, `AdminSignedOutUrl`, and `ApiLoadBalancerDns`.
- [ ] Point the API host name at `ApiLoadBalancerDns` with a CNAME.
- [ ] Replace the temporary admin callback with `AdminCallbackUrl` and `AdminSignedOutUrl` on the admin client.
- [ ] Create the Linear webhook from step 4.

The worker and the API start before the keys exist. The worker logs that the Jev and agent checks failed and sends every job to human triage until step 7 ends.

### 7. Secrets, project, and smoke

- [ ] Sign in to the admin site. Open Settings, then Integrations. Save the Linear key, the Linear webhook secret, and the Jev key. The values go to Secrets Manager under `pw-support/<scope>/<name>`. Postgres keeps only the reference.
- [ ] Store the Anthropic key in the secret the stack created. The worker reads it as `ANTHROPIC_API_KEY` at start.

```bash
aws secretsmanager put-secret-value --secret-id pw-support-anthropic/api-key --secret-string <key>
aws ecs update-service --cluster <ClusterName> --service <worker service> --force-new-deployment
```

- [ ] Create the project `smoke` for the sandbox team. Mint a key. Set the GitHub secret `SMOKE_PROJECT_KEY`, the secret `SMOKE_LINEAR_API_KEY`, and the variable `SMOKE_LINEAR_TEAM_ID`.
- [ ] Run the smoke test.

```bash
SMOKE_API_URL=<ApiUrl> SMOKE_PROJECT_KEY=<key> SMOKE_LINEAR_API_KEY=<key> SMOKE_LINEAR_TEAM_ID=<team id> bun run smoke
```

The smoke test submits one request and reads back the Linear ticket. It archives the ticket. A pass proves A22 for the local deploy script.

- [ ] Run the GitHub workflow `Deploy` once from `main`. A pass proves A22 for Actions.
- [ ] Publish the widget. See "Publish the widget".

## Routine operations

### Routine deploy

Run the `Deploy` workflow from `main` after CI passes. The workflow runs `bun run deploy --stage production`. The script builds, diffs, deploys the foundation stack, runs the migration task, deploys the app stack, and runs the smoke test. A failed migration stops the deploy before the services roll. A failed service rollout rolls back through the ECS circuit breaker.

### Migration rule

The deploy migrates before it rolls the services, so the old app runs against the new schema for a while, and a failed rollout leaves it there. Write every migration so the previous release still works on it. Add a column, table, or index first. Ship code that uses it. Remove the old column in a later release. Never rename or drop something the running release reads in the same release. Each migration file runs in one transaction, so a failed file leaves the schema at the previous step.

### Failure states of a deploy

| Where it fails | State left | Action |
| --- | --- | --- |
| Preflight | Nothing deployed | Fix the listed items and rerun |
| Foundation stack | The previous stacks keep running | Read the CloudFormation events and rerun |
| Migration task | Foundation updated, old app running, schema at the last good file | Fix the migration, rerun. The advisory lock keeps two runs apart |
| App stack | New schema, old app, ECS rolled back by the circuit breaker | The old release must work on the new schema. Fix forward and rerun |
| Smoke test | The new app is serving | Read the API logs, then roll back or fix forward |

A rerun after any failure is safe. The steps are idempotent and CloudFormation rejects two updates of one stack at once. The workflow also holds the `deploy-production` concurrency group, so two workflow runs never overlap.

### Rollback

- Check out the previous good commit on `main` and run the `Deploy` workflow. The script rebuilds that commit's image. Pass `--skip-migrate` to a local `bun run deploy --stage production --skip-migrate` so the schema stays at the newer version, which the migration rule keeps compatible.
- A migration is forward only. Write a new migration that undoes the change. Do not edit an applied migration.
- If a bad task keeps restarting, set the service desired count to 0 in the ECS console, fix, and deploy.
- Staging buckets are deleted with the stack only when empty. Empty them before a teardown.

### Publish the widget

```bash
bun run release                       # dry run, prints the plan
SUPPORT_API_URL=https://<API host> NPM_TOKEN=<token> GH_PACKAGES_TOKEN=<token> bun run release --publish
git tag support-react-v<version> && git push origin support-react-v<version>
```

Bump `version` in `modules/widget/package.json` first. If the second registry fails after the first succeeds, run the printed retry command, for example `bun run release --publish --only github`. It republishes the saved tarball from `.release` and never rebuilds. A version that exists with different content stops the release before anything is sent. See the README Release section.

### Key rotation

- Anthropic key: run `put-secret-value` on `pw-support-anthropic/api-key`, then force a new deployment of the worker service.
- Linear, webhook, and Jev keys: save the new value in the admin Integrations page. The API sees it at once. Other processes see it within 30 seconds. Revoke the old key in Linear or TypeSafe afterward.
- Database password: Secrets Manager rotates it every 30 days with the hosted rotation. Running tasks reconnect on the next restart. Force a restart with `aws ecs update-service --force-new-deployment` for the API and worker services.
- Project keys: mint a new key, give it to the client, then revoke the old key.
- Watcher credentials: `pw-support logout` revokes the credential of one laptop.

### Add a client project and mint a key

- [ ] Open the admin site, Settings, Projects. Create the project with the client and project slugs. Choose the Linear team.
- [ ] Mint a key. The full key appears once. Send it to the client developer.
- [ ] Optionally set the severe-request CC list. V1 stores it and sends nothing.
- [ ] Give the client `@pressw-llc/support-react` and the two props, `projectKey` and `userEmail`.

### Revoke a key

Open Settings, Projects, the project, then Revoke on the key. Requests with that key return 401 at once.

### Install the laptop plugin and log in

```bash
bun run build:plugin
claude --plugin-dir modules/plugin/dist/plugin
export PW_SUPPORT_API_URL=https://<API host>
export PW_SUPPORT_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/<poolId>
export PW_SUPPORT_CLIENT_ID=<MCP client id>
modules/plugin/dist/plugin/bin/pw-support login
```

Then run `/support:subscribe <client>` and `/support:watch start` in a session. The engineer must be in the required Cognito group.

## Recovery

### DLQ triage

An alarm on a DLQ means a message failed five times.

- [ ] Open the queue `pw-support-triage-wake-dlq` or `pw-support-adapter-linear-dlq` in SQS. Poll for messages and read one body.
- [ ] Find the matching job or event by id in the admin request detail.
- [ ] Fix the cause. Common causes are an invalid Linear key, a Linear outage, or a deleted team.
- [ ] Start a redrive from the DLQ to its source queue in the SQS console. The handlers are idempotent.
- [ ] If the message is stale, purge it. The sweeper recovers any open job.

### Stuck job or held reply

- A job that stays open is recovered by the worker sweeper every 30 seconds. Check that the worker service has a running task.
- A job claimed by a laptop that went away returns to the cloud when its lease lapses, within 120 seconds.
- A job that failed three cloud attempts completes as human triage. The ticket carries the human triage label.
- A held reply waits for `@confirm` from its author in the Linear thread. A hold expires after its lifetime and the next dispatcher tick marks it expired. The admin request detail shows held and flagged replies.
- A comment that never reached the widget needs a Linear webhook check. Open Linear webhooks and read the delivery log. A 401 means the signing secret differs from the saved one.

## Production settings that must be set

The API reads blank settings as off. The stage config makes each one mandatory or justifies the default.

| Setting | Production rule |
| --- | --- |
| `ADMIN_REQUIRED_GROUP`, `ADMIN_ALLOWED_EMAIL_DOMAINS` | `adminRequiredGroup` is mandatory in every stage. The API also answers 503 `admin_not_configured` on every `/admin` route when neither is set |
| `MCP_REQUIRED_GROUP`, `MCP_AUDIENCE` | `mcpRequiredGroup` is mandatory in production. The API answers 503 on `/mcp` routes when either is missing |
| `COGNITO_ISSUER`, `COGNITO_AUDIENCE` | Mandatory. The admin token validator rejects every request without them |
| `ADMIN_ORIGINS` | The stack sets it to the admin CloudFront origin plus `extraAdminOrigins`. It is never blank |
| `DB_SECRET_ARN`, `DB_HOST` | Set by the stack. The API refuses to start a database client in production without them and refuses `DATABASE_URL` |
| `LINEAR_WEBHOOK_SECRET` | Saved through the admin Integrations page. The webhook route answers 503 until a secret exists, so it fails closed |
| Rate limits (`RATE_LIMIT_*`, `MCP_RATE_LIMIT_PER_WINDOW`, `ADMIN_RATE_LIMIT_PER_WINDOW`) | The defaults are safe. They are not blank, so they stay unset in the stack |
| `LINEAR_API_URL` | Ignored in production and refused by the stage config |

## Database credentials and TLS

The database password rotates every 30 days. The API, worker, migration task, and Lambda hold only the secret ARN. Each new connection reads the password from Secrets Manager. A five minute cache applies, and a connection that fails after a rotation refreshes it, so the next connection uses the new password with no restart.

Production connections verify the server certificate against the RDS CA bundle that the image carries at `/etc/ssl/rds/us-east-1-bundle.pem`. The Dockerfile downloads the bundle from the AWS trust store and pins its SHA-256. When AWS publishes a new bundle, the image build fails on the checksum. Download the new bundle, check its source, and update the pinned checksum in `Dockerfile`.

## Alarms

| Alarm | Meaning | First action |
| --- | --- | --- |
| `TriageWakeDlqMessages` | A wake message failed five times | DLQ triage |
| `LinearAdapterDlqMessages` | A Linear delivery failed five times | DLQ triage, check the Linear key |
| `TriageWakeOldestMessage` | A wake message waits over 15 minutes | Check the worker service and its logs |
| `LinearAdapterOldestMessage` | An adapter message waits over 10 minutes | Check the Lambda errors and Linear status |
| `ApiUnhealthyHosts` | No healthy API task | Check the ECS service events and `/health` |
| `ApiServerErrors` | Ten or more 5xx responses in five minutes | Read the API log group |
| `LinearOutboundErrors` | The Lambda step raised errors | Read the Lambda log group |
| `WorkerNotRunning` | The worker has no running task | Check the ECS service events and the self-test log line |

Set `alarmEmail` in the stage file to subscribe an address to the alarm topic. Confirm the subscription email.

## V1 limits

These are accepted in the PRD or recorded as open.

- Anyone who holds a project key and a customer's email can read that customer's threads. V1 serves trusted internal clients.
- The project key is visible in client frontend code. It identifies a project and is not a secret.
- The watcher credential raises the bar against an interactive session being steered to `/mcp/laptop`. It is not a second factor. The operating system is the remaining boundary.
- Watcher credentials do not expire. Logout revokes one.
- A managed plugin policy can change what the headless `claude -p` context loads. The runner verifies the init event and kills the child on a foreign tool, but it cannot prove the managed settings of every laptop.
- T14 is not verified. A Claude artifact that loads the widget from a public CDN and calls a public API needs the published bundle and a public API.
- The reply loop has the Linear channel only. Slack, email, and Claude Code channels, the CC list sends, and V2 analytics are outside V1.
- Aurora Serverless v2 keeps one writer and one reader. A regional outage needs a restore from backup.
- The first request on an idle channel waits up to 60 seconds before the cloud claims it.
