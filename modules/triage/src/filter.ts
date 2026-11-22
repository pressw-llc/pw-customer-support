import type { JudgmentInput } from "@pw-support/db";
import { type JevClient, JevInputError, type JevSubject } from "./jev";

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
  overlapRatio?: number;
  requestId: string;
}

export interface FilterVerdict {
  flagged: boolean;
  unavailable: boolean;
  judgments: JudgmentInput[];
  error?: string;
}

const CONCURRENCY = 4;

export const CHUNK_OVERLAP_RATIO = 0.12;

export function chunkText(
  text: string,
  size: number,
  overlap = Math.floor(size * CHUNK_OVERLAP_RATIO),
): string[] {
  if (text.length <= size) return [text];
  const step = Math.max(1, size - overlap);
  const chunks: string[] = [];
  for (let start = 0; ; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;
  }
  return chunks;
}

function headAndTail(text: string, size: number): string {
  const half = Math.floor(size / 2);
  return `${text.slice(0, half)}\n${text.slice(-half)}`;
}

interface Unit {
  subject: string;
  chunk: number;
  of: number;
  part?: string;
  input: JevSubject;
}

function unitsFor(
  subjects: FilterSubject[],
  chunkChars: number,
  overlapRatio: number,
): Unit[] {
  return subjects.flatMap<Unit>((entry) => {
    if (entry.image) {
      return [
        {
          subject: entry.subject,
          chunk: 0,
          of: 1,
          input: { image: entry.image },
        },
      ];
    }
    const text = entry.text ?? "";
    const chunks = chunkText(
      text,
      chunkChars,
      Math.floor(chunkChars * overlapRatio),
    );
    const units: Unit[] = chunks.map((piece, chunk) => ({
      subject: entry.subject,
      chunk,
      of: chunks.length,
      input: { text: piece },
    }));
    if (chunks.length > 1 && text.length <= chunkChars * 2) {
      units.push({
        subject: entry.subject,
        chunk: 0,
        of: 1,
        part: "head_tail",
        input: { text: headAndTail(text, chunkChars) },
      });
    }
    return units;
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
    options.overlapRatio ?? CHUNK_OVERLAP_RATIO,
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
          raw: {
            ...result.raw,
            chunk: unit.chunk,
            of: unit.of,
            ...(unit.part ? { part: unit.part } : {}),
          },
        });
      } catch (error) {
        if (error instanceof JevInputError) {
          judgments.push({
            requestId: options.requestId,
            kind: INJECTION_KIND,
            subject: unit.subject,
            score: 0,
            threshold: options.threshold,
            flagged: false,
            raw: { skipped: true, reason: error.message },
          });
          continue;
        }
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
