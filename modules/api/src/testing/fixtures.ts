const encoder = new TextEncoder();

function bytes(...parts: (number[] | string)[]): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === "string" ? encoder.encode(part) : Uint8Array.from(part),
  );
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const pad = (count = 32): number[] => Array.from({ length: count }, () => 1);

export const fixtures = {
  png: () => bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], pad()),
  jpeg: () => bytes([0xff, 0xd8, 0xff, 0xe0], pad()),
  gif: () => bytes("GIF89a", pad()),
  webp: () => bytes("RIFF", [0, 0, 0, 0], "WEBPVP8 ", pad()),
  pdf: () => bytes("%PDF-1.7\n", pad()),
  text: (body = "plain log line\n") => bytes(body),
  elf: () => bytes([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], pad()),
  pe: () => bytes("MZ", pad(64)),
  macho: () => bytes([0xcf, 0xfa, 0xed, 0xfe], pad()),
  shebang: () => bytes("#!/bin/sh\necho hi\n"),
  mp4: () => bytes([0, 0, 0, 0x18], "ftypisom", pad()),
  mov: () => bytes([0, 0, 0, 0x14], "ftypqt  ", pad()),
  heic: () => bytes([0, 0, 0, 0x18], "ftypheic", pad()),
  webm: () => bytes([0x1a, 0x45, 0xdf, 0xa3], pad()),
  avi: () => bytes("RIFF", [0, 0, 0, 0], "AVI LIST", pad()),
  ole: () => bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], pad()),
  nulText: () => bytes("abc", [0], "def"),
  badUtf8: () => bytes([0xc3, 0x28, 0xff, 0xfe]),
  zip: (names: string[]) => zip(names),
  truncatedZip: () => bytes("PK", [3, 4], pad()),
  megabytes: (count: number) => {
    const out = new Uint8Array(count * 1024 * 1024);
    out.set(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    return out;
  },
};

function zip(names: string[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = encoder.encode(name);
    const local = bytes(
      [0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [nameBytes.length, 0, 0, 0],
      Array.from(nameBytes),
    );
    const central = bytes(
      [0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [nameBytes.length, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      [offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, 0],
      Array.from(nameBytes),
    );
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const end = bytes(
    [0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0],
    [names.length & 0xff, 0, names.length & 0xff, 0],
    [centralSize & 0xff, (centralSize >> 8) & 0xff, 0, 0],
    [offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, 0],
    [0, 0],
  );
  return bytes(
    ...[...locals, ...centrals, end].map((part) => Array.from(part)),
  );
}
