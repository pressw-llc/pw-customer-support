const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i;

export function parseAgentOutput(text: string): unknown {
  const trimmed = text.trim();
  const fenced = FENCE.exec(trimmed);
  const candidate = fenced ? (fenced[1] ?? "") : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    return trimmed;
  }
}
