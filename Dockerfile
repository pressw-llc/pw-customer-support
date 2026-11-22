# Production image for apps/server. One build, four targets:
#   api      the Hono API (default)
#   worker   triage worker, sweeper, and dispatcher
#   migrate  one-off database migration
#   lambda   the linear-outbound pipeline step for AWS Lambda
#
#   docker build --secret id=github_token,env=GITHUB_TOKEN --target api -t pw-support-api .
#
# The registry token reads @pressw-llc packages at build time and never enters a layer.
FROM oven/bun:1.3.14-slim AS runtime
# The base image lags Debian security updates, so each build takes them.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
# The RDS CA bundle lets the database client verify the server certificate.
# Source: https://truststore.pki.rds.amazonaws.com. A new bundle changes the checksum and fails the build until it is updated here.
ADD --chmod=0644 --checksum=sha256:b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77 \
    https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem /etc/ssl/rds/us-east-1-bundle.pem
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock .npmrc ./
COPY apps/server/package.json apps/server/
COPY modules/admin/package.json modules/admin/
COPY modules/api/package.json modules/api/
COPY modules/channels/package.json modules/channels/
COPY modules/contracts/package.json modules/contracts/
COPY modules/db/package.json modules/db/
COPY modules/infra/package.json modules/infra/
COPY modules/plugin/package.json modules/plugin/
COPY modules/triage/package.json modules/triage/
COPY modules/widget/package.json modules/widget/
COPY examples/host-app/package.json examples/host-app/
COPY e2e/package.json e2e/
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" \
    bun install --frozen-lockfile --production --linker hoisted --filter @pw-support/server \
    && rm -f .npmrc
COPY tsconfig.base.json ./
COPY apps/server ./apps/server
COPY modules/api ./modules/api
COPY modules/channels ./modules/channels
COPY modules/contracts ./modules/contracts
COPY modules/db ./modules/db
COPY modules/triage ./modules/triage
COPY pipelines ./pipelines
COPY scripts/db-migrate.ts ./scripts/db-migrate.ts
USER bun

FROM runtime AS api
ENV API_PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD bun -e "fetch('http://127.0.0.1:8787/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "apps/server/src/server.ts"]

FROM runtime AS worker
CMD ["bun", "pipelines/support-triage/fargate-entries/production.ts"]

FROM runtime AS migrate
CMD ["bun", "scripts/db-migrate.ts"]

FROM runtime AS lambda-bundle
USER root
RUN bun build pipelines/linear-outbound/lambda-entries/production.ts \
    --target node --format esm --outfile /out/index.mjs

FROM public.ecr.aws/lambda/nodejs:22 AS lambda
COPY --from=lambda-bundle /out/index.mjs ${LAMBDA_TASK_ROOT}/index.mjs
COPY --from=lambda-bundle /etc/ssl/rds/us-east-1-bundle.pem ${LAMBDA_TASK_ROOT}/rds-ca.pem
CMD ["index.handler"]
