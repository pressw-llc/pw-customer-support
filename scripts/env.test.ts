import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeKeys,
  ensureKey,
  formatValue,
  isSecretName,
  main,
  missingKeys,
  parseEnv,
  removeKey,
  syncLocal,
  upsertKey,
} from "./env";

const SECRET = "sk-test-very-secret-value";

const VALUES = [
  "plain",
  "hello$A",
  `a $A $${"{"}B} #c`,
  'say "hi" it\'s $A',
  "p\\qr",
  "a\\nb",
  "\\$A",
  "cost $5 and $",
  "  padded  ",
  "x\\\\y",
];

let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "env-test-"));
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], stdin = ""): Promise<number> {
  return main([...args, "--dir", dir], {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readStdin: async () => stdin,
  });
}

const example = () => readFileSync(join(dir, ".env.example"), "utf8");
const local = () => readFileSync(join(dir, ".env.local"), "utf8");

describe("parse and format", () => {
  test("parses plain, quoted, exported, and commented lines", () => {
    const entries = parseEnv(
      [
        "# note",
        "A=1",
        'B="two words"',
        "C='single'",
        "export D=4 # trailing",
        "# E=skipped",
        "",
        "F=",
        'G="a \\$A b"',
        'H="unterminated',
      ].join("\n"),
    );
    expect(entries.map((e) => [e.key, e.value])).toEqual([
      ["A", "1"],
      ["B", "two words"],
      ["C", "single"],
      ["D", "4"],
      ["F", ""],
      ["G", "a $A b"],
      ["H", '"unterminated'],
    ]);
  });

  test("quotes values that need quoting and rejects bad values", () => {
    expect(formatValue("plain")).toBe("plain");
    expect(formatValue("")).toBe("");
    expect(formatValue("a b")).toBe("'a b'");
    expect(formatValue("a#b")).toBe("'a#b'");
    expect(formatValue('say "hi"')).toBe("'say \"hi\"'");
    expect(formatValue("hello$A")).toBe("'hello\\$A'");
    expect(formatValue("cost $5")).toBe("'cost \\$5'");
    expect(formatValue("a $ b")).toBe("'a $ b'");
    expect(() => formatValue("a\nb")).toThrow("newlines");
    expect(() => formatValue("a\\")).toThrow("backslash");
  });

  test("round trips values through the serializer and parser", () => {
    for (const value of VALUES) {
      const text = upsertKey("", "K", value);
      expect(parseEnv(text)[0]?.value).toBe(value);
    }
  });
});

describe("bun dotenv loader", () => {
  test("reads serialized values back literally", async () => {
    for (const value of VALUES) {
      const loaderDir = mkdtempSync(join(tmpdir(), "env-loader-"));
      try {
        const text = upsertKey(
          upsertKey("A=EXPANDED\nB=EXP\n", "TOKEN", value),
          "LAST",
          "1",
        );
        writeFileSync(join(loaderDir, ".env.local"), text);
        const proc = Bun.spawnSync(
          ["bun", "-e", "console.log(JSON.stringify(process.env.TOKEN))"],
          {
            cwd: loaderDir,
            env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          },
        );
        expect(JSON.parse(proc.stdout.toString().trim())).toBe(value);
      } finally {
        rmSync(loaderDir, { recursive: true, force: true });
      }
    }
  });
});

