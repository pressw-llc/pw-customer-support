import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { hydrateDatabaseEnv } from "./db-secret";

let ready: Promise<void> | undefined;

function hydrate(): Promise<void> {
  const client = new SecretsManagerClient({});
  return hydrateDatabaseEnv(process.env, async (secretId) => {
    const result = await client.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    return result.SecretString;
  });
}

export const handler = async (
  event: unknown,
  context: unknown,
  callback: unknown,
) => {
  ready ??= hydrate().catch((error) => {
    ready = undefined;
    throw error;
  });
  await ready;
  const { handler: deliver } = await import("./deliver");
  return (deliver as (...args: unknown[]) => Promise<unknown>)(
    event,
    context,
    callback,
  );
};
