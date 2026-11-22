export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export function randomToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString(
    "base64url",
  );
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return Buffer.from(digest).toString("base64url");
}

export async function createPkce(): Promise<Pkce> {
  const verifier = randomToken(48);
  return {
    verifier,
    challenge: await challengeFor(verifier),
    state: randomToken(16),
  };
}
