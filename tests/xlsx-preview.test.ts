// @vitest-environment jsdom
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { parseXlsxPreview } from "../apps/web/src/xlsx-preview.js";
async function workbook(content: string, extra = "") {
  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="数据" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  zip.file("xl/worksheets/sheet1.xml", content);
  if (extra) zip.file("bomb", extra);
  return zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
}
describe("bounded read-only XLSX", () => {
  it("renders literal strings and formula placeholders without evaluation", async () => {
    const parsed = await parseXlsxPreview(
      await workbook(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>中文</t></is></c><c r="B1"><f>HYPERLINK("https://evil","click")</f><v>42</v></c></row></sheetData></worksheet>',
      ),
    );
    expect(parsed[0]).toMatchObject({
      name: "数据",
      rows: [["中文", "[公式]"]],
    });
  });
  it("rejects sparse out-of-bounds cells before allocating a sheet", async () => {
    await expect(
      parseXlsxPreview(
        await workbook(
          '<worksheet><sheetData><row r="999999"><c r="XFD999999"><v>1</v></c></row></sheetData></worksheet>',
        ),
      ),
    ).rejects.toThrow();
  });
  it("rejects a decompression bomb before loading ZIP entries", async () => {
    await expect(
      parseXlsxPreview(
        await workbook("<worksheet/>", "x".repeat(11 * 1024 * 1024)),
      ),
    ).rejects.toThrow();
  });
  it("rejects a central-directory count that hides additional entries", async () => {
    const data = await workbook("<worksheet/>");
    const view = new DataView(data);
    for (let i = data.byteLength - 22; i >= 0; i--)
      if (view.getUint32(i, true) === 0x06054b50) {
        view.setUint16(i + 8, 1, true);
        view.setUint16(i + 10, 1, true);
        break;
      }
    await expect(parseXlsxPreview(data)).rejects.toThrow();
  });
});
