import { runExtractorIsolated, type SandboxOptions } from "./extract-sandbox";
import { makeDocx, makePdf } from "./testing/files";

const MARKER = "selftest-marker-4711";
const SELF_TEST_TIMEOUT_MS = 15_000;

const FIXTURES = [
  { format: "pdf", bytes: () => makePdf([MARKER]) },
  { format: "docx", bytes: () => makeDocx([MARKER]) },
] as const;

export async function runExtractionSelfTest(
  options: SandboxOptions = {},
): Promise<void> {
  for (const fixture of FIXTURES) {
    const result = await runExtractorIsolated(
      {
        format: fixture.format,
        bytes: fixture.bytes(),
        maxChars: 1_000,
        maxPdfPages: 2,
      },
      { timeoutMs: SELF_TEST_TIMEOUT_MS, ...options },
    );
    if (!result.ok) {
      throw new Error(
        `extraction self-test failed for ${fixture.format}: ${result.reason}${result.error ? ` (${result.error})` : ""}`,
      );
    }
    if (!result.text.includes(MARKER)) {
      throw new Error(
        `extraction self-test returned wrong text for ${fixture.format}`,
      );
    }
  }
}
