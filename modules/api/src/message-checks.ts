import {
  clip,
  MAX_MESSAGE_CHARS,
  stripMarkup,
  stripMarkupDetailed,
} from "@pw-support/contracts";

export { clip, stripMarkup };

export interface MessageVerdict {
  sanitized: string;
  flagged: boolean;
  reasons: string[];
}

export const MAX_STORED_MESSAGE_CHARS = MAX_MESSAGE_CHARS * 4;
export const MAX_TEXT_FIELD_BYTES = 1024 * 1024;

export function capInboundText(text: string): {
  text: string;
  truncated: boolean;
} {
  const truncated = text.length > MAX_STORED_MESSAGE_CHARS;
  return {
    text: truncated ? clip(text, MAX_STORED_MESSAGE_CHARS) : text,
    truncated,
  };
}

export function checkMessage(
  raw: string,
  options: { truncated?: boolean } = {},
): MessageVerdict {
  const bounded = clip(raw, MAX_STORED_MESSAGE_CHARS);
  const truncated = options.truncated === true || bounded.length < raw.length;
  const { text: stripped, htmlRemoved } = stripMarkupDetailed(bounded);
  const reasons: string[] = [];
  if (htmlRemoved) reasons.push("markup");
  else if (stripped !== bounded) reasons.push("control_chars");
  if (truncated || stripped.length > MAX_MESSAGE_CHARS) {
    reasons.push("too_long");
  }
  return {
    sanitized: clip(stripped, MAX_MESSAGE_CHARS),
    flagged: reasons.length > 0,
    reasons,
  };
}