describe("upsert, ensure, remove", () => {
  test("appends a new key and an attached comment", () => {
    const text = upsertKey("A=1\n", "B", "2", { comment: "# the b" });
    expect(text).toBe("A=1\n# the b\nB=2\n");
  });

  test("replaces in place and preserves comments and order", () => {
    const base = "# first\nA=1\n\n# second\nB=2\nC=3\n";
    expect(upsertKey(base, "B", "9")).toBe(
      "# first\nA=1\n\n# second\nB=9\nC=3\n",
    );
  });

  test("replaces or inserts the attached comment", () => {
    const base = "# old\nA=1\nB=2\n";
    expect(upsertKey(base, "A", "1", { comment: "new" })).toBe(
      "# new\nA=1\nB=2\n",
    );
    expect(upsertKey(base, "B", "2", { comment: "b note\nmore" })).toBe(
      "# old\nA=1\n# b note more\nB=2\n",
    );
  });

  test("rejects an invalid key", () => {
    expect(() => upsertKey("", "bad-key", "1")).toThrow("invalid key");
    expect(() => upsertKey("", "1BAD", "1")).toThrow("invalid key");
    expect(() => removeKey("", "lower")).toThrow("invalid key");
  });

  test("ensureKey keeps an existing value and adds a blank", () => {
    expect(ensureKey("A=1\n", "A")).toBe("A=1\n");
    expect(ensureKey("A=1\n", "B")).toBe("A=1\nB=\n");
    expect(ensureKey("A=1\n", "A", "note")).toBe("# note\nA=1\n");
  });

  test("removes a key with its comment and ignores a missing key", () => {
    const base = "# keep\nA=1\n# gone\nB=2\nC=3\n";
    expect(removeKey(base, "B")).toBe("# keep\nA=1\nC=3\n");
    expect(removeKey("A=1\nB=2\n", "B")).toBe("A=1\n");
    expect(removeKey(base, "Z")).toBe(base);
    expect(removeKey("A=1\n", "A")).toBe("");
  });
});

describe("sync and describe", () => {
  test("adds only missing keys and never overwrites", () => {
    const merged = syncLocal("A=1\nB=2\nC=\n", "A=mine\n");
    expect(merged).toBe("A=mine\nB=2\nC=\n");
    expect(missingKeys("A=1\nB=2\n", "A=x\n")).toEqual(["B"]);
  });

  test("describes the union of both files without values", () => {
    const lines = describeKeys("A=1\nB=\nC=3\nD=4\n", "A=x\nB=\nC=\nE=5\n");
    expect(lines).toEqual([
      "A example: default local: set",
      "B example: blank local: blank",
      "C example: default local: blank",
      "D example: default local: missing",
      "E example: missing local: set",
    ]);
    expect(describeKeys("A=1\n", null)).toEqual([
      "A example: default local: missing",
    ]);
    expect(describeKeys(null, "L=1\n")).toEqual([
      "L example: missing local: set",
    ]);
    expect(describeKeys(null, null)).toEqual([]);
  });
});

