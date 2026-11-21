import type { JudgmentInput } from "@pw-support/db";
import type { JevClient, JevSubject } from "./jev";

export const INJECTION_KIND = "injection";

export interface FilterSubject {
  subject: string;
  text?: string;
  image?: JevSubject["image"];
}

export interface FilterOptions {
  jev: JevClient | null;
  threshold: number;
  chunkChars: number;
  requestId: string;
}

export interface FilterVerdict {
  flagged: boolean;
  unavailable: boolean;
  judgments: JudgmentInput[];
  error?: string;
}

const CONCURRENCY = 4;

export function chunkText(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += size) {
    chunks.push(text.slice(start, start + size));
  }
  return chunks;
}

interface Unit {
  subject: string;
  chunk: number;
  of: number;
  input: JevSubject;
}

function unitsFor(subjects: FilterSubject[], chunkChars: number): Unit[] {
  return subjects.flatMap<Unit>((entry) => {
    if (entry.image) {
      return [{ subject: entry.subject, chunk: 0, of: 1, input: { image: entry.image } }];
    }
    const chunks = chunkText(entry.text ?? "", chunkChars);
    return chunks.map((text, chunk) => ({
      subject: entry.subject,
      chunk,
      of: chunks.length,
      input: { text },
    }));
  });
}

export async function runInjectionFilter(
  subjects: FilterSubject[],
  options: FilterOptions,
): Promise<FilterVerdict> {
  if (!options.jev) {
    return {
      flagged: false,
      unavailable: true,
      judgments: [],
      error: "no jev client configured",
    };
  }
  const jev = options.jev;
  const units = unitsFor(
    subjects.filter((entry) => entry.image || (entry.text ?? "").trim() !== ""),
    options.chunkChars,
  );
  const judgments: JudgmentInput[] = [];
  let failure: string | undefined;
  let next = 0;
  async function worker(): Promise<void> {
    while (failure === undefined) {
      const index = next++;
      const unit = units[index];
      if (!unit) return;
      try {
        const result = await jev.judgeInjection(unit.input);
        judgments.push({
          requestId: options.requestId,
          kind: INJECTION_KIND,
          subject: unit.subject,
          score: result.score,
          threshold: options.threshold,
          flagged: result.score >= options.threshold,
          raw: { ...result.raw, chunk: unit.chunk, of: unit.of },
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, units.length) }, worker),
  );
  if (failure !== undefined) {
    return { flagged: false, unavailable: true, judgments, error: failure };
  }
  return {
    flagged: judgments.some((judgment) => judgment.flagged),
    unavailable: false,
    judgments,
  };
}
