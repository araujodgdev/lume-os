// Splits a PDF into parts under the PJe's per-file size limit, in the browser. Pages keep their
// order; each part is a standalone PDF. Sizes are estimated per page first (conservatively, since
// resources shared between pages are counted once per page), then every part is checked for real.

import { zipSync } from "fflate";
import { PDFDocument } from "pdf-lib";

/** One part of a split PDF. */
export type ParteDividida = {
  nome: string;
  bytes: Uint8Array;
  /** First and last page it holds, counting from 1. */
  paginas: [number, number];
};

export type Divisao = { partes: ParteDividida[]; avisos: string[] };

/** Share of the limit a part aims for, leaving room for estimate error. */
const MARGEM = 0.95;

/** A file name the PJe accepts: no accents, spaces or symbols, and no extension. */
export function nomeParaPje(nome: string): string {
  const base = nome.replace(/\.[^.]+$/, "");
  const limpo = base
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^A-Za-z0-9-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
  return limpo || "documento";
}

/**
 * Splits `pdf` into parts of at most `limiteBytes`. A PDF already under the limit comes back as a
 * single part with its original bytes. A page that alone exceeds the limit becomes its own part and
 * is reported in `avisos`, since no split can make it fit.
 */
export async function dividirParaPje(pdf: Uint8Array, limiteBytes: number, nome: string): Promise<Divisao> {
  const base = nomeParaPje(nome);
  const origem = await PDFDocument.load(pdf, { updateMetadata: false });
  const total = origem.getPageCount();
  if (pdf.byteLength <= limiteBytes) {
    return { partes: [{ nome: `${base}.pdf`, bytes: pdf, paginas: [1, total] }], avisos: [] };
  }

  const estimativas: number[] = [];
  for (let i = 0; i < total; i++) estimativas.push((await montar(origem, [i])).byteLength);

  const grupos: number[][] = [];
  let atual: number[] = [];
  let soma = 0;
  for (let i = 0; i < total; i++) {
    if (atual.length && soma + estimativas[i] > limiteBytes * MARGEM) {
      grupos.push(atual);
      atual = [];
      soma = 0;
    }
    atual.push(i);
    soma += estimativas[i];
  }
  if (atual.length) grupos.push(atual);

  const prontos: { paginas: number[]; bytes: Uint8Array }[] = [];
  const avisos: string[] = [];
  const pendentes = [...grupos];
  while (pendentes.length) {
    const grupo = pendentes.shift()!;
    const bytes = await montar(origem, grupo);
    if (bytes.byteLength <= limiteBytes) {
      prontos.push({ paginas: grupo, bytes });
    } else if (grupo.length > 1) {
      const meio = Math.ceil(grupo.length / 2);
      pendentes.unshift(grupo.slice(0, meio), grupo.slice(meio));
    } else {
      prontos.push({ paginas: grupo, bytes });
      avisos.push(
        `A página ${grupo[0] + 1} sozinha tem ${formatarMb(bytes.byteLength)}, acima do limite de ` +
        `${formatarMb(limiteBytes)}. Reduza a resolução dessa página antes de enviar ao PJe.`,
      );
    }
  }
  const ordenados = prontos.toSorted((a, b) => a.paginas[0] - b.paginas[0]);
  const digitos = Math.max(2, String(ordenados.length).length);
  return {
    partes: ordenados.map((parte, i) => ({
      nome: `${base}_parte_${String(i + 1).padStart(digitos, "0")}.pdf`,
      bytes: parte.bytes,
      paginas: [parte.paginas[0] + 1, parte.paginas.at(-1)! + 1],
    })),
    avisos,
  };
}

/** Packs parts into a .zip, stored without recompressing (PDFs are compressed already). */
export function ziparPartes(partes: ParteDividida[]): Uint8Array {
  return zipSync(Object.fromEntries(partes.map((parte) => [parte.nome, [parte.bytes, { level: 0 }]])));
}

async function montar(origem: PDFDocument, indices: number[]): Promise<Uint8Array> {
  const parte = await PDFDocument.create();
  for (const pagina of await parte.copyPages(origem, indices)) parte.addPage(pagina);
  return parte.save();
}

function formatarMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}
