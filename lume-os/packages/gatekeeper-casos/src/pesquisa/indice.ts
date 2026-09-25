import { DurableObject } from "cloudflare:workers";
import { classeBase, digitos, normalizarClasse } from "./julgado.js";
import type { EstadoImportacao } from "./pagina.js";
import type { Julgado, JulgadoSalvo } from "./types.js";
import type { ContextoFonte, Referencia } from "./fontes/fonte.js";
import { julgadoDeEspelho, julgadoDeTema, lerCsv, listarRecursos, type EspelhoStj, type RecursoStj } from "./fontes/stj.js";

/**
 * How the index reaches the STJ's open data. Replaced in tests; production uses the global fetch.
 */
let fetchIndice: typeof fetch = (...args) => fetch(...args);

export function setFetchIndice(fn: typeof fetch | null): void {
  fetchIndice = fn ?? ((...args) => fetch(...args));
}

export function indiceFor(exports: Cloudflare.Exports): DurableObjectStub<IndiceJurisprudencia> {
  // Public case law is the same for every firm of a deployment, so there is one index.
  return exports.IndiceJurisprudencia.getByName("brasil");
}

/** How often the STJ's file list is checked for new months. */
const INTERVALO_LISTAGEM_MS = 24 * 60 * 60 * 1000;
/** The themes file changes in place, so it is re-read weekly. */
const INTERVALO_TEMAS_MS = 7 * 24 * 60 * 60 * 1000;
/** Pause between files, and after a failure. */
const PAUSA_ENTRE_ARQUIVOS_MS = 2_000;
const PAUSA_APOS_ERRO_MS = 15 * 60 * 1000;
/** Cached live searches expire after a day. */
export const VALIDADE_CACHE_MS = 24 * 60 * 60 * 1000;

const PALAVRAS_VAZIAS = new Set([
  "a", "o", "as", "os", "de", "da", "do", "das", "dos", "e", "em", "na", "no", "nas", "nos", "para",
  "por", "com", "que", "um", "uma", "ao", "aos", "se", "sobre", "ou",
]);

/**
 * Free text into an FTS5 query. `todas` requires every word; otherwise any word matches and bm25
 * ranks. Only letters and digits survive, so input can never inject FTS5 syntax.
 */
