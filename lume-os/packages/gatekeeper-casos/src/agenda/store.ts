import { DurableObject } from "cloudflare:workers";
import { Calendario, diasSemExpediente, formatarData, hojeEmBrasilia, type Feriado, type Local } from "./calendario.js";
import { compararCompromissos, resolver, type DadosCompromisso, type Entrada, type Reprogramado } from "./compromisso.js";

export type { Reprogramado } from "./compromisso.js";
import { calcularPrazo } from "./prazos.js";
import type { CalculoPrazo, Compromisso, DiaSemExpediente, RegraPrazo, StatusCompromisso } from "./types.js";

export type { Feriado } from "./calendario.js";

/** Upper bound on stored entries; lists are filtered in memory past the SQL date range. */
export const MAX_COMPROMISSOS = 50_000;
export const MAX_FERIADOS = 2_000;

const NOTA_RECONTAGEM = "Recontado em";


export function agendaFor(exports: Cloudflare.Exports, sharingDomain: string): DurableObjectStub<AgendaStore> {
  return exports.AgendaStore.getByName(sharingDomain);
}

/**
 * The firm's calendar: one instance per sharing domain, like the case registry. Callers validate
 * input with `compromisso.ts`; this class dates entries and keeps counted deadlines in step with
 * the holidays the firm registers.
 */
