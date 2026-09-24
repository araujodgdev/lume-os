import { DurableObject } from "cloudflare:workers";
import { extratorPadrao, LeituraIndisponivel, type Extrator } from "./extrator.js";
import {
  confereAssinatura,
  consultaFts,
  contarPartes,
  dividirEmTrechos,
  precisaDeOcr,
  TAMANHO_PARTE,
  validateArquivo,
  type Achado,
  type DocumentoCofre,
  type JanelaTexto,
  type StatusDocumento,
  type TipoArquivo,
  type UploadIniciado,
} from "./tipos.js";

export type { Achado, DocumentoCofre, JanelaTexto, StatusDocumento, UploadIniciado } from "./tipos.js";

/** Pages Claude transcribes per request; a batch that overflows the output budget is halved. */
const PAGINAS_POR_LOTE = 10;
const MAX_TENTATIVAS = 3;
const ESPERA_BASE_MS = 10_000;
const UPLOAD_EXPIRA_MS = 60 * 60 * 1000;
const JANELA_PADRAO = 40_000;
const JANELA_MAXIMA = 100_000;
const MAX_ACHADOS = 20;

type DocRow = {
  id: string;
  caso_id: string;
  nome: string;
  mime: string;
  tipo: TipoArquivo;
  tamanho: number;
  status: StatusDocumento;
  paginas: number | null;
  paginas_lidas: number | null;
  erro: string | null;
  aviso: string | null;
  tentativas: number;
  proxima_tentativa: number;
  caracteres: number;
  criado_em: number;
  atualizado_em: number;
};

type UploadRow = { doc_id: string; r2_upload_id: string; partes: string; criado_em: number };
type LoteRow = { doc_id: string; primeira_pagina: number; paginas: number };

// Replaced by the tests through `CasosTestParent`; production always uses `extratorPadrao`.
let extratorFactory: (env: Cloudflare.Env) => Extrator = extratorPadrao;

/** Swaps the extractor for every vault in this isolate. Test-only. */
export function setExtratorFactory(factory: ((env: Cloudflare.Env) => Extrator) | null): void {
  extratorFactory = factory ?? extratorPadrao;
}

/**
 * The firm's document vault: one instance per sharing domain, next to the case registry. Files
 * live in R2; this object keeps their metadata, the multipart state of uploads in progress, the
 * OCR work queue and the full-text index. Reading runs in the alarm, one step at a time, so a
 * long OCR job survives restarts and never holds up the page.
 */