export function consultaJurisprudencia(texto: string, todas: boolean): string | null {
  const palavras = (texto.normalize("NFC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((p) => !PALAVRAS_VAZIAS.has(p.toLowerCase()))
    .slice(0, 16);
  if (palavras.length === 0) return null;
  return palavras.map((p) => `"${p}"`).join(todas ? " " : " OR ");
}

/** The number a citation and a decision share: digits, and CNJ numbers padded to 20. */
export function chaveNumero(numero: string): string {
  const cnj = /(\d{1,7})-(\d{2})\.(\d{4})\.(\d)\.(\d{2})\.(\d{4})/.exec(numero);
  if (cnj) return `${cnj[1].padStart(7, "0")}${cnj[2]}${cnj[3]}${cnj[4]}${cnj[5]}${cnj[6]}`;
  return digitos(numero);
}

export type { EstadoImportacao } from "./pagina.js";

type LinhaJulgado = { dados: string };

/**
 * Pesquisa's own case-law store: the STJ's open data, imported file by file on an alarm, plus every
 * decision any live source returned (the record `verificar()` checks citations against), cached
 * live searches, and decisions saved to cases.
 */
export class IndiceJurisprudencia extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS julgados (
        id TEXT PRIMARY KEY,
        tribunal TEXT NOT NULL,
        tipo TEXT NOT NULL,
        classe TEXT NOT NULL,
        numero TEXT NOT NULL,
        data TEXT,
        origem TEXT NOT NULL,
        dados TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS julgados_numero ON julgados (tribunal, numero);
      CREATE VIRTUAL TABLE IF NOT EXISTS julgados_fts USING fts5(
        id UNINDEXED, tribunal UNINDEXED, texto, tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE TABLE IF NOT EXISTS importacoes (
        recurso TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        registros INTEGER NOT NULL,
        importado_em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS estado (chave TEXT PRIMARY KEY, valor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cache_buscas (chave TEXT PRIMARY KEY, valor TEXT NOT NULL, criado_em INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS salvos (
        dominio TEXT NOT NULL,
        caso_id TEXT NOT NULL,
        julgado_id TEXT NOT NULL,
        nota TEXT,
        salvo_em INTEGER NOT NULL,
        PRIMARY KEY (dominio, caso_id, julgado_id)
      );
    `);
  }

  /** Searches the local store (the STJ import, and decisions seen before) for these courts. */
  buscarLocal(pedido: { consulta: string; tribunais: string[]; desde?: string; ate?: string; limite: number; origem?: "indice" }): Julgado[] {
    const vistos = new Set<string>();
    const resultados: Julgado[] = [];
    for (const todas of [true, false]) {
      const query = consultaJurisprudencia(pedido.consulta, todas);
      if (!query || resultados.length >= pedido.limite) break;
      const marcadores = pedido.tribunais.map(() => "?").join(", ");
      const linhas = this.ctx.storage.sql
        .exec<LinhaJulgado & { id: string }>(
          `SELECT j.id, j.dados FROM julgados_fts f JOIN julgados j ON j.id = f.id
           WHERE julgados_fts MATCH ? AND f.tribunal IN (${marcadores})
             ${pedido.origem ? "AND j.origem = ?" : ""}
             ${pedido.desde ? "AND j.data >= ?" : ""} ${pedido.ate ? "AND j.data <= ?" : ""}
           ORDER BY bm25(julgados_fts) LIMIT ?`,
          query,
          ...pedido.tribunais,
          ...(pedido.origem ? [pedido.origem] : []),
          ...(pedido.desde ? [pedido.desde] : []),
          ...(pedido.ate ? [pedido.ate] : []),
          pedido.limite * 2,
        )
        .toArray();
      for (const linha of linhas) {
        if (vistos.has(linha.id) || resultados.length >= pedido.limite) continue;
        vistos.add(linha.id);
        resultados.push(JSON.parse(linha.dados) as Julgado);
      }
    }
    return resultados;
  }

  obter(id: string): Julgado | null {
    const linha = this.ctx.storage.sql.exec<LinhaJulgado>("SELECT dados FROM julgados WHERE id = ?", id).toArray()[0];
    return linha ? (JSON.parse(linha.dados) as Julgado) : null;
  }

  /** Decisions (or themes) with this number in this court. */
  porReferencia(ref: Referencia & { tipo?: "acordao" | "tema" }): Julgado[] {
    const tipo = ref.tipo ?? "acordao";
    const linhas = this.ctx.storage.sql
      .exec<LinhaJulgado & { classe: string }>(
        "SELECT dados, classe FROM julgados WHERE tribunal = ? AND numero = ? AND tipo = ?",
        ref.tribunal,
        chaveNumero(ref.numero),
        tipo,
      )
      .toArray();
    const base = ref.classe ? normalizarClasse(classeBase(ref.classe)) : undefined;
    return linhas
      .filter((l) => !base || tipo === "tema" || l.classe === base)
      .map((l) => JSON.parse(l.dados) as Julgado);
  }

  /** Records decisions a source returned. Imported ones keep their origin. */
  registrar(julgados: Julgado[], origem: "indice" | "visto" = "visto"): void {
    for (const j of julgados) {
      if (origem === "visto") {
        const atual = this.ctx.storage.sql
          .exec<{ origem: string }>("SELECT origem FROM julgados WHERE id = ?", j.id)
          .toArray()[0];
        if (atual?.origem === "indice") continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO julgados (id, tribunal, tipo, classe, numero, data, origem, dados)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        j.id,
        j.tribunal,
        j.tipo,
        normalizarClasse(classeBase(j.classe)),
        chaveNumero(j.numero),
        j.dataJulgamento ?? null,
        origem,
        JSON.stringify(j),
      );
      this.ctx.storage.sql.exec("DELETE FROM julgados_fts WHERE id = ?", j.id);
      this.ctx.storage.sql.exec(
        "INSERT INTO julgados_fts (id, tribunal, texto) VALUES (?, ?, ?)",
        j.id,
        j.tribunal,
        [j.classe, j.numero, j.relator, j.orgaoJulgador, j.ementa, j.tese].filter(Boolean).join("\n"),
      );
    }
  }

  lerCache(chave: string, agora = Date.now()): unknown {
    const linha = this.ctx.storage.sql
      .exec<{ valor: string; criado_em: number }>("SELECT valor, criado_em FROM cache_buscas WHERE chave = ?", chave)
      .toArray()[0];
    return linha && agora - linha.criado_em < VALIDADE_CACHE_MS ? JSON.parse(linha.valor) : null;
  }

  gravarCache(chave: string, valor: unknown, agora = Date.now()): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO cache_buscas (chave, valor, criado_em) VALUES (?, ?, ?)",
      chave,
      JSON.stringify(valor),
      agora,
    );
    this.ctx.storage.sql.exec("DELETE FROM cache_buscas WHERE criado_em < ?", agora - VALIDADE_CACHE_MS);
  }

  // --- Decisions saved to cases ---

  salvar(dominio: string, casoId: string, julgadoId: string, nota: string | undefined, agora = Date.now()): JulgadoSalvo {
    const julgado = this.obter(julgadoId);
    if (!julgado) throw new Error("Julgado não encontrado. Busque-o de novo antes de salvar.");
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO salvos (dominio, caso_id, julgado_id, nota, salvo_em) VALUES (?, ?, ?, ?, ?)",
      dominio,
      casoId,
      julgadoId,
      nota ?? null,
      agora,
    );
    return { casoId, julgado, ...(nota ? { nota } : {}), salvoEm: agora };
  }

  removerSalvo(dominio: string, casoId: string, julgadoId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM salvos WHERE dominio = ? AND caso_id = ? AND julgado_id = ?",
      dominio,
      casoId,
      julgadoId,
    );
  }

  salvos(dominio: string, casoId: string): JulgadoSalvo[] {
    return this.ctx.storage.sql
      .exec<{ julgado_id: string; nota: string | null; salvo_em: number; dados: string }>(
        `SELECT s.julgado_id, s.nota, s.salvo_em, j.dados FROM salvos s JOIN julgados j ON j.id = s.julgado_id
         WHERE s.dominio = ? AND s.caso_id = ? ORDER BY s.salvo_em DESC`,
        dominio,
        casoId,
      )
      .toArray()
      .map((l) => ({ casoId, julgado: JSON.parse(l.dados) as Julgado, ...(l.nota ? { nota: l.nota } : {}), salvoEm: l.salvo_em }));
  }

  // --- STJ open-data import ---

  /** Starts (or resumes) the import. Idempotent. */
  async iniciarImportacao(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  estadoImportacao(): EstadoImportacao {
    const importados = this.ctx.storage.sql
      .exec<{ n: number; ultimo: number | null }>("SELECT COUNT(*) AS n, MAX(importado_em) AS ultimo FROM importacoes")
      .one();
    const ultimo = this.ctx.storage.sql
      .exec<{ nome: string }>("SELECT nome FROM importacoes ORDER BY importado_em DESC LIMIT 1")
      .toArray()[0];
    const contar = (tipo: string) =>
      this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM julgados WHERE tribunal = 'STJ' AND origem = 'indice' AND tipo = ?", tipo)
        .one().n;
    const pendentes = JSON.parse(this.#estado("pendentes") ?? "[]") as RecursoStj[];
    const erro = this.#estado("erro");
    return {
      arquivosImportados: importados.n,
      arquivosPendentes: pendentes.length,
      julgadosStj: contar("acordao"),
      temasStj: contar("tema"),
      ...(ultimo ? { ultimoArquivo: ultimo.nome } : {}),
      ...(importados.ultimo ? { ultimaImportacao: importados.ultimo } : {}),
      ...(erro ? { erro } : {}),
    };
  }

  /** One step of the import: refresh the file list when due, then import the next file. */
  async alarm(): Promise<void> {
    const agora = Date.now();
    const ctxFonte: ContextoFonte = { fetch: fetchIndice, agora: () => Date.now() };
    try {
      let pendentes = JSON.parse(this.#estado("pendentes") ?? "[]") as RecursoStj[];
      const listadoEm = Number(this.#estado("listado_em") ?? 0);
      if (pendentes.length === 0 && agora - listadoEm >= INTERVALO_LISTAGEM_MS) {
        pendentes = (await listarRecursos(ctxFonte)).filter((r) => this.#precisaImportar(r, agora));
        this.#definirEstado("listado_em", String(agora));
      }
      const proximo = pendentes.shift();
      if (proximo) {
        const registros = await this.#importar(proximo, ctxFonte);
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO importacoes (recurso, nome, registros, importado_em) VALUES (?, ?, ?, ?)",
          proximo.id,
          `${proximo.dataset}/${proximo.nome}`,
          registros,
          agora,
        );
      }
      this.#definirEstado("pendentes", JSON.stringify(pendentes));
      this.ctx.storage.sql.exec("DELETE FROM estado WHERE chave = 'erro'");
      await this.ctx.storage.setAlarm(pendentes.length ? agora + PAUSA_ENTRE_ARQUIVOS_MS : agora + INTERVALO_LISTAGEM_MS);
    } catch (erro) {
      this.#definirEstado("erro", erro instanceof Error ? erro.message : String(erro));
      await this.ctx.storage.setAlarm(agora + PAUSA_APOS_ERRO_MS);
    }
  }

  #precisaImportar(recurso: RecursoStj, agora: number): boolean {
    const linha = this.ctx.storage.sql
      .exec<{ importado_em: number }>("SELECT importado_em FROM importacoes WHERE recurso = ?", recurso.id)
      .toArray()[0];
    if (!linha) return true;
    return recurso.tipo === "temas" && agora - linha.importado_em >= INTERVALO_TEMAS_MS;
  }

  async #importar(recurso: RecursoStj, ctx: ContextoFonte): Promise<number> {
    const resposta = await ctx.fetch(recurso.url);
    if (!resposta.ok) throw new Error(`STJ dados abertos respondeu ${resposta.status} para ${recurso.nome}.`);
    const agora = ctx.agora();
    const julgados =
      recurso.tipo === "temas"
        ? lerCsv(await resposta.text()).map((l) => julgadoDeTema(l, agora))
        : ((await resposta.json()) as EspelhoStj[]).map((e) => julgadoDeEspelho(e, agora));
    const validos = julgados.filter((j): j is Julgado => j !== null);
    this.registrar(validos, "indice");
    return validos.length;
  }

  #estado(chave: string): string | undefined {
    return this.ctx.storage.sql.exec<{ valor: string }>("SELECT valor FROM estado WHERE chave = ?", chave).toArray()[0]?.valor;
  }

  #definirEstado(chave: string, valor: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO estado (chave, valor) VALUES (?, ?)", chave, valor);
  }
}