describe("cli", () => {
  test("a secret key lands blank in the example and valued in local", async () => {
    expect(await run(["set", `API_KEY=${SECRET}`, "--secret"])).toBe(0);
    expect(example()).toBe("API_KEY=\n");
    expect(local()).toBe(`API_KEY=${SECRET}\n`);
    expect(out.join("\n") + err.join("\n")).not.toContain(SECRET);
  });

  test("a non-secret key lands valued in both files", async () => {
    await run(["set", "PORT=8787", "--comment", "API port"]);
    expect(example()).toBe("# API port\nPORT=8787\n");
    expect(local()).toBe("PORT=8787\n");
  });

  test("local file has mode 0600", async () => {
    await run(["set", "PORT=1"]);
    expect(statSync(join(dir, ".env.local")).mode & 0o777).toBe(0o600);
  });

  test("reads the value from stdin and trims one trailing newline", async () => {
    await run(["set", "NAME", "--stdin"], "value\r\n");
    expect(local()).toBe("NAME=value\n");
    expect(await run(["set", "NAME", "--stdin"], "value\n\n")).toBe(1);
  });

  test("stdin value never reaches output", async () => {
    await run(["set", "TOKEN", "--secret", "--stdin"], `${SECRET}\n`);
    expect(local()).toBe(`TOKEN=${SECRET}\n`);
    expect(example()).toBe("TOKEN=\n");
    expect(out.join("\n") + err.join("\n")).not.toContain(SECRET);
  });

  test("set with no value adds a blank key to both files", async () => {
    await run(["set", "EMPTY"]);
    expect(example()).toBe("EMPTY=\n");
    expect(local()).toBe("EMPTY=\n");
    await run(["set", "EMPTY=kept"]);
    await run(["set", "EMPTY"]);
    expect(local()).toBe("EMPTY=kept\n");
  });

  test("--example-only and --local-only write one file", async () => {
    await run(["set", "A=1", "--example-only"]);
    expect(existsSync(join(dir, ".env.local"))).toBe(false);
    await run(["set", "B=2", "--local-only"]);
    expect(example()).toBe("A=1\n");
    expect(local()).toBe("B=2\n");
  });

  test("rejects conflicting flags, bad keys, and bad values", async () => {
    expect(await run(["set", "A=1", "--example-only", "--local-only"])).toBe(1);
    expect(await run(["unset", "A", "--example-only", "--local-only"])).toBe(1);
    expect(await run(["set", "lower=1"])).toBe(1);
    expect(err.join("\n")).toContain("invalid key");
    expect(await run(["set", "A=line\nbreak"])).toBe(1);
    expect(await run(["set"])).toBe(1);
    expect(await run(["unset"])).toBe(1);
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
  });

  test("an invalid value error never echoes the value", async () => {
    err.length = 0;
    await run(["set", `A=${SECRET}\n${SECRET}`]);
    expect(err.join("\n")).not.toContain(SECRET);
  });

  test("a missing flag value is an error", async () => {
    expect(await main(["set", "A=1", "--comment"], cliIo())).toBe(1);
    expect(await main(["set", "A=1", "--dir"], cliIo())).toBe(1);
  });

  test("sync creates local from the example and keeps local values", async () => {
    writeFileSync(join(dir, ".env.example"), "# c\nA=1\nB=\n");
    expect(await run(["sync"])).toBe(0);
    expect(local()).toBe("A=1\nB=\n");
    writeFileSync(join(dir, ".env.local"), "A=mine\n");
    await run(["sync"]);
    expect(local()).toBe("A=mine\nB=\n");
    out.length = 0;
    await run(["sync"]);
    expect(out).toEqual([".env.local is up to date"]);
  });

  test("sync fails without an example", async () => {
    expect(await run(["sync"])).toBe(1);
    expect(err[0]).toContain("missing");
  });

  test("unset removes keys from both files", async () => {
    await run(["set", "A=1", "--comment", "note"]);
    await run(["set", "B=2"]);
    expect(await run(["unset", "A"])).toBe(0);
    expect(example()).toBe("B=2\n");
    expect(local()).toBe("B=2\n");
    await run(["unset", "B", "--example-only"]);
    expect(example()).toBe("");
    expect(local()).toBe("B=2\n");
    await run(["unset", "B", "--local-only"]);
    expect(local()).toBe("");
    out.length = 0;
    await run(["unset", "B"]);
    expect(out).toEqual(["B not found"]);
  });

  test("list prints states and no values", async () => {
    await run(["set", `S=${SECRET}`, "--secret"]);
    await run(["set", "P=8787", "--example-only"]);
    out.length = 0;
    expect(await run(["list"])).toBe(0);
    expect(out).toEqual([
      "S example: blank local: set",
      "P example: default local: missing",
    ]);
    expect(out.join("\n")).not.toContain(SECRET);
  });

  test("list includes local-only keys and works without a template", async () => {
    await run(["set", "L=1", "--local-only"]);
    out.length = 0;
    expect(await run(["list"])).toBe(0);
    expect(out).toEqual(["L example: missing local: set"]);
  });

  test("check fails without an example", async () => {
    expect(await run(["check"])).toBe(1);
  });

  test("a mistyped flag writes nothing and never echoes the value", async () => {
    for (const flag of ["--secreet", "--secrets", "--secret=oops", "-s"]) {
      err.length = 0;
      const code = await run(
        ["set", "LINEAR_API_KEY", "--stdin", flag],
        "fake-key\n",
      );
      expect(code).toBe(1);
      expect(err.join("\n")).toContain(flag.split("=")[0] as string);
      expect(err.join("\n")).not.toContain("fake-key");
      expect(err.join("\n")).not.toContain("oops");
      expect(existsSync(join(dir, ".env.example"))).toBe(false);
      expect(existsSync(join(dir, ".env.local"))).toBe(false);
    }
  });

  test("a mistyped flag leaves existing files unchanged", async () => {
    await run(["set", "KEEP=1"]);
    const before = [example(), local()];
    expect(
      await run(["set", "KEEP=2", "--secreet", "--local-only"], "fake-key\n"),
    ).toBe(1);
    expect(await run(["unset", "KEEP", "--bogus"])).toBe(1);
    expect(await run(["sync", "--force"])).toBe(1);
    expect(await run(["list", "--verbose"])).toBe(1);
    expect(await run(["check", "--fix"])).toBe(1);
    expect([example(), local()]).toEqual(before);
  });

  test("rejects extra positionals without echoing them", async () => {
    expect(await run(["set", "KEY", "fake-key"])).toBe(1);
    expect(await run(["sync", "extra"])).toBe(1);
    expect(err.join("\n")).not.toContain("fake-key");
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
  });

  test("rejects =VALUE together with --stdin", async () => {
    expect(await run(["set", "KEY=a", "--stdin"], "b\n")).toBe(1);
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
  });

  test("writes values with a dollar sign literally", async () => {
    await run(["set", "TOKEN=hello$A", "--secret"]);
    expect(local()).toBe("TOKEN='hello\\$A'\n");
    expect(example()).toBe("TOKEN=\n");
  });

  test("check passes with no local, fails on missing keys", async () => {
    await run(["set", "A=1", "--example-only"]);
    expect(await run(["check"])).toBe(0);
    writeFileSync(join(dir, ".env.local"), "B=2\n");
    expect(await run(["check"])).toBe(1);
    expect(err.join("\n")).toContain("A");
    await run(["sync"]);
    expect(await run(["check"])).toBe(0);
  });

  test("an unknown command prints usage", async () => {
    expect(await run(["bogus"])).toBe(2);
    expect(err[0]).toContain("usage");
  });
});

