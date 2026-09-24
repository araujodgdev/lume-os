// Pure rules of the document vault: which files it accepts, how their kind is recognized, and how
// extracted text is cut for the search index. Shared by the vault, the page and the tests.

/** Largest file the vault accepts. */
export const MAX_TAMANHO = 50 * 1024 * 1024;

/**
 * Upload and download chunk size. R2 multipart needs at least 5 MiB for every part but the last,
 * and a chunk must also cross the Workshop's WebSocket hop, where bytes travel as base64 under a
 * 32M-character message cap.
 */
export const TAMANHO_PARTE = 5 * 1024 * 1024;

/** How the vault reads a file. */
export type TipoArquivo = "pdf" | "office" | "texto" | "imagem";

/** Where a document is in its life, as the page shows it. */
export type StatusDocumento = "enviando" | "processando" | "ocr" | "pronto" | "sem_texto" | "erro";

/** A document as the Casos page sees it. */
export type DocumentoCofre = {
  id: string;
  casoId: string;
  nome: string;
  mime: string;
  tipo: TipoArquivo;
  tamanho: number;
  status: StatusDocumento;
  /** Page count, for PDFs once read. */
  paginas?: number;
  /** Pages transcribed so far, while OCR runs. */
  paginasLidas?: number;
  /** Why the document failed, when `status` is "erro". */
  erro?: string;
  /** Something the lawyer should know about the text, e.g. pages OCR could not read. */
  aviso?: string;
  /** Length of the extracted text. */
  caracteres: number;
  criadoEm: number;
  atualizadoEm: number;
};

/** A window of a document's extracted text. */
export type JanelaTexto = { texto: string; inicio: number; total: number; fim: boolean };

/** One full-text search hit. */
export type Achado = { documentoId: string; casoId: string; nome: string; trecho: string };

/** What `iniciarUpload` hands back to the page. */
export type UploadIniciado = { uploadId: string; partes: number; tamanhoParte: number };

/** The firm's uploaded piece template, as the page describes it. */
export type InfoModelo = {
  tamanho: number;
  atualizadoEm: number;
  /** Known fields found in the template, e.g. ["cliente", "conteudo"]. */
  campos: string[];
  /** What the lawyer should know, e.g. the template has no {{conteudo}}. */
  avisos: string[];
};

/** Firm-wide settings for pieces and PJe downloads. */
export type ConfiguracoesEscritorio = {
  /** Largest file the PJe accepts, in MB; "Baixar para o PJe" splits PDFs below it. */
  pjeLimiteMb: number;
  /** City for the {{cidade}} field, e.g. "São Paulo". */
  cidade: string;
  /** The uploaded template, or null while pieces use the built-in forensic default. */
  modelo: InfoModelo | null;
};

/** PJe limit used until an admin changes it. */
export const PJE_LIMITE_PADRAO_MB = 5;

/** Validates the settings an admin submits. */
export function validateConfiguracoes(input: { pjeLimiteMb?: unknown; cidade?: unknown }): {
  pjeLimiteMb?: number;
  cidade?: string;
} {
  const saida: { pjeLimiteMb?: number; cidade?: string } = {};
  if (input.pjeLimiteMb !== undefined) {
    const mb = input.pjeLimiteMb;
    if (typeof mb !== "number" || !Number.isFinite(mb) || mb < 0.5 || mb > 100) {
      throw new TypeError("O limite do PJe deve ficar entre 0,5 e 100 MB.");
    }
    saida.pjeLimiteMb = Math.round(mb * 10) / 10;
  }
  if (input.cidade !== undefined) {
    if (typeof input.cidade !== "string" || input.cidade.trim().length > 100) {
      throw new TypeError("A cidade deve ser um texto de até 100 caracteres.");
    }
    saida.cidade = input.cidade.trim();
  }
  return saida;
}


type Formato = { tipo: TipoArquivo; mime: string };

