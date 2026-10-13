const MAX_EXPANDED = 10 * 1024 * 1024,
  MAX_ENTRIES = 200,
  MAX_ROWS = 200,
  MAX_COLUMNS = 50,
  MAX_CELLS = 10_000;
export interface SheetPreview {
  name: string;
  rows: string[][];
}
function fail(): never {
  throw new Error("表格超过安全预览范围，请下载原文件。");
}
function checkZip(data: ArrayBuffer) {
  const view = new DataView(data);
  let eocd = -1;
  for (
    let i = data.byteLength - 22;
    i >= Math.max(0, data.byteLength - 65557);
    i--
  )
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) fail();
  const count = view.getUint16(eocd + 10, true),
    offset = view.getUint32(eocd + 16, true),
    directorySize = view.getUint32(eocd + 12, true);
  if (
    count > MAX_ENTRIES ||
    count === 0 ||
    view.getUint16(eocd + 4, true) !== 0 ||
    offset >= eocd ||
    offset + directorySize !== eocd ||
    view.getUint16(eocd + 8, true) !== count ||
    view.getUint16(eocd + 6, true) !== 0
  )
    fail();
  let total = 0,
    p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== 0x02014b50) fail();
    const size = view.getUint32(p + 24, true);
    total += size;
    if (size === 0xffffffff || total > MAX_EXPANDED) fail();
    p +=
      46 +
      view.getUint16(p + 28, true) +
      view.getUint16(p + 30, true) +
      view.getUint16(p + 32, true);
  }
  if (p !== eocd) fail();
}
function xml(text: string): Document {
  if (text.length > MAX_EXPANDED || /<!DOCTYPE|<!ENTITY/i.test(text)) fail();
  const parsed = new DOMParser().parseFromString(text, "application/xml");
  if (parsed.getElementsByTagName("parsererror").length) fail();
  return parsed;
}
const children = (node: Document | Element, name: string) => [
  ...node.getElementsByTagNameNS("*", name),
];
export async function parseXlsxPreview(
  data: ArrayBuffer,
): Promise<SheetPreview[]> {
  checkZip(data);
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(data);
  let expanded = 0;
  const text = async (path: string): Promise<string> => {
    const entry = zip.file(path);
    if (!entry) fail();
    return new Promise((resolve, reject) => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      interface ZipStream {
        on(event: "data", callback: (chunk: Uint8Array) => void): ZipStream;
        on(event: "error", callback: (error: unknown) => void): ZipStream;
        on(event: "end", callback: () => void): ZipStream;
        pause(): void;
        resume(): void;
      }
      const stream = (
        entry as unknown as { internalStream(type: "uint8array"): ZipStream }
      ).internalStream("uint8array");
      stream
        .on("data", (chunk) => {
          size += chunk.length;
          expanded += chunk.length;
          if (expanded > MAX_EXPANDED) {
            stream.pause();
            reject(new Error("表格解压超过安全范围"));
            return;
          }
          chunks.push(chunk);
        })
        .on("error", reject)
        .on("end", () => {
          const bytes = new Uint8Array(size);
          let position = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, position);
            position += chunk.length;
          }
          resolve(new TextDecoder().decode(bytes));
        })
        .resume();
    });
  };
  const read = async (path: string) => xml(await text(path));
  const book = await read("xl/workbook.xml"),
    relations = await read("xl/_rels/workbook.xml.rels");
  const sheets = children(book, "sheet");
  if (sheets.length > 10) fail();
  const strings: string[] = [];
  const shared = zip.file("xl/sharedStrings.xml");
  if (shared)
    for (const si of children(xml(await text("xl/sharedStrings.xml")), "si")) {
      strings.push(
        children(si, "t")
          .map((t) => t.textContent ?? "")
          .join(""),
      );
      if (strings.length > MAX_CELLS) fail();
    }
  let cells = 0,
    textBytes = 0;
  const result: SheetPreview[] = [];
  for (const sheet of sheets) {
    const id = sheet.getAttribute("r:id");
    const relation = children(relations, "Relationship").find(
      (item) => item.getAttribute("Id") === id,
    );
    const target = relation?.getAttribute("Target");
    if (
      !target ||
      relation?.getAttribute("TargetMode") === "External" ||
      target.includes("..") ||
      target.includes("\\")
    )
      fail();
    const document = await read(
      target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    );
    const rows: string[][] = [];
    for (const cell of children(document, "c")) {
      if (++cells > MAX_CELLS) fail();
      const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell.getAttribute("r") ?? "");
      if (!match) fail();
      const row = Number(match[2]) - 1;
      let column = 0;
      for (const char of match[1]!)
        column = column * 26 + char.charCodeAt(0) - 64;
      column--;
      if (row >= MAX_ROWS || column >= MAX_COLUMNS) fail();
      const raw = children(cell, "v")[0]?.textContent ?? "";
      const value = children(cell, "f").length
        ? "[公式]"
        : cell.getAttribute("t") === "s"
          ? (strings[Number(raw)] ?? "")
          : cell.getAttribute("t") === "inlineStr"
            ? children(cell, "t")
                .map((t) => t.textContent ?? "")
                .join("")
            : raw;
      textBytes += value.length;
      if (textBytes > 1_000_000) fail();
      rows[row] ??= [];
      rows[row]![column] = value.slice(0, 4000);
    }
    result.push({
      name: sheet.getAttribute("name") ?? "工作表",
      rows: Array.from({ length: rows.length }, (_, i) =>
        Array.from(
          { length: rows[i]?.length ?? 0 },
          (_, j) => rows[i]?.[j] ?? "",
        ),
      ),
    });
  }
  return result;
}
