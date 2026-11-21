import { strToU8, zipSync } from "fflate";

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries({ "[Content_Types].xml": "<Types/>", ...files }).map(
        ([name, body]) => [name, strToU8(body)],
      ),
    ),
  );
}

export function makeDocx(paragraphs: string[]): Uint8Array {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`)
    .join("");
  return zip({
    "word/document.xml": `${XML_HEAD}<w:document><w:body>${body}</w:body></w:document>`,
  });
}

export function makePptx(slides: string[][]): Uint8Array {
  const files: Record<string, string> = { "ppt/presentation.xml": "<p/>" };
  slides.forEach((runs, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] =
      `${XML_HEAD}<p:sld>${runs.map((run) => `<a:p><a:r><a:t>${escapeXml(run)}</a:t></a:r></a:p>`).join("")}</p:sld>`;
  });
  return zip(files);
}

export function makeXlsx(rows: (string | number)[][]): Uint8Array {
  const shared: string[] = [];
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
          if (typeof value === "number") {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          shared.push(value);
          return `<c r="${ref}" t="s"><v>${shared.length - 1}</v></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return zip({
    "xl/workbook.xml": "<workbook/>",
    "xl/sharedStrings.xml": `${XML_HEAD}<sst>${shared.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `${XML_HEAD}<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  });
}

function pdfEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

export function makePdf(lines: string[]): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td 16 TL ${lines
    .map((line) => `(${pdfEscape(line)}) Tj T*`)
    .join(" ")} ET`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return strToU8(out);
}

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function makePng(): Uint8Array {
  return new Uint8Array(Buffer.from(PNG_1X1, "base64"));
}

export function makeZip(): Uint8Array {
  return zipSync({ "readme.txt": strToU8("archive content must not be read") });
}