const FAKE = "FAKE-SECRET-123";

const REJECTED: [string, string[]][] = [
  [
    "comment swallows --secret",
    ["set", "LINEAR_API_KEY", "--stdin", "--comment", "--secret"],
  ],
  ["comment missing at the end", ["set", "K", "--stdin", "--comment"]],
  [
    "comment value starts with a dash",
    ["set", "K", "--stdin", "--comment", "--dir"],
  ],
  ["comment value is a short flag", ["set", "K", "--stdin", "--comment", "-s"]],
  [
    "comment swallows --not-secret",
    ["set", "K", "--stdin", "--comment", "--not-secret"],
  ],
  ["empty comment", ["set", "K", "--stdin", "--comment="]],
  ["dir missing", ["set", "K", "--stdin", "--dir"]],
  ["empty dir", ["set", "K", "--stdin", "--dir="]],
  ["duplicate boolean flag", ["set", "K", "--stdin", "--secret", "--secret"]],
  ["duplicate stdin", ["set", "K", "--stdin", "--stdin"]],
  ["duplicate comment", ["set", "K", "--stdin", "--comment=a", "--comment=b"]],
  [
    "duplicate comment forms",
    ["set", "K", "--stdin", "--comment=a", "--comment", "b"],
  ],
  ["inline value with stdin", ["set", "K=inline", "--stdin"]],
  [
    "example-only with local-only",
    ["set", "K", "--stdin", "--example-only", "--local-only"],
  ],
  [
    "secret with not-secret",
    ["set", "K", "--stdin", "--secret", "--not-secret"],
  ],
  [
    "comment with local-only",
    ["set", "K", "--stdin", "--comment=x", "--local-only"],
  ],
  ["value on a boolean flag", ["set", "K", "--stdin", "--secret=1"]],
  ["value on stdin flag", ["set", "K", "--stdin=true"]],
  ["value on not-secret flag", ["set", "K", "--stdin", "--not-secret=0"]],
  ["end-of-options marker", ["set", "K", "--stdin", "--"]],
  ["lone dash", ["set", "K", "--stdin", "-"]],
  ["short flag", ["set", "K", "--stdin", "-s"]],
  ["typo --secreet", ["set", "K", "--stdin", "--secreet"]],
  ["typo --secrets", ["set", "K", "--stdin", "--secrets"]],
  ["typo --not-secrets", ["set", "K", "--stdin", "--not-secrets"]],
  ["extra positional", ["set", "K", FAKE]],
  ["extra positional after stdin", ["set", "K", "--stdin", "extra"]],
  ["missing key", ["set", "--stdin"]],
  ["lowercase key", ["set", "key", "--stdin"]],
  ["bad key with value", ["set", `bad-key=${FAKE}`]],
  ["flag from another command", ["set", "K", "--stdin", "--force"]],
  ["uppercase command", ["SET", "K", "--stdin"]],
];