export class AgendaStore extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS compromissos (
        id TEXT PRIMARY KEY,
        caso_id TEXT,
        data TEXT NOT NULL,
        status TEXT NOT NULL,
        dados TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS compromissos_data ON compromissos (status, data);
      CREATE INDEX IF NOT EXISTS compromissos_caso ON compromissos (caso_id);
      CREATE TABLE IF NOT EXISTS feriados (
        id TEXT PRIMARY KEY,
        dados TEXT NOT NULL
      );
    `);
  }

  /** Entries in a date range and status, in calendar order. */
  consultar(filtro: { de?: string; ate?: string; status?: StatusCompromisso | "todos"; casoId?: string } = {}): Compromisso[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filtro.status && filtro.status !== "todos") {
      where.push("status = ?");
      args.push(filtro.status);
    }
    if (filtro.de) {
      where.push("data >= ?");
      args.push(filtro.de);
    }
    if (filtro.ate) {
      where.push("data <= ?");
      args.push(filtro.ate);
    }
    if (filtro.casoId) {
      where.push("caso_id = ?");
      args.push(filtro.casoId);
    }
    return this.ctx.storage.sql
      .exec<{ dados: string }>(
        `SELECT dados FROM compromissos ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
        ...args,
      )
      .toArray()
      .map((row) => JSON.parse(row.dados) as Compromisso)
      .toSorted(compararCompromissos);
  }

  obter(id: string): Compromisso | null {
    const row = this.ctx.storage.sql
      .exec<{ dados: string }>("SELECT dados FROM compromissos WHERE id = ?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.dados) as Compromisso) : null;
  }

  /** Dates an entry on today's calendar without storing it. */
  resolver(entrada: Entrada, status: StatusCompromisso, caso: { tribunal?: string } | null): DadosCompromisso {
    return resolver(entrada, status, caso, this.#feriados());
  }

  /**
   * Stores a new entry under `id`. A counted deadline is recounted here, so holidays registered
   * between a proposal and its approval still count.
   */
  criar(id: string, dados: DadosCompromisso, now = Date.now()): Compromisso {
    if (this.obter(id)) throw new Error(`Já existe um compromisso com o id ${id}.`);
    const total = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM compromissos").one().n;
    if (total >= MAX_COMPROMISSOS) throw new Error(`A agenda atingiu o limite de ${MAX_COMPROMISSOS} compromissos.`);
    const compromisso = this.#recontado({ ...dados, id, criadoEm: now, atualizadoEm: now });
    this.#gravar(compromisso);
    return compromisso;
  }

  /** Replaces an entry's fields, returning the previous record for reverting. */
  substituir(id: string, dados: DadosCompromisso, now = Date.now()): { compromisso: Compromisso; anterior: Compromisso } {
    const anterior = this.obter(id);
    if (!anterior) throw new Error("Compromisso não encontrado.");
    const compromisso = this.#recontado({ ...dados, id, criadoEm: anterior.criadoEm, atualizadoEm: now });
    this.#gravar(compromisso);
    return { compromisso, anterior };
  }

  /** Puts back a record exactly as it was (reverting a change). */
  restaurar(compromisso: Compromisso): void {
    this.#gravar(compromisso);
  }

  excluir(id: string): void {
    this.ctx.storage.sql.exec("DELETE FROM compromissos WHERE id = ?", id);
  }

  /** Deletes every entry of a case, when the case goes. */
  excluirDoCaso(casoId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM compromissos WHERE caso_id = ?", casoId);
  }

  /** Counts a deadline on the calendar of a place. */
  calcular(regra: RegraPrazo, local: Local): CalculoPrazo {
    return calcularPrazo(regra, new Calendario(this.#feriados(), local));
  }

  /** The firm's registered holidays and suspensions, by date. */
  feriados(): Feriado[] {
    return this.#feriados();
  }

  /** National and registered days without court business in a range. */
  diasSemExpediente(de: string, ate: string, local?: Local): DiaSemExpediente[] {
    return diasSemExpediente(this.#feriados(), de, ate, local);
  }

  /** Registers a holiday or suspension and recounts the pending deadlines it moves. */
  adicionarFeriado(id: string, feriado: Omit<Feriado, "id">): Reprogramado[] {
    const total = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM feriados").one().n;
    if (total >= MAX_FERIADOS) throw new Error(`O calendário atingiu o limite de ${MAX_FERIADOS} feriados.`);
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO feriados (id, dados) VALUES (?, ?)",
      id,
      JSON.stringify({ ...feriado, id }),
    );
    return this.#recontarPendentes(`feriado cadastrado: ${feriado.descricao}`);
  }

  /** Removes a holiday or suspension and recounts the pending deadlines it had moved. */
  removerFeriado(id: string): Reprogramado[] {
    const row = this.ctx.storage.sql.exec<{ dados: string }>("SELECT dados FROM feriados WHERE id = ?", id).toArray()[0];
    if (!row) return [];
    const feriado = JSON.parse(row.dados) as Feriado;
    this.ctx.storage.sql.exec("DELETE FROM feriados WHERE id = ?", id);
    return this.#recontarPendentes(`feriado removido: ${feriado.descricao}`);
  }

  #feriados(): Feriado[] {
    return this.ctx.storage.sql
      .exec<{ dados: string }>("SELECT dados FROM feriados")
      .toArray()
      .map((row) => JSON.parse(row.dados) as Feriado)
      .toSorted((a, b) => a.data.localeCompare(b.data));
  }

  /** The entry with its deadline counted on today's calendar (unchanged when it has no rule). */
  #recontado<T extends DadosCompromisso>(c: T): T {
    if (!c.prazo) return c;
    const calculo = this.calcular(c.prazo.regra, { tribunal: c.tribunal, comarca: c.comarca });
    // Earlier recounts stay on record.
    calculo.memoria.push(...(c.prazo.calculo?.memoria ?? []).filter((linha) => linha.startsWith(NOTA_RECONTAGEM)));
    return { ...c, data: calculo.vencimento, prazo: { regra: c.prazo.regra, calculo } };
  }

  #recontarPendentes(motivo: string): Reprogramado[] {
    const movidos: Reprogramado[] = [];
    const hoje = hojeEmBrasilia();
    for (const c of this.consultar({ status: "pendente" })) {
      if (!c.prazo) continue;
      const novo = this.#recontado(c);
      if (novo.data === c.data) continue;
      const nota = `${NOTA_RECONTAGEM} ${formatarData(hoje)} (${motivo}): o vencimento passou de ` +
        `${formatarData(c.data)} para ${formatarData(novo.data)}.`;
      novo.prazo!.calculo.memoria.push(nota);
      novo.atualizadoEm = Date.now();
      this.#gravar(novo);
      movidos.push({ id: c.id, titulo: c.titulo, de: c.data, para: novo.data });
    }
    return movidos;
  }

  #gravar(c: Compromisso): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO compromissos (id, caso_id, data, status, dados) VALUES (?, ?, ?, ?, ?)",
      c.id,
      c.casoId ?? null,
      c.data,
      c.status,
      JSON.stringify(c),
    );
  }
}
