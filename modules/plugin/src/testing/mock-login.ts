export interface MockLogin {
  username: string;
  claims?: Record<string, unknown>;
}

export async function completeMockLogin(
  authorizeUrl: string,
  login: MockLogin,
): Promise<number> {
  const posted = await fetch(authorizeUrl, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: login.username,
      claims: JSON.stringify(login.claims ?? {}),
    }),
  });
  const location = posted.headers.get("location");
  if (!location)
    throw new Error(`mock issuer did not redirect (${posted.status})`);
  return (await fetch(location)).status;
}