const ACCEPTED: [string, string[], string][] = [
  [
    "secret-named key with inline value",
    ["set", `LINEAR_API_KEY=${FAKE}`],
    "LINEAR_API_KEY",
  ],
  [
    "secret-named key with --not-secret absent and stdin",
    ["set", "LINEAR_WEBHOOK_SECRET", "--stdin"],
    "LINEAR_WEBHOOK_SECRET",
  ],
  ["key name without a separator", ["set", `APIKEY=${FAKE}`], "APIKEY"],
  ["password key", ["set", `DB_PASSWORD=${FAKE}`], "DB_PASSWORD"],
  ["private key", ["set", `SIGNING_PRIVATE=${FAKE}`], "SIGNING_PRIVATE"],
  ["credential key", ["set", `CREDENTIALS_JSON=${FAKE}`], "CREDENTIALS_JSON"],
  ["plain key from stdin", ["set", "PLAIN", "--stdin"], "PLAIN"],
  ["plain key with --secret", ["set", `PLAIN=${FAKE}`, "--secret"], "PLAIN"],
  [
    "stdin with a comment",
    ["set", "PLAIN", "--stdin", "--comment=note"],
    "PLAIN",
  ],
  [
    "comment that looks like a flag",
    ["set", "PLAIN", "--stdin", "--comment=--secret"],
    "PLAIN",
  ],
  [
    "stdin with example-only",
    ["set", "PLAIN", "--stdin", "--example-only"],
    "PLAIN",
  ],
  [
    "secret-named key example-only",
    ["set", `X_TOKEN=${FAKE}`, "--example-only"],
    "X_TOKEN",
  ],
  [
    "secret flag order reversed",
    ["set", "--secret", "--stdin", "PLAIN"],
    "PLAIN",
  ],
];

describe("adversarial argv", () => {
  test.each(REJECTED)("rejects: %s", async (_name, argv) => {
    const code = await run(argv, `${FAKE}\n`);
    expect(code).not.toBe(0);
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
    expect(existsSync(join(dir, ".env.local"))).toBe(false);
    expect(err.join("\n")).not.toContain(FAKE);
    expect(out.join("\n")).not.toContain(FAKE);
  });

  test.each(ACCEPTED)(
    "keeps the secret out of the example: %s",
    async (_name, argv, key) => {
      expect(await run(argv, `${FAKE}\n`)).toBe(0);
      if (existsSync(join(dir, ".env.example"))) {
        expect(example()).not.toContain(FAKE);
        expect(example()).toContain(`${key}=\n`);
      }
      expect(out.join("\n") + err.join("\n")).not.toContain(FAKE);
    },
  );

  test("a secret-named key stays blank in the example when it already had a value", async () => {
    await run(["set", "X_API_KEY=old", "--not-secret", "--example-only"]);
    expect(example()).toBe("X_API_KEY=old\n");
    await run(["set", "X_API_KEY"]);
    expect(example()).toBe("X_API_KEY=\n");
  });

  test("a secret-named key still reaches .env.local", async () => {
    await run(["set", `LINEAR_API_KEY=${FAKE}`]);
    expect(local()).toBe(`LINEAR_API_KEY=${FAKE}\n`);
  });

  test("--not-secret writes the value to the example for a secret-named key", async () => {
    await run(["set", "AWS_ACCESS_KEY_ID=test", "--not-secret"]);
    expect(example()).toBe("AWS_ACCESS_KEY_ID=test\n");
  });

  test("--not-secret is the only way stdin reaches the example", async () => {
    await run(["set", "PLAIN", "--stdin", "--not-secret"], "shown\n");
    expect(example()).toBe("PLAIN=shown\n");
  });

  test("the --flag=value form works for value flags", async () => {
    await run(["set", "PLAIN=1", "--comment=a note"]);
    expect(example()).toBe("# a note\nPLAIN=1\n");
  });

  test("empty stdin is rejected before any write", async () => {
    expect(await run(["set", "PLAIN", "--stdin"], "")).toBe(1);
    expect(await run(["set", "PLAIN", "--stdin"], "\n")).toBe(1);
    expect(existsSync(join(dir, ".env.example"))).toBe(false);
  });

  test("isSecretName matches the documented words", () => {
    for (const key of [
      "A_KEY",
      "B_SECRET",
      "TOKEN",
      "P_PASSWORD",
      "PRIVATE_X",
      "CREDENTIAL",
    ]) {
      expect(isSecretName(key)).toBe(true);
    }
    expect(isSecretName("API_PORT")).toBe(false);
  });
});

function cliIo() {
  return {
    stdout: () => {},
    stderr: () => {},
    readStdin: async () => "",
  };
}
