const MAX_PASSES = 5;
const BLOCK_NAMES = ["script", "style"] as const;
const KEPT_CONTROL = new Set([0x09, 0x0a, 0x0d]);
const WHITESPACE = /\s/;

const KNOWN_ELEMENTS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "basefont",
  "bdi",
  "bdo",
  "bgsound",
  "big",
  "blink",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "command",
  "content",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "element",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "image",
  "img",
  "input",
  "ins",
  "isindex",
  "kbd",
  "keygen",
  "label",
  "legend",
  "li",
  "link",
  "listing",
  "main",
  "map",
  "mark",
  "marquee",
  "math",
  "menu",
  "menuitem",
  "meta",
  "meter",
  "multicol",
  "nav",
  "nextid",
  "nobr",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "plaintext",
  "pre",
  "progress",
  "q",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "shadow",
  "slot",
  "small",
  "source",
  "spacer",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
  "xmp",
  "animate",
  "animatemotion",
  "animatetransform",
  "circle",
  "clippath",
  "defs",
  "desc",
  "discard",
  "ellipse",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feconvolvematrix",
  "fediffuselighting",
  "fedisplacementmap",
  "fedistantlight",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "feimage",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "fepointlight",
  "fespecularlighting",
  "fespotlight",
  "fetile",
  "feturbulence",
  "filter",
  "foreignobject",
  "g",
  "hatch",
  "hatchpath",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "mpath",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "set",
  "stop",
  "switch",
  "symbol",
  "text",
  "textpath",
  "tspan",
  "use",
  "view",
  "annotation",
  "maction",
  "maligngroup",
  "malignmark",
  "menclose",
  "merror",
  "mfenced",
  "mfrac",
  "mglyph",
  "mi",
  "mlabeledtr",
  "mlongdiv",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "ms",
  "mscarries",
  "mscarry",
  "msgroup",
  "msline",
  "mspace",
  "msqrt",
  "msrow",
  "mstack",
  "mstyle",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
  "semantics",
]);

export const KNOWN_ELEMENT_NAMES = KNOWN_ELEMENTS;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
  return text.slice(0, end);
}

function dropControlChars(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return KEPT_CONTROL.has(code) || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

function isWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isTagDelimiter(char: string): boolean {
  return char === ">" || char === "/" || WHITESPACE.test(char);
}

function elementNameAt(text: string, index: number): string | null {
  if (!isAsciiLetter(text.charCodeAt(index))) return null;
  let end = index + 1;
  while (end < text.length) {
    const code = text.charCodeAt(end);
    if (!isAsciiLetter(code) && !isAsciiDigit(code)) break;
    end++;
  }
  const next = text.charAt(end);
  if (next === "" || !isTagDelimiter(next)) return null;
  const name = text.slice(index, end).toLowerCase();
  return KNOWN_ELEMENTS.has(name) ? name : null;
}

function tagNameLength(text: string, index: number): number {
  const first = text.charAt(index);
  if (first === "?") return 1;
  if (first === "!") {
    if (text.startsWith("--", index + 1)) return 3;
    return startsWithAt(text, index + 1, "doctype") ? 8 : 0;
  }
  return 0;
}

function startsWithAt(text: string, index: number, word: string): boolean {
  if (index + word.length > text.length) return false;
  for (let offset = 0; offset < word.length; offset++) {
    const code = text.charCodeAt(index + offset);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== word.charCodeAt(offset)) return false;
  }
  return true;
}

function stripComments(text: string): string {
  const out: string[] = [];
  let cursor = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("<!--", from);
    if (open === -1) break;
    const close = text.indexOf("-->", open + 4);
    if (close === -1) break;
    out.push(text.slice(cursor, open));
    cursor = close + 3;
    from = cursor;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

function findClosingTag(text: string, from: number, name: string): number {
  let search = from;
  for (;;) {
    const open = text.indexOf("</", search);
    if (open === -1) return -1;
    if (startsWithAt(text, open + 2, name)) {
      let cursor = open + 2 + name.length;
      while (cursor < text.length && WHITESPACE.test(text[cursor] ?? "")) {
        cursor++;
      }
      if (text[cursor] === ">") return cursor + 1;
    }
    search = open + 2;
  }
}

function blockNameAt(
  text: string,
  index: number,
  exhausted: Set<string>,
): string | null {
  for (const name of BLOCK_NAMES) {
    if (exhausted.has(name)) continue;
    const end = index + 1 + name.length;
    if (
      startsWithAt(text, index + 1, name) &&
      !isWordChar(text.charCodeAt(end))
    ) {
      return name;
    }
  }
  return null;
}

function stripBlocks(text: string): string {
  const out: string[] = [];
  const exhausted = new Set<string>();
  let cursor = 0;
  let from = 0;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) break;
    const name = blockNameAt(text, open, exhausted);
    if (!name) {
      from = open + 1;
      continue;
    }
    const close = findClosingTag(text, open + 1 + name.length, name);
    if (close === -1) {
      exhausted.add(name);
      from = open + 1;
      continue;
    }
    out.push(text.slice(cursor, open));
    cursor = close;
    from = close;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

function lineEnd(text: string, from: number): number {
  const end = text.indexOf("\n", from);
  return end === -1 ? text.length : end;
}

function stripTags(text: string): string {
  const out: string[] = [];
  let cursor = 0;
  let from = 0;
  let nextClose = -2;
  for (;;) {
    const open = text.indexOf("<", from);
    if (open === -1) break;
    const first = text[open + 1] === "/" ? open + 2 : open + 1;
    const name = elementNameAt(text, first);
    if (!name && tagNameLength(text, first) === 0) {
      from = open + 1;
      continue;
    }
    if (nextClose !== -1 && nextClose < first) {
      nextClose = text.indexOf(">", first);
    }
    if (nextClose === -1) {
      if (name === "script" || name === "style") {
        out.push(text.slice(cursor, open));
        cursor = lineEnd(text, open);
        from = cursor;
        continue;
      }
      from = open + 1;
      continue;
    }
    out.push(text.slice(cursor, open));
    cursor = nextClose + 1;
    from = cursor;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

export interface StrippedMarkup {
  text: string;
  htmlRemoved: boolean;
}

export function stripMarkupDetailed(text: string): StrippedMarkup {
  let current = text;
  let htmlRemoved = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const html = stripTags(stripBlocks(stripComments(current)));
    if (html !== current) htmlRemoved = true;
    const next = dropControlChars(html);
    if (next === current) break;
    current = next;
  }
  return { text: current, htmlRemoved };
}

export function stripMarkup(text: string): string {
  return stripMarkupDetailed(text).text;
}