export class DocumentVault extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS documentos (
        id TEXT PRIMARY KEY,
        caso_id TEXT NOT NULL,
        nome TEXT NOT NULL,
        mime TEXT NOT NULL,
        tipo TEXT NOT NULL,
        tamanho INTEGER NOT NULL,
        status TEXT NOT NULL,
        paginas INTEGER,
        paginas_lidas INTEGER,
        erro TEXT,
        aviso TEXT,
        tentativas INTEGER NOT NULL DEFAULT 0,
        proxima_tentativa INTEGER NOT NULL DEFAULT 0,
        caracteres INTEGER NOT NULL DEFAULT 0,
        criado_em INTEGER NOT NULL,
        atualizado_em INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS documentos_caso ON documentos (caso_id);
      CREATE TABLE IF NOT EXISTS uploads (
        doc_id TEXT PRIMARY KEY,
        r2_upload_id TEXT NOT NULL,
        partes TEXT NOT NULL,
        criado_em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lotes (
        doc_id TEXT NOT NULL,
        primeira_pagina INTEGER NOT NULL,
        paginas INTEGER NOT NULL,
        PRIMARY KEY (doc_id, primeira_pagina)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS trechos USING fts5(
        doc_id UNINDEXED,
        caso_id UNINDEXED,
        texto,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  // ─── uploads ────────────────────────────────────────────────────────────────

  /** Opens an upload of a file to a case. The caller has checked that the case exists. */
  async iniciarUpload(casoId: string, arquivo: { nome: string; tamanho: number }): Promise<UploadIniciado> {
    const valido = validateArquivo(arquivo);
    const id = crypto.randomUUID();
    const now = Date.now();
    const upload = await this.env.COFRE.createMultipartUpload(this.#chave(casoId, id, "original"), {
      httpMetadata: { contentType: valido.mime },
    });
    this.ctx.storage.sql.exec(
      `INSERT INTO documentos (id, caso_id, nome, mime, tipo, tamanho, status, criado_em, atualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, 'enviando', ?, ?)`,
      id, casoId, valido.nome, valido.mime, valido.tipo, valido.tamanho, now, now,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO uploads (doc_id, r2_upload_id, partes, criado_em) VALUES (?, ?, '[]', ?)",
      id, upload.uploadId, now,
    );
    await this.#reagendar();
    return { uploadId: id, partes: contarPartes(valido.tamanho), tamanhoParte: TAMANHO_PARTE };
  }

  /** Stores chunk `numero` (from 1) of an upload. Every chunk but the last is exactly `TAMANHO_PARTE`. */
  async enviarParte(uploadId: string, numero: number, bytes: Uint8Array): Promise<void> {
    const { doc, upload } = this.#uploadAberto(uploadId);
    const total = contarPartes(doc.tamanho);
    if (!Number.isInteger(numero) || numero < 1 || numero > total) {
      throw new TypeError(`Parte ${numero} fora do intervalo 1..${total}.`);
    }
    const esperado = numero < total ? TAMANHO_PARTE : doc.tamanho - (total - 1) * TAMANHO_PARTE;
    if (bytes.byteLength !== esperado) {
      throw new TypeError(`A parte ${numero} deveria ter ${esperado} bytes, mas tem ${bytes.byteLength}.`);
    }
    if (numero === 1) confereAssinatura(doc, bytes.subarray(0, 16));
    const part = await this.env.COFRE
      .resumeMultipartUpload(this.#chave(doc.caso_id, doc.id, "original"), upload.r2_upload_id)
      .uploadPart(numero, bytes);
    const partes = (JSON.parse(upload.partes) as R2UploadedPart[])
      .filter((p) => p.partNumber !== numero)
      .concat({ partNumber: part.partNumber, etag: part.etag });
    this.ctx.storage.sql.exec(
      "UPDATE uploads SET partes = ? WHERE doc_id = ?", JSON.stringify(partes), uploadId,
    );
  }

  /** Completes an upload once every chunk arrived, and queues the document for reading. */
  async concluirUpload(uploadId: string): Promise<DocumentoCofre> {
    const { doc, upload } = this.#uploadAberto(uploadId);
    const partes = (JSON.parse(upload.partes) as R2UploadedPart[])
      .toSorted((a, b) => a.partNumber - b.partNumber);
    if (partes.length !== contarPartes(doc.tamanho)) {
      throw new Error(`Faltam partes: ${partes.length} de ${contarPartes(doc.tamanho)} recebidas.`);
    }
    await this.env.COFRE
      .resumeMultipartUpload(this.#chave(doc.caso_id, doc.id, "original"), upload.r2_upload_id)
      .complete(partes);
    this.ctx.storage.sql.exec("DELETE FROM uploads WHERE doc_id = ?", uploadId);
    this.#atualizar(uploadId, { status: "processando" });
    await this.#reagendar();
    return this.#documento(uploadId)!;
  }

  /** Abandons an upload in progress. */
  async cancelarUpload(uploadId: string): Promise<void> {
    await this.excluir(uploadId);
  }

  // ─── reads ──────────────────────────────────────────────────────────────────

  /** A case's documents, newest first, excluding uploads still in progress. */
  listar(casoId: string): DocumentoCofre[] {
    return this.ctx.storage.sql
      .exec<DocRow>(
        "SELECT * FROM documentos WHERE caso_id = ? AND status != 'enviando' ORDER BY criado_em DESC",
        casoId,
      )
      .toArray()
      .map(paraDocumento);
  }

  /** One document, or null. */
  obter(id: string): DocumentoCofre | null {
    return this.#documento(id);
  }

  /** How many documents each case holds. */
  contarPorCaso(): Record<string, number> {
    const rows = this.ctx.storage.sql
      .exec<{ caso_id: string; n: number }>(
        "SELECT caso_id, COUNT(*) AS n FROM documentos WHERE status != 'enviando' GROUP BY caso_id",
      )
      .toArray();
    return Object.fromEntries(rows.map((row) => [row.caso_id, row.n]));
  }

  /** A window of a document's extracted text, or null when the document does not exist. */
  async lerTexto(id: string, inicio = 0, limite = JANELA_PADRAO): Promise<JanelaTexto | null> {
    const doc = this.#row(id);
    if (!doc || doc.status === "enviando") return null;
    const objeto = await this.env.COFRE.get(this.#chave(doc.caso_id, doc.id, "texto.md"));
    const texto = objeto ? await objeto.text() : "";
    const de = Math.max(0, Math.floor(inicio));
    const ate = Math.min(texto.length, de + Math.min(Math.max(1, Math.floor(limite)), JANELA_MAXIMA));
    return { texto: texto.slice(de, ate), inicio: de, total: texto.length, fim: ate >= texto.length };
  }

  /** Chunk `numero` (from 1) of a document's original file, for the page to reassemble. */
  async baixarParte(id: string, numero: number): Promise<Uint8Array> {
    const doc = this.#row(id);
    if (!doc || doc.status === "enviando") throw new Error("Documento não encontrado.");
    const total = contarPartes(doc.tamanho);
    if (!Number.isInteger(numero) || numero < 1 || numero > total) {
      throw new TypeError(`Parte ${numero} fora do intervalo 1..${total}.`);
    }
    const offset = (numero - 1) * TAMANHO_PARTE;
    const objeto = await this.env.COFRE.get(this.#chave(doc.caso_id, doc.id, "original"), {
      range: { offset, length: Math.min(TAMANHO_PARTE, doc.tamanho - offset) },
    });
    if (!objeto) throw new Error("O arquivo deste documento não foi encontrado.");
    return new Uint8Array(await objeto.arrayBuffer());
  }

  /** The best-matching passages for `consulta`, at most one per document. */
  buscar(consulta: string, casoId?: string): Achado[] {
    const query = consultaFts(typeof consulta === "string" ? consulta : "");
    if (!query) return [];
    const rows = this.ctx.storage.sql
      .exec<{ doc_id: string; caso_id: string; trecho: string }>(
        `SELECT doc_id, caso_id, snippet(trechos, 2, '«', '»', '…', 24) AS trecho
         FROM trechos WHERE trechos MATCH ?${casoId ? " AND caso_id = ?" : ""}
         ORDER BY bm25(trechos) LIMIT 200`,
        ...(casoId ? [query, casoId] : [query]),
      )
      .toArray();
    const achados: Achado[] = [];
    const vistos = new Set<string>();
    for (const row of rows) {
      if (vistos.has(row.doc_id)) continue;
      const doc = this.#row(row.doc_id);
      if (!doc) continue;
      vistos.add(row.doc_id);
      achados.push({ documentoId: row.doc_id, casoId: row.caso_id, nome: doc.nome, trecho: row.trecho });
      if (achados.length === MAX_ACHADOS) break;
    }
    return achados;
  }

  // ─── deletion ───────────────────────────────────────────────────────────────

  /** Deletes a document, its files and its index entries. */
  async excluir(id: string): Promise<void> {
    const doc = this.#row(id);
    if (!doc) return;
    const upload = this.ctx.storage.sql
      .exec<UploadRow>("SELECT * FROM uploads WHERE doc_id = ?", id)
      .toArray()[0];
    this.#apagarLinhas(id);
    if (upload) {
      await this.env.COFRE
        .resumeMultipartUpload(this.#chave(doc.caso_id, id, "original"), upload.r2_upload_id)
        .abort()
        .catch(() => {});
    }
    await this.#apagarArquivos(doc.caso_id, id);
  }

  /** Deletes every document of a case. */
  async excluirCaso(casoId: string): Promise<void> {
    const ids = this.ctx.storage.sql
      .exec<{ id: string }>("SELECT id FROM documentos WHERE caso_id = ?", casoId)
      .toArray();
    for (const { id } of ids) await this.excluir(id);
  }

  // ─── reading pipeline ───────────────────────────────────────────────────────

  /** Runs one reading step, expires abandoned uploads, and schedules the next wake-up. */
  async alarm(): Promise<void> {
    await this.#expirarUploads();
    const doc = this.ctx.storage.sql
      .exec<DocRow>(
        `SELECT * FROM documentos WHERE status IN ('processando', 'ocr') AND proxima_tentativa <= ?
         ORDER BY atualizado_em LIMIT 1`,
        Date.now(),
      )
      .toArray()[0];
    if (doc) {
      try {
        await this.#passo(doc, extratorFactory(this.env));
        if (this.#row(doc.id)) this.#atualizar(doc.id, { tentativas: 0, proxima_tentativa: 0 });
        else await this.#apagarArquivos(doc.caso_id, doc.id); // deleted while we worked
      } catch (error) {
        this.#falhou(doc, error);
      }
    }
    await this.#reagendar();
  }

  async #passo(doc: DocRow, extrator: Extrator): Promise<void> {
    if (doc.status === "ocr") return this.#passoOcr(doc, extrator);
    const original = await this.#bytes(doc.caso_id, doc.id, "original");
    switch (doc.tipo) {
      case "texto":
        return this.#concluir(doc, new TextDecoder().decode(original));
      case "office":
        return this.#concluir(doc, await extrator.paraMarkdown(doc.nome, doc.mime, original));
      case "imagem": {
        if (!extrator.ocr) return this.#semTexto(doc, AVISO_SEM_OCR);
        const resultado = await extrator.ocr.transcreverImagem(original, doc.mime);
        if (resultado.status === "recusado") return this.#semTexto(doc, "O OCR não transcreveu esta imagem.");
        if (resultado.status === "longo") throw new Error("O texto da imagem é longo demais para o OCR.");
        return this.#concluir(doc, resultado.texto);
      }
      case "pdf": {
        const texto = await extrator.paraMarkdown(doc.nome, doc.mime, original);
        const paginas = await extrator.contarPaginas(original);
        this.#atualizar(doc.id, { paginas });
        if (!precisaDeOcr(texto.trim().length, paginas)) return this.#concluir(doc, texto);
        if (!extrator.ocr) {
          return texto.trim()
            ? this.#concluir(doc, texto, `${AVISO_SEM_OCR} Só o texto digital do PDF foi lido.`)
            : this.#semTexto(doc, AVISO_SEM_OCR);
        }
        const lotes = await extrator.dividirPdf(original, PAGINAS_POR_LOTE);
        await this.#enfileirarLotes(doc, lotes, 1, PAGINAS_POR_LOTE, paginas);
        await this.env.COFRE.put(this.#chave(doc.caso_id, doc.id, "texto.md"), "");
        this.#atualizar(doc.id, { status: "ocr", paginas_lidas: 0 });
        return;
      }
    }
  }

  async #passoOcr(doc: DocRow, extrator: Extrator): Promise<void> {
    const lote = this.ctx.storage.sql
      .exec<LoteRow>("SELECT * FROM lotes WHERE doc_id = ? ORDER BY primeira_pagina LIMIT 1", doc.id)
      .toArray()[0];
    if (!lote) {
      const texto = await this.#bytes(doc.caso_id, doc.id, "texto.md");
      return this.#concluir(doc, new TextDecoder().decode(texto), doc.aviso ?? undefined);
    }
    if (!extrator.ocr) return this.#semTexto(doc, AVISO_SEM_OCR);
    const chaveLote = this.#chave(doc.caso_id, doc.id, `lotes/${lote.primeira_pagina}.pdf`);
    const bytes = await this.#bytes(doc.caso_id, doc.id, `lotes/${lote.primeira_pagina}.pdf`);
    const resultado = await extrator.ocr.transcreverPdf(bytes, lote.primeira_pagina, lote.paginas);
    const ultima = lote.primeira_pagina + lote.paginas - 1;

    if (resultado.status === "longo" && lote.paginas > 1) {
      // Too much text for one answer: redo these pages in two smaller batches.
      const metades = await extrator.dividirPdf(bytes, Math.ceil(lote.paginas / 2));
      this.#apagarLote(doc.id, lote.primeira_pagina);
      await this.env.COFRE.delete(chaveLote);
      await this.#enfileirarLotes(doc, metades, lote.primeira_pagina, Math.ceil(lote.paginas / 2), ultima);
      return;
    }

    let trecho: string;
    let aviso = doc.aviso;
    if (resultado.status === "ok") {
      trecho = resultado.texto;
    } else {
      trecho = `--- Páginas ${lote.primeira_pagina} a ${ultima}: não transcritas ---`;
      aviso = "Algumas páginas não puderam ser transcritas pelo OCR.";
    }
    const anterior = await this.#bytes(doc.caso_id, doc.id, "texto.md");
    const atual = new TextDecoder().decode(anterior);
    await this.env.COFRE.put(
      this.#chave(doc.caso_id, doc.id, "texto.md"),
      atual ? `${atual}\n\n${trecho}` : trecho,
    );
    this.#apagarLote(doc.id, lote.primeira_pagina);
    await this.env.COFRE.delete(chaveLote);
    this.#atualizar(doc.id, { paginas_lidas: ultima, aviso });
  }

  /** Queues consecutive batches covering pages `primeiraPagina` to `ultimaPagina`. */
  async #enfileirarLotes(
    doc: DocRow,
    lotes: Uint8Array[],
    primeiraPagina: number,
    paginasPorLote: number,
    ultimaPagina: number,
  ): Promise<void> {
    for (const [i, lote] of lotes.entries()) {
      const primeira = primeiraPagina + i * paginasPorLote;
      const paginas = Math.min(paginasPorLote, ultimaPagina - primeira + 1);
      await this.env.COFRE.put(this.#chave(doc.caso_id, doc.id, `lotes/${primeira}.pdf`), lote);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO lotes (doc_id, primeira_pagina, paginas) VALUES (?, ?, ?)",
        doc.id, primeira, paginas,
      );
    }
  }

  async #concluir(doc: DocRow, texto: string, aviso?: string): Promise<void> {
    const limpo = texto.trim();
    if (!limpo) return this.#semTexto(doc, aviso ?? "Nenhum texto encontrado no documento.");
    await this.env.COFRE.put(this.#chave(doc.caso_id, doc.id, "texto.md"), limpo);
    this.ctx.storage.sql.exec("DELETE FROM trechos WHERE doc_id = ?", doc.id);
    for (const trecho of dividirEmTrechos(limpo)) {
      this.ctx.storage.sql.exec(
        "INSERT INTO trechos (doc_id, caso_id, texto) VALUES (?, ?, ?)", doc.id, doc.caso_id, trecho,
      );
    }
    this.#atualizar(doc.id, { status: "pronto", caracteres: limpo.length, aviso: aviso ?? null, erro: null });
  }

  #semTexto(doc: DocRow, aviso: string): void {
    this.#atualizar(doc.id, { status: "sem_texto", aviso, caracteres: 0 });
  }

  #falhou(doc: DocRow, error: unknown): void {
    if (!this.#row(doc.id)) return;
    const tentativas = doc.tentativas + 1;
    const mensagem = error instanceof Error ? error.message : String(error);
    if (tentativas >= MAX_TENTATIVAS || error instanceof LeituraIndisponivel) {
      this.#atualizar(doc.id, { status: "erro", erro: mensagem, tentativas });
      return;
    }
    this.#atualizar(doc.id, {
      tentativas,
      proxima_tentativa: Date.now() + ESPERA_BASE_MS * 4 ** (tentativas - 1),
    });
  }

  async #expirarUploads(): Promise<void> {
    const vencidos = this.ctx.storage.sql
      .exec<{ doc_id: string }>("SELECT doc_id FROM uploads WHERE criado_em <= ?", Date.now() - UPLOAD_EXPIRA_MS)
      .toArray();
    for (const { doc_id } of vencidos) await this.excluir(doc_id);
  }

  async #reagendar(): Promise<void> {
    const proximo = this.ctx.storage.sql
      .exec<{ quando: number | null }>(
        `SELECT MIN(quando) AS quando FROM (
           SELECT proxima_tentativa AS quando FROM documentos WHERE status IN ('processando', 'ocr')
           UNION ALL
           SELECT criado_em + ${UPLOAD_EXPIRA_MS} AS quando FROM uploads
         )`,
      )
      .one().quando;
    if (proximo === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(Date.now(), proximo));
  }

  // ─── storage helpers ────────────────────────────────────────────────────────

  #uploadAberto(uploadId: string): { doc: DocRow; upload: UploadRow } {
    const doc = this.#row(uploadId);
    const upload = this.ctx.storage.sql
      .exec<UploadRow>("SELECT * FROM uploads WHERE doc_id = ?", uploadId)
      .toArray()[0];
    if (!doc || !upload || doc.status !== "enviando") throw new Error("Envio não encontrado ou já concluído.");
    return { doc, upload };
  }

  #row(id: string): DocRow | undefined {
    return this.ctx.storage.sql.exec<DocRow>("SELECT * FROM documentos WHERE id = ?", id).toArray()[0];
  }

  #documento(id: string): DocumentoCofre | null {
    const row = this.#row(id);
    return row ? paraDocumento(row) : null;
  }

  #atualizar(id: string, campos: Partial<Omit<DocRow, "id">>): void {
    const entries = Object.entries({ ...campos, atualizado_em: Date.now() });
    this.ctx.storage.sql.exec(
      `UPDATE documentos SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
      ...entries.map(([, value]) => value ?? null),
      id,
    );
  }

  #apagarLote(docId: string, primeiraPagina: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM lotes WHERE doc_id = ? AND primeira_pagina = ?", docId, primeiraPagina,
    );
  }

  #apagarLinhas(id: string): void {
    for (const sql of [
      "DELETE FROM documentos WHERE id = ?",
      "DELETE FROM uploads WHERE doc_id = ?",
      "DELETE FROM lotes WHERE doc_id = ?",
      "DELETE FROM trechos WHERE doc_id = ?",
    ]) {
      this.ctx.storage.sql.exec(sql, id);
    }
  }

  async #apagarArquivos(casoId: string, docId: string): Promise<void> {
    const prefix = this.#chave(casoId, docId, "");
    let cursor: string | undefined;
    do {
      const page = await this.env.COFRE.list({ prefix, cursor });
      if (page.objects.length) await this.env.COFRE.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async #bytes(casoId: string, docId: string, nome: string): Promise<Uint8Array> {
    const objeto = await this.env.COFRE.get(this.#chave(casoId, docId, nome));
    if (!objeto) throw new Error(`Arquivo interno ausente: ${nome}.`);
    return new Uint8Array(await objeto.arrayBuffer());
  }

  /** R2 key of one of a document's files, namespaced by this vault so firms never collide. */
  #chave(casoId: string, docId: string, nome: string): string {
    return `${this.ctx.id.toString()}/${casoId}/${docId}/${nome}`;
  }
}

const AVISO_SEM_OCR =
  "Documento digitalizado, e o OCR não está configurado nesta instalação.";

function paraDocumento(row: DocRow): DocumentoCofre {
  const doc: DocumentoCofre = {
    id: row.id,
    casoId: row.caso_id,
    nome: row.nome,
    mime: row.mime,
    tipo: row.tipo,
    tamanho: row.tamanho,
    status: row.status,
    caracteres: row.caracteres,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
  if (row.paginas !== null) doc.paginas = row.paginas;
  if (row.status === "ocr" && row.paginas_lidas !== null) doc.paginasLidas = row.paginas_lidas;
  if (row.erro) doc.erro = row.erro;
  if (row.aviso) doc.aviso = row.aviso;
  return doc;
}
