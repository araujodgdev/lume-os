// Everything the vault needs from the outside world to read a document, behind one interface so the
// tests can swap in a fake. `extratorPadrao` is the production implementation.

import { EncryptedPDFError, PDFDocument } from "pdf-lib";
import { claudeOcr, type Ocr } from "./claude.js";

export interface Extrator {
  /** Converts a document to Markdown with Workers AI's free text-layer conversion. */
  paraMarkdown(nome: string, mime: string, bytes: Uint8Array): Promise<string>;
  /** Number of pages in a PDF. Throws for an encrypted or unreadable one. */
  contarPaginas(pdf: Uint8Array): Promise<number>;
  /** Splits a PDF into consecutive batches of at most `paginasPorLote` pages, in one parse. */
  dividirPdf(pdf: Uint8Array, paginasPorLote: number): Promise<Uint8Array[]>;
  /** Claude OCR, or null when the deployment has not enabled it. */
  ocr: Ocr | null;
}

/** Thrown when this environment cannot read documents at all (no Workers AI binding). */
export class LeituraIndisponivel extends Error {}

export function extratorPadrao(env: Cloudflare.Env): Extrator {
  const ai = env.WORKERS_AI;
  return {
    async paraMarkdown(nome, mime, bytes) {
      if (!ai) {
        throw new LeituraIndisponivel(
          "A leitura de documentos precisa do Workers AI, que não está disponível neste ambiente.",
        );
      }
      const result = await ai.toMarkdown({ name: nome, blob: new Blob([bytes], { type: mime }) });
      if (result.format === "error") throw new Error(`Falha ao ler "${nome}": ${result.error}`);
      return result.data;
    },
    contarPaginas: async (pdf) => (await carregarPdf(pdf)).getPageCount(),
    async dividirPdf(pdf, paginasPorLote) {
      const origem = await carregarPdf(pdf);
      const total = origem.getPageCount();
      const lotes: Uint8Array[] = [];
      for (let inicio = 0; inicio < total; inicio += paginasPorLote) {
        const lote = await PDFDocument.create();
        const indices = Array.from(
          { length: Math.min(paginasPorLote, total - inicio) },
          (_, i) => inicio + i,
        );
        for (const pagina of await lote.copyPages(origem, indices)) lote.addPage(pagina);
        lotes.push(await lote.save());
      }
      return lotes;
    },
    ocr:
      ai && env.CASOS_OCR === "true" && env.CF_AI_GATEWAY
        ? claudeOcr({
            binding: ai,
            gateway: env.CF_AI_GATEWAY,
            model: env.CASOS_OCR_MODEL || "claude-opus-5",
          })
        : null,
  };
}

async function carregarPdf(pdf: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new Error("O PDF está protegido por senha. Envie uma cópia sem senha.", { cause: error });
    }
    throw new Error("Não foi possível abrir o PDF: o arquivo parece corrompido.", { cause: error });
  }
}