/** Accepted extensions and the canonical type each one is stored with. */
const FORMATOS: Record<string, Formato> = {
  pdf: { tipo: "pdf", mime: "application/pdf" },
  docx: { tipo: "office", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { tipo: "office", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  xls: { tipo: "office", mime: "application/vnd.ms-excel" },
  odt: { tipo: "office", mime: "application/vnd.oasis.opendocument.text" },
  ods: { tipo: "office", mime: "application/vnd.oasis.opendocument.spreadsheet" },
  csv: { tipo: "texto", mime: "text/csv" },
  txt: { tipo: "texto", mime: "text/plain" },
  jpg: { tipo: "imagem", mime: "image/jpeg" },
  jpeg: { tipo: "imagem", mime: "image/jpeg" },
  png: { tipo: "imagem", mime: "image/png" },
  webp: { tipo: "imagem", mime: "image/webp" },
};

/** The extensions the page offers in its file picker. */
export const EXTENSOES_ACEITAS = Object.keys(FORMATOS).map((ext) => `.${ext}`);

/** A validated upload request. */
export type NovoArquivo = { nome: string; mime: string; tipo: TipoArquivo; tamanho: number };

/**
 * Validates a file the page wants to upload. The type comes from the extension, never from the
 * browser-reported MIME type; `confereAssinatura` checks the bytes once they arrive.
 */
export function validateArquivo(input: { nome: unknown; tamanho: unknown }): NovoArquivo {
  if (typeof input?.nome !== "string" || !input.nome.trim()) {
    throw new TypeError("Informe o nome do arquivo.");
  }
  // Path separators and control characters become "_", so the name is safe to show and to save.
  const nome = [...input.nome.trim()]
    .map((c) => (c === "/" || c === "\\" || c.charCodeAt(0) < 0x20 ? "_" : c))
    .join("")
    .slice(0, 200);
  const extensao = nome.includes(".") ? nome.slice(nome.lastIndexOf(".") + 1).toLowerCase() : "";
  const formato = FORMATOS[extensao];
  if (!formato) {
    throw new TypeError(
      `Formato não aceito: "${nome}". Envie ${EXTENSOES_ACEITAS.join(", ")}.`,
    );
  }
  const tamanho = input.tamanho;
  if (typeof tamanho !== "number" || !Number.isInteger(tamanho) || tamanho <= 0) {
    throw new TypeError("Tamanho de arquivo inválido.");
  }
  if (tamanho > MAX_TAMANHO) {
    throw new TypeError(`"${nome}" passa do limite de ${MAX_TAMANHO / 1024 / 1024} MB.`);
  }
  return { nome, ...formato, tamanho };
}

/** How many chunks a file of `tamanho` bytes is sent or downloaded in. */
export function contarPartes(tamanho: number): number {
  return Math.max(1, Math.ceil(tamanho / TAMANHO_PARTE));
}

/**
 * Checks that a file's first bytes match its declared type, so a renamed executable or HTML page
 * is never stored as a PDF. Plain text has no signature and passes.
 */
export function confereAssinatura(arquivo: Pick<NovoArquivo, "nome" | "mime" | "tipo">, inicio: Uint8Array): void {
  const ok = (() => {
    switch (arquivo.tipo) {
      case "pdf":
        return startsWith(inicio, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
      case "office":
        return arquivo.mime === "application/vnd.ms-excel"
          ? startsWith(inicio, [0xd0, 0xcf, 0x11, 0xe0]) // OLE compound file
          : startsWith(inicio, [0x50, 0x4b, 0x03, 0x04]); // ZIP (OOXML, ODF)
      case "imagem":
        if (arquivo.mime === "image/jpeg") return startsWith(inicio, [0xff, 0xd8, 0xff]);
        if (arquivo.mime === "image/png") return startsWith(inicio, [0x89, 0x50, 0x4e, 0x47]);
        return startsWith(inicio, [0x52, 0x49, 0x46, 0x46]) && // RIFF....WEBP
          String.fromCharCode(...inicio.slice(8, 12)) === "WEBP";
      case "texto":
        return true;
    }
  })();
  if (!ok) throw new TypeError(`O conteúdo de "${arquivo.nome}" não corresponde ao formato do arquivo.`);
}

/** Size of one search-index passage, in characters. */
export const TAMANHO_TRECHO = 2_000;
const SOBREPOSICAO = 200;

/**
 * Cuts extracted text into overlapping passages for the full-text index, breaking at whitespace
 * where it can so a passage never splits a word.
 */
export function dividirEmTrechos(texto: string): string[] {
  const trechos: string[] = [];
  let inicio = 0;
  while (inicio < texto.length) {
    let fim = Math.min(texto.length, inicio + TAMANHO_TRECHO);
    if (fim < texto.length) {
      const espaco = texto.lastIndexOf(" ", fim);
      if (espaco > inicio + TAMANHO_TRECHO / 2) fim = espaco;
    }
    const trecho = texto.slice(inicio, fim).trim();
    if (trecho) trechos.push(trecho);
    if (fim >= texto.length) break;
    inicio = Math.max(fim - SOBREPOSICAO, inicio + 1);
  }
  return trechos;
}

/**
 * Turns free text into an FTS5 query: every word must appear, the last one as a prefix. Only
 * letters and digits survive, so user input can never inject FTS5 syntax.
 */
export function consultaFts(texto: string): string | null {
  const palavras = texto.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (palavras.length === 0) return null;
  return palavras
    .slice(0, 12)
    .map((palavra, i, all) => `"${palavra}"${i === all.length - 1 ? "*" : ""}`)
    .join(" ");
}

/** Below this many characters per page, a PDF is treated as scanned and sent to OCR. */
export const MIN_CARACTERES_POR_PAGINA = 200;

/** Whether text extracted from a PDF's text layer is too thin to be the whole document. */
export function precisaDeOcr(caracteres: number, paginas: number): boolean {
  return caracteres < Math.max(1, paginas) * MIN_CARACTERES_POR_PAGINA;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}
