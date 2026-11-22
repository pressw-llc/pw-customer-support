import { WORDING_MAX_SCORE } from "@pw-support/contracts";
import { z } from "zod";

export const WORDING_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const WORDING_MODEL = "jev-latest";
export const WORDING_QUESTION_VERSION = "fit-to-send-v1";

export const WORDING_QUESTION = {
  type: "noul",
  instructions:
    "The `content` is a reply that a support engineer wrote to send to a customer. Is it fit to send to the customer as written? It must be professional, clear, and helpful. It must keep out internal details such as internal names, systems, credentials, or blame. It must have no hostility, sarcasm, or dismissiveness.",
  criteria: {
    true: "Professional, courteous, clear, and safe to send to a customer.",
    false: "Rude, hostile, dismissive, unclear, or discloses internal details.",
  },
} as const;

export interface WordingScore {
  score: number;
  raw: Record<string, unknown>;
}

export interface WordingScorer {
  score(text: string): Promise<WordingScore>;
}

const answerSchema = z.object({
  model: z.string().optional(),
  answers: z.object({ wording: z.object({ noul: z.number().min(0).max(1) }) }),
  usage: z.record(z.unknown()).optional(),
});

export interface JevWordingOptions {
  apiKey: string;
  timeoutMs?: number;
  endpoint?: string;
  fetcher?: typeof fetch;
}

export function createJevWordingScorer(
  options: JevWordingOptions,
): WordingScorer {
  const fetcher = options.fetcher ?? fetch;
  return {
    async score(text) {
      const response = await fetcher(options.endpoint ?? WORDING_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: WORDING_MODEL,
          state: { content: text },
          questions: { wording: WORDING_QUESTION },
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!response.ok) {
        throw new Error(
          `Jev answered ${response.status}: ${(await response.text()).slice(0, 200)}`,
        );
      }
      const parsed = answerSchema.parse(await response.json());
      const noul = parsed.answers.wording.noul;
      return {
        score: noul * WORDING_MAX_SCORE,
        raw: {
          question: WORDING_QUESTION_VERSION,
          model: parsed.model ?? null,
          noul,
          scale: WORDING_MAX_SCORE,
          usage: parsed.usage ?? null,
        },
      };
    },
  };
}
