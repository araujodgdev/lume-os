import { PDFDocument, rgb } from "pdf-lib";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { dividirParaPje, nomeParaPje, ziparPartes } from "./pje";

/** A PDF whose pages carry incompressible noise, so each weighs about `bytesPorPagina`. */
async function pdfPesado(paginas: number, bytesPorPagina: number, pesadas?: Set<number>): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < paginas; i++) {
    const page = doc.addPage([300, 300]);
    page.drawText(`Página ${i + 1}`, { x: 20, y: 260, size: 14, color: rgb(0, 0, 0) });
    const tamanho = pesadas?.has(i) ? bytesPorPagina * 8 : bytesPorPagina;
    const ruido = new Uint8Array(tamanho).map(() => Math.floor(Math.random() * 256));
    // A stream the page references, so the noise travels with the page when it is copied.
    const stream = doc.context.flateStream(ruido);
    page.node.set(doc.context.obj("LumeRuido") as never, doc.context.register(stream));
  }
  return doc.save();
}

describe("dividirParaPje", () => {
  it("returns a small PDF untouched, as one part", async () => {
    const pdf = await pdfPesado(2, 1_000);
    const { partes, avisos } = await dividirParaPje(pdf, 5 * 1024 * 1024, "Petição Inicial.pdf");
    expect(partes).toHaveLength(1);
    expect(partes[0]).toMatchObject({ nome: "Peticao_Inicial.pdf", paginas: [1, 2] });
    expect(partes[0].bytes).toBe(pdf);
    expect(avisos).toEqual([]);
  });

  it("splits into parts under the limit that cover every page in order", async () => {
    const pdf = await pdfPesado(30, 20_000);
    const limite = 100_000;
    const { partes, avisos } = await dividirParaPje(pdf, limite, "autos.pdf");
    expect(avisos).toEqual([]);
    expect(partes.length).toBeGreaterThan(1);
    let proxima = 1;
    for (const [i, parte] of partes.entries()) {
      expect(parte.bytes.byteLength).toBeLessThanOrEqual(limite);
      expect(parte.nome).toBe(`autos_parte_${String(i + 1).padStart(2, "0")}.pdf`);
      expect(parte.paginas[0]).toBe(proxima);
      const doc = await PDFDocument.load(parte.bytes);
      expect(doc.getPageCount()).toBe(parte.paginas[1] - parte.paginas[0] + 1);
      proxima = parte.paginas[1] + 1;
    }
    expect(proxima).toBe(31);

    const zip = unzipSync(ziparPartes(partes));
    expect(Object.keys(zip)).toEqual(partes.map((p) => p.nome));
  });

  it("warns about a single page larger than the limit", async () => {
    const pdf = await pdfPesado(4, 20_000, new Set([2]));
    const { partes, avisos } = await dividirParaPje(pdf, 100_000, "a.pdf");
    expect(avisos).toEqual([expect.stringContaining("A página 3 sozinha")]);
    expect(partes.map((p) => p.paginas)).toContainEqual([3, 3]);
  });
});

describe("nomeParaPje", () => {
  it("drops accents, spaces and the extension", () => {
    expect(nomeParaPje("Contestação — Réu (final).pdf")).toBe("Contestacao_Reu_final");
    expect(nomeParaPje("...pdf")).toBe("documento");
  });
});
