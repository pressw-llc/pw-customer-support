export const LOCAL_STAGE = "local";

export interface ResourceNames {
  stage: string;
  attachmentsBucket: string;
  triageWakeQueue: string;
  triageWakeDlq: string;
  linearAdapterQueue: string;
  linearAdapterDlq: string;
  secretsPrefix: string;
  secretsScope: string;
  databaseSecret: string;
  anthropicSecret: string;
  githubDeployRole: string;
}

export function resourceNames(stage: string = LOCAL_STAGE): ResourceNames {
  const local = stage === LOCAL_STAGE;
  const base = local ? "pw-support" : `pw-support-${stage}`;
  return {
    stage,
    attachmentsBucket: `${base}-attachments`,
    triageWakeQueue: `${base}-triage-wake`,
    triageWakeDlq: `${base}-triage-wake-dlq`,
    linearAdapterQueue: `${base}-adapter-linear`,
    linearAdapterDlq: `${base}-adapter-linear-dlq`,
    secretsPrefix: "pw-support/",
    secretsScope: local ? "global" : stage,
    databaseSecret: `${base}-db/credentials`,
    anthropicSecret: `${base}-anthropic/api-key`,
    githubDeployRole: `${base}-github-deploy`,
  };
}

export function stageFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.SUPPORT_STAGE || LOCAL_STAGE;
}

export const RESOURCE_NAMES = resourceNames(LOCAL_STAGE);

export const TRIAGE_WAKE_MAX_RECEIVES = 5;

export const TRIAGE_WAKE_VISIBILITY_TIMEOUT_SECONDS = 300;
export const LINEAR_ADAPTER_VISIBILITY_TIMEOUT_SECONDS = 60;

export const TICKET_REDELIVERY_BASE_SECONDS = 30;
export const TICKET_REDELIVERY_MAX_SECONDS = 900;

export const MESSAGE_INTAKE_GRACE_SECONDS = 300;
