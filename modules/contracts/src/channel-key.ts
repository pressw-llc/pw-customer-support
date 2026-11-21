import { z } from "zod";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SEPARATOR = ":";
const MAX_SEGMENTS = 3;

export const channelKeySchema = z.string().refine(
  (key) => {
    const segments = key.split(SEPARATOR);
    return (
      segments.length <= MAX_SEGMENTS &&
      segments.every((segment) => SEGMENT.test(segment))
    );
  },
  { message: "Channel key must be client[:project[:user]]" },
);

export interface ChannelKeyParts {
  client: string;
  project?: string;
  user?: string;
}

export function parseChannelKey(key: string): ChannelKeyParts {
  channelKeySchema.parse(key);
  const [client, project, user] = key.split(SEPARATOR) as [
    string,
    string | undefined,
    string | undefined,
  ];
  return {
    client,
    ...(project === undefined ? {} : { project }),
    ...(user === undefined ? {} : { user }),
  };
}

export function formatChannelKey(parts: ChannelKeyParts): string {
  if (parts.user !== undefined && parts.project === undefined) {
    throw new Error("A channel key with a user needs a project");
  }
  const key = [parts.client, parts.project, parts.user]
    .filter((segment): segment is string => segment !== undefined)
    .join(SEPARATOR);
  channelKeySchema.parse(key);
  return key;
}

export function channelKeyMatches(
  subscription: string,
  channelKey: string,
): boolean {
  const wanted = parseChannelKey(subscription);
  const actual = parseChannelKey(channelKey);
  return (
    wanted.client === actual.client &&
    (wanted.project === undefined || wanted.project === actual.project) &&
    (wanted.user === undefined || wanted.user === actual.user)
  );
}
