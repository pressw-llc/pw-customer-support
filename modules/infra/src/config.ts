export const AWS_REGION = "us-east-1";
export const STAGES = ["production", "staging"] as const;
export type StageName = (typeof STAGES)[number];

export const GITHUB_REPOSITORY = "pressw-llc/pw-customer-support";

export interface StageConfig {
  stage: StageName;
  account: string;
  region: typeof AWS_REGION;
  cognitoIssuer: string;
  adminClientId: string;
  mcpClientId: string;
  mcpRequiredGroup: string;
  adminRequiredGroup: string;
  adminAllowedEmailDomains: string[];
  certificateArn: string | undefined;
  apiDomain: string | undefined;
  triageAgentId: string;
  adminLogoutUrl: string | undefined;
  extraAdminOrigins: string[];
  alarmEmail: string | undefined;
  placeholders: string[];
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `stage configuration is incomplete:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`,
    );
    this.name = "ConfigError";
  }
}

export type RawValues = Record<string, unknown>;

export const CONFIG_KEYS = [
  "account",
  "cognitoIssuer",
  "adminClientId",
  "mcpClientId",
  "mcpRequiredGroup",
  "adminRequiredGroup",
  "adminAllowedEmailDomains",
  "certificateArn",
  "apiDomain",
  "triageAgentId",
  "adminLogoutUrl",
  "extraAdminOrigins",
  "alarmEmail",
] as const;

const GROUP_HINTS: Partial<Record<keyof typeof PLACEHOLDERS, string>> = {
  mcpRequiredGroup: "set the Cognito group that may use /mcp",
  adminRequiredGroup: "set the Cognito group that may use /admin",
};

const FORBIDDEN_IN_PRODUCTION = ["linearApiUrl"] as const;

const PLACEHOLDERS = {
  account: "000000000000",
  cognitoIssuer:
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_PLACEHOLDER",
  adminClientId: "placeholder-admin-client-id",
  mcpClientId: "placeholder-mcp-client-id",
  mcpRequiredGroup: "placeholder-staff-group",
  adminRequiredGroup: "placeholder-admin-group",
  certificateArn:
    "arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000",
  apiDomain: "support-api.example.invalid",
  triageAgentId: "agent_placeholder",
} as const;

function text(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value.trim() : undefined;
}

function list(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(String) : [text(value) ?? ""];
  return raw
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

export function isStageName(value: string): value is StageName {
  return (STAGES as readonly string[]).includes(value);
}

export interface ResolveInput {
  stage: StageName;
  values: RawValues;
  placeholders: boolean;
}

export function resolveStageConfig(input: ResolveInput): StageConfig {
  const { stage, values } = input;
  const production = stage === "production";
  const problems: string[] = [];
  const used: string[] = [];

  const need = (
    key: keyof typeof PLACEHOLDERS,
    hint: string,
    required = true,
  ): string | undefined => {
    const given = text(values[key]);
    if (given !== undefined && given !== "") return given;
    if (given === "" && GROUP_HINTS[key] && production) {
      problems.push(
        `${key} must not be empty in production; ${GROUP_HINTS[key]}`,
      );
      return "";
    }
    if (!required) return undefined;
    if (input.placeholders) {
      used.push(key);
      return PLACEHOLDERS[key];
    }
    problems.push(`${key} is required: ${hint}`);
    return undefined;
  };

  for (const key of FORBIDDEN_IN_PRODUCTION) {
    if (production && text(values[key])) {
      problems.push(`${key} cannot be set in production`);
    }
  }

  const account = need(
    "account",
    "the 12 digit id of the dedicated AWS account",
  );
  if (account && !/^\d{12}$/.test(account)) {
    problems.push("account must be 12 digits");
  }
  const cognitoIssuer = need(
    "cognitoIssuer",
    "the issuer URL of the telemetry Cognito pool",
  );
  if (cognitoIssuer && !/^https:\/\/\S+$/.test(cognitoIssuer)) {
    problems.push("cognitoIssuer must be an https URL");
  }
  const adminClientId = need(
    "adminClientId",
    "the Cognito app client id for the admin site",
  );
  const mcpClientId = need(
    "mcpClientId",
    "the Cognito app client id for the plugin and MCP",
  );
  const mcpRequiredGroup = need(
    "mcpRequiredGroup",
    "the Cognito group allowed on /mcp",
    production,
  );
  const adminRequiredGroup = need(
    "adminRequiredGroup",
    "the Cognito group allowed on /admin",
  );
  const adminAllowedEmailDomains = list(values.adminAllowedEmailDomains).map(
    (domain) => domain.toLowerCase(),
  );
  const certificateArn = need(
    "certificateArn",
    "the ACM certificate ARN in us-east-1 for the API domain",
    production,
  );
  if (
    certificateArn &&
    !/^arn:aws:acm:us-east-1:\d{12}:certificate\//.test(certificateArn)
  ) {
    problems.push("certificateArn must be an ACM certificate ARN in us-east-1");
  }
  const apiDomain = need(
    "apiDomain",
    "the public host name of the API, for example support-api.example.com",
    production,
  );
  const triageAgentId = need(
    "triageAgentId",
    "the id that `bun run agent:sync` prints",
    production,
  );

  const adminLogoutUrl = text(values.adminLogoutUrl) || undefined;
  if (adminLogoutUrl && !/^https:\/\//.test(adminLogoutUrl)) {
    problems.push("adminLogoutUrl must be an https URL");
  }
  const extraAdminOrigins = list(values.extraAdminOrigins);
  for (const origin of extraAdminOrigins) {
    if (!/^https:\/\/[^/\s]+$/.test(origin)) {
      problems.push(`admin origin ${origin} must be https with no path`);
    }
  }
  const alarmEmail = text(values.alarmEmail) || undefined;

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    stage,
    account: account as string,
    region: AWS_REGION,
    cognitoIssuer: cognitoIssuer as string,
    adminClientId: adminClientId as string,
    mcpClientId: mcpClientId as string,
    mcpRequiredGroup: mcpRequiredGroup ?? "",
    adminRequiredGroup: adminRequiredGroup ?? "",
    adminAllowedEmailDomains,
    certificateArn,
    apiDomain,
    triageAgentId: triageAgentId ?? "",
    adminLogoutUrl,
    extraAdminOrigins,
    alarmEmail,
    placeholders: used,
  };
}

export function stageValuesFrom(
  readContext: (key: string) => unknown,
  fileValues: RawValues = {},
): RawValues {
  const values: RawValues = { ...fileValues };
  for (const key of [...CONFIG_KEYS, ...FORBIDDEN_IN_PRODUCTION]) {
    const fromContext = readContext(key);
    if (fromContext !== undefined) values[key] = fromContext;
  }
  return values;
}
