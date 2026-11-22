def sub(p, a, b, c=1):
    s = open(p).read()
    assert a in s, (p, a[:70])
    open(p, 'w').write(s.replace(a, b, c))

R = 'scripts/deploy/run.ts'
sub(R, '  const needsImages = !args.oidc && (!args.skipAssets || mode === "deploy");', '  const needsImages =\n    !args.oidc && !args.bootstrap && (!args.skipAssets || mode === "deploy");')
sub(R, '    if (!args.oidc && !args.skipSmoke) {', '    if (!args.oidc && !args.bootstrap && !args.skipSmoke) {')
sub(R, '''  const cdk = (...extra: string[]) => [
    "bunx",
    "cdk",
    ...extra,''', '''  const qualifier = resourceNames(args.stage).bootstrapQualifier;
  const cdk = (...extra: string[]) => [
    "bunx",
    "cdk",
    ...extra,
    ...(extra[0] === "deploy" || extra[0] === "diff"
      ? ["--toolkit-stack-name", `CDKToolkit-${qualifier}`]
      : []),''')
sub(R, '''  if (!(await step("build admin and widget", ["bun", "run", "build"]))) return 1;
''', '''  if (args.bootstrap) {
    const outputs = await deps.stackOutputs(stacks.oidc).catch(() => ({}));
    const policies = Object.entries(outputs).find(([key]) =>
      key.includes("CloudFormationExecutionPolicies"),
    )?.[1];
    if (!policies) {
      deps.error(
        `[deploy] FAIL the ${stacks.oidc} stack has no execution policies; run --oidc first`,
      );
      return 1;
    }
    return (await step(
      "bootstrap the stage",
      [
        "bunx",
        "cdk",
        "bootstrap",
        `aws://${config.account}/us-east-1`,
        "--qualifier",
        qualifier,
        "--toolkit-stack-name",
        `CDKToolkit-${qualifier}`,
        "--cloudformation-execution-policies",
        policies,
        "--tags",
        `${resourceNames(args.stage).stageTag}=${args.stage}`,
        "--no-notices",
      ],
      infraDir,
    ))
      ? 0
      : 1;
  }

  if (!(await step("build admin and widget", ["bun", "run", "build"]))) return 1;
''')

M = 'scripts/deploy/main.ts'
sub(M, '''  identityAccount: async () =>
    (
      await new STSClient({ region: REGION }).send(
        new GetCallerIdentityCommand({}),
      )
    ).Account,''', '''  identity: async () => {
    const who = await new STSClient({ region: REGION }).send(
      new GetCallerIdentityCommand({}),
    );
    return { account: who.Account, arn: who.Arn };
  },
  bootstrapVersion: async (qualifier) => {
    try {
      const parameter = await new SSMClient({ region: REGION }).send(
        new GetParameterCommand({
          Name: `/cdk-bootstrap/${qualifier}/version`,
        }),
      );
      const version = Number(parameter.Parameter?.Value);
      return Number.isFinite(version) ? version : undefined;
    } catch {
      return undefined;
    }
  },''')
sub(M, 'import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";', 'import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";\nimport { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";')
