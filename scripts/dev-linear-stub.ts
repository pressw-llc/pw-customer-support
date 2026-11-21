import { startLinearStub } from "@pw-support/channels";

const port = Number(process.env.LINEAR_STUB_PORT || 4590);
const stub = startLinearStub({ port });
console.log(`[linear-stub] listening on ${stub.url}`);
console.log(
  `[linear-stub] teams ${stub.teams.map((t) => `${t.key}=${t.id}`).join(", ")}`,
);
console.log(
  `[linear-stub] set LINEAR_API_URL=${stub.url} and LINEAR_API_KEY to any value`,
);
