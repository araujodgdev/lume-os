import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { extratorPadrao, LeituraIndisponivel } from "../src/cofre/extrator.js";

async function pdfCom(paginas: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) doc.addPage([200, 200]);
  return doc.save();
}

describe("extratorPadrao", () => {
  const env = { COFRE: {} } as unknown as Cloudflare.Env;

  it("counts pages and splits a PDF into batches with pdf-lib, inside workerd", async () => {
    const extrator = extratorPadrao(env);
    const pdf = await pdfCom(23);
    expect(await extrator.contarPaginas(pdf)).toBe(23);
    const lotes = await extrator.dividirPdf(pdf, 10);
    expect(await Promise.all(lotes.map((lote) => extrator.contarPaginas(lote)))).toEqual([10, 10, 3]);
  });

  it("explains an unreadable PDF", async () => {
    await expect(extratorPadrao(env).contarPaginas(new TextEncoder().encode("%PDF-lixo")))
      .rejects.toThrow(/corrompido/);
  });

  it("has no OCR and no conversion without Workers AI", async () => {
    const extrator = extratorPadrao(env);
    expect(extrator.ocr).toBeNull();
    await expect(extrator.paraMarkdown("a.docx", "x", new Uint8Array())).rejects.toBeInstanceOf(LeituraIndisponivel);
  });

  it("enables OCR only when the deploy says Claude is reachable", () => {
    const ai = {} as Ai;
    expect(extratorPadrao({ ...env, WORKERS_AI: ai, CASOS_OCR: "false", CF_AI_GATEWAY: "g" }).ocr).toBeNull();
    expect(extratorPadrao({ ...env, WORKERS_AI: ai, CASOS_OCR: "true", CF_AI_GATEWAY: "g" }).ocr).not.toBeNull();
  });
});
