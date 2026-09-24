import { DurableObject } from "cloudflare:workers";
import {
  applyAlteracoes,
  compareCasos,
  previousValues,
  type Alteracoes,
  type DadosCaso,
} from "./caso.js";
import type { Caso } from "./types.js";

/**
 * Upper bound on a firm's case count. Lists are filtered in memory, which stays cheap well past
 * the caseload of the small and mid-sized firms Lume targets.
 */
export const MAX_CASOS = 5_000;

/**
 * The firm's cases: one instance per sharing domain, named by it, so every lawyer of a deployment
 * reads and writes the same registry. Callers validate input with `caso.ts` first; this class only
 * enforces what needs the whole registry to check (unique ids and CNJ numbers, the size cap).
 */
export class CaseRegistry extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS casos (
        id TEXT PRIMARY KEY,
        numero_cnj TEXT UNIQUE,
        data TEXT NOT NULL
      )
    `);
  }

  /** Every case, most recently changed first. */
  list(): Caso[] {
    return this.#all().toSorted(compareCasos);
  }

  /** The case with this id, or null. */
  get(id: string): Caso | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM casos WHERE id = ?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.data) as Caso) : null;
  }

  /** The case with this normalized CNJ number, or null. */
  findByNumero(numeroCnj: string): Caso | null {
    const row = this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM casos WHERE numero_cnj = ?", numeroCnj)
      .toArray()[0];
    return row ? (JSON.parse(row.data) as Caso) : null;
  }

  /** Stores a new case under `id`. Throws if the id or CNJ number is taken, or the firm is full. */
  create(id: string, dados: DadosCaso, now = Date.now()): Caso {
    if (this.get(id)) throw new Error(`Já existe um caso com o id ${id}.`);
    const count = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM casos").one().n;
    if (count >= MAX_CASOS) throw new Error(`O escritório atingiu o limite de ${MAX_CASOS} casos.`);
    this.#assertNumeroLivre(dados.numeroCnj, id);
    const caso: Caso = { ...dados, id, criadoEm: now, atualizadoEm: now };
    this.#write(caso);
    return caso;
  }

  /**
   * Applies changes to a case. Returns the updated case and the values it overwrote, so the change
   * can be reverted. Throws if the case is gone or the new CNJ number belongs to another case.
   */
  update(id: string, alteracoes: Alteracoes, now = Date.now()): { caso: Caso; anterior: Alteracoes } {
    const current = this.get(id);
    if (!current) throw new Error(`Caso não encontrado: ${id}.`);
    if (alteracoes.numeroCnj) this.#assertNumeroLivre(alteracoes.numeroCnj, id);
    const caso = applyAlteracoes(current, alteracoes, now);
    this.#write(caso);
    return { caso, anterior: previousValues(current, alteracoes) };
  }

  /** Deletes a case, returning it, or null when it did not exist. */
  delete(id: string): Caso | null {
    const caso = this.get(id);
    if (caso) this.ctx.storage.sql.exec("DELETE FROM casos WHERE id = ?", id);
    return caso;
  }

  #write(caso: Caso): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO casos (id, numero_cnj, data) VALUES (?, ?, ?)",
      caso.id,
      caso.numeroCnj ?? null,
      JSON.stringify(caso),
    );
  }

  #assertNumeroLivre(numeroCnj: string | undefined, id: string): void {
    if (!numeroCnj) return;
    const owner = this.findByNumero(numeroCnj);
    if (owner && owner.id !== id) {
      throw new Error(`O número ${numeroCnj} já pertence ao caso "${owner.titulo}".`);
    }
  }

  #all(): Caso[] {
    return this.ctx.storage.sql
      .exec<{ data: string }>("SELECT data FROM casos")
      .toArray()
      .map((row) => JSON.parse(row.data) as Caso);
  }
}
