import { hashCustomerId } from "@pw-support/contracts";

export function computeHashedId(
  email: string,
  projectKey: string,
): Promise<string> {
  return hashCustomerId(email, projectKey);
}
