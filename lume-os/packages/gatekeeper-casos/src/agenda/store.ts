import { DurableObject } from "cloudflare:workers";
import type { GatekeeperNotification } from "@gadgets/workshop-shared/gatekeeper";
import { Calendario, diasSemExpediente, formatarData, hojeEmBrasilia, somarDias, type Feriado, type Local } from "./calendario.js";
import { compararCompromissos, resolver, responsaveisDe, type DadosCompromisso, type Entrada, type Reprogramado } from "./compromisso.js";

export type { Reprogramado } from "./compromisso.js";
import { calcularPrazo } from "./prazos.js";
import type { CalculoPrazo, Compromisso, DiaSemExpediente, RegraPrazo, StatusCompromisso } from "./types.js";

export type { Feriado } from "./calendario.js";

/** Upper bound on stored entries; lists are filtered in memory past the SQL date range. */
export const MAX_COMPROMISSOS = 50_000;
export const MAX_FERIADOS = 2_000;

const NOTA_RECONTAGEM = "Recontado em";

/** The morning summary goes out from this hour, Brasília time. */
const HORA_RESUMO = 7;
/** Hearings and meetings are announced this long before they start. */
const ANTECEDENCIA_LEMBRETE_MS = 2 * 60 * 60 * 1000;
/** A reminder nobody picked up within a day is stale. */
const AVISO_VALIDADE_MS = 24 * 60 * 60 * 1000;

function horaEmBrasilia(agora: number): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hourCycle: "h23" }).format(agora));
}

/** Reminder preferences, per user. */
export type PreferenciasAgenda = {
  /** Every working day at 07:00, the agent opens a conversation with the day's summary. */
  resumoConversa: boolean;
};

/** What the agent is asked in the daily summary conversation. */
export function promptResumo(usuario: string, hoje: string, limite: string): string {
  return (
    `Bom dia. Monte o resumo da minha agenda de hoje, ${formatarData(hoje)}. ` +
    `Use AGENDA.listar({ responsavel: ${JSON.stringify(usuario)}, ate: ${JSON.stringify(limite)} }) para ver o que é meu, ` +
    "vencido ou vencendo até lá, e leia em CASOS os casos ligados. Diga o que fazer primeiro, " +
    "o que depende de documentos do Cofre e o que convém confirmar (a memória de cada prazo). " +
    "Não crie nem altere nada sem eu pedir."
  );
}

/** Brazil has kept UTC-3 all year since 2019. */
function inicioEmBrasilia(data: string, hora: string): number {
  return Date.parse(`${data}T${hora}:00-03:00`);
}


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
      CREATE TABLE IF NOT EXISTS avisos (
        id TEXT PRIMARY KEY,
        dados TEXT NOT NULL,
        criado_em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS avisos_gerados (
        chave TEXT PRIMARY KEY,
        criado_em INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS preferencias (
        usuario TEXT PRIMARY KEY,
        resumo_conversa INTEGER NOT NULL DEFAULT 0
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

  /** Stores an entry suggested by case tracking, pending a lawyer's confirmation. */
  criarSugestao(entrada: Entrada, caso: { tribunal?: string } | null, sugestao: { origem: string; intimacaoId?: string }): Compromisso {
    return this.criar(crypto.randomUUID(), { ...this.resolver(entrada, "pendente", caso), sugestao });
  }

  /** A lawyer confirmed a suggested entry: from now on it is an ordinary one. */
  confirmarSugestao(id: string, now = Date.now()): Compromisso {
    const atual = this.obter(id);
    if (!atual) throw new Error("Compromisso não encontrado.");
    const { sugestao: _s, ...confirmado } = atual;
    const c = { ...confirmado, atualizadoEm: now } as Compromisso;
    this.#gravar(c);
    return c;
  }

  /** Drops a suggestion nobody wants. Confirmed entries are not touched. */
  descartarSugestao(id: string): void {
    if (this.obter(id)?.sugestao) this.excluir(id);
  }

  /** Recounts a still-suggested deadline under a new rule (the notice was opened). */
  recontarSugestao(id: string, regra: RegraPrazo, now = Date.now()): Compromisso | null {
    const atual = this.obter(id);
    if (!atual?.sugestao) return null;
    const calculo = this.calcular(regra, { tribunal: atual.tribunal, comarca: atual.comarca });
    // A task "Analisar …" (length unknown until the notice was opened) becomes the deadline itself.
    const titulo = atual.tipo === "tarefa" ? atual.titulo.replace(/^Analisar (\S)/, (_, c: string) => c.toUpperCase()) : atual.titulo;
    const c: Compromisso = { ...atual, tipo: "prazo", titulo, data: calculo.vencimento, prazo: { regra, calculo }, atualizadoEm: now };
    this.#gravar(c);
    return c;
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

  /**
   * Reminders waiting for delivery, generating any that are due first: the 07:00 summary on working
   * days and a reminder two hours before hearings and meetings. `casos` maps case ids to their
   * titles and responsible lawyers. Each reminder stays here until `confirmarAvisos()`.
   */
  retirarAvisos(casos: Record<string, { titulo: string; responsaveis: string[] }>, agora = Date.now()): GatekeeperNotification[] {
    this.#gerarAvisos(casos, agora);
    this.ctx.storage.sql.exec("DELETE FROM avisos WHERE criado_em < ?", agora - AVISO_VALIDADE_MS);
    return this.ctx.storage.sql
      .exec<{ dados: string }>("SELECT dados FROM avisos ORDER BY criado_em LIMIT 200")
      .toArray()
      .map((row) => JSON.parse(row.dados) as GatekeeperNotification);
  }

  /** One user's reminder preferences. */
  preferencias(usuario: string): PreferenciasAgenda {
    const row = this.ctx.storage.sql
      .exec<{ resumo_conversa: number }>("SELECT resumo_conversa FROM preferencias WHERE usuario = ?", usuario)
      .toArray()[0];
    return { resumoConversa: row?.resumo_conversa === 1 };
  }

  salvarPreferencias(usuario: string, preferencias: PreferenciasAgenda): PreferenciasAgenda {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO preferencias (usuario, resumo_conversa) VALUES (?, ?)",
      usuario,
      preferencias.resumoConversa ? 1 : 0,
    );
    return this.preferencias(usuario);
  }

  /** Drops delivered reminders. */
  confirmarAvisos(ids: string[]): void {
    for (const id of ids.slice(0, 500)) this.ctx.storage.sql.exec("DELETE FROM avisos WHERE id = ?", String(id));
  }

  #gerarAvisos(casos: Record<string, { titulo: string; responsaveis: string[] }>, agora: number): void {
    const hoje = hojeEmBrasilia(new Date(agora));
    const calendario = new Calendario([]);
    const doCaso = new Map(Object.entries(casos).map(([id, c]) => [id, c.responsaveis]));
    const tituloCaso = (c: Compromisso) => (c.casoId ? casos[c.casoId]?.titulo : undefined);

    // The morning summary, once per working day.
    if (horaEmBrasilia(agora) >= HORA_RESUMO && calendario.ehDiaUtil(hoje) && this.#marcar(`resumo:${hoje}`, agora)) {
      const limite = calendario.somarDiasUteis(hoje, 7);
      const conversa = new Set(this.ctx.storage.sql
        .exec<{ usuario: string }>("SELECT usuario FROM preferencias WHERE resumo_conversa = 1")
        .toArray()
        .map((row) => row.usuario));
      const porPessoa = new Map<string, Compromisso[]>();
      for (const c of this.consultar({ status: "pendente", ate: limite })) {
        for (const pessoa of responsaveisDe(c, doCaso)) {
          const lista = porPessoa.get(pessoa) ?? [];
          lista.push(c);
          porPessoa.set(pessoa, lista);
        }
      }
      for (const [pessoa, lista] of porPessoa) {
        const vencidos = lista.filter((c) => c.data < hoje).length;
        const deHoje = lista.filter((c) => c.data === hoje).length;
        const titulo = [
          vencidos ? `${vencidos} vencido(s)` : undefined,
          deHoje ? `${deHoje} para hoje` : undefined,
          lista.length - vencidos - deHoje ? `${lista.length - vencidos - deHoje} nos próximos 7 dias úteis` : undefined,
        ].filter(Boolean).join(" · ");
        const linhas = lista.slice(0, 4).map((c) => {
          const quando = c.data < hoje ? `Vencido ${formatarData(c.data).slice(0, 5)}` :
            c.data === hoje ? "Hoje" : formatarData(c.data).slice(0, 5);
          const caso = tituloCaso(c);
          return `${quando}${c.hora ? ` ${c.hora}` : ""}: ${c.titulo}${caso ? ` (${caso})` : ""}${c.sugestao ? " — a confirmar" : ""}`;
        });
        if (lista.length > 4) linhas.push(`e mais ${lista.length - 4}`);
        this.#enfileirar({
          id: `resumo:${hoje}:${pessoa}`,
          usernames: [pessoa],
          title: `Agenda: ${titulo}`,
          body: linhas.join("\n"),
          url: "/gatekeepers/agenda",
          tag: "agenda-resumo",
          ...(conversa.has(pessoa) ? {
            conversation: { title: `Prazos de ${formatarData(hoje)}`, prompt: promptResumo(pessoa, hoje, limite) },
          } : {}),
        }, agora);
      }
    }

    // Two hours before hearings and meetings.
    const amanha = somarDias(hoje, 1);
    for (const c of this.consultar({ status: "pendente", de: hoje, ate: amanha })) {
      if (!c.hora || (c.tipo !== "audiencia" && c.tipo !== "reuniao")) continue;
      const inicio = inicioEmBrasilia(c.data, c.hora);
      if (inicio <= agora || inicio - agora > ANTECEDENCIA_LEMBRETE_MS) continue;
      const pessoas = responsaveisDe(c, doCaso);
      if (!pessoas.length || !this.#marcar(`lembrete:${c.id}:${c.data}T${c.hora}`, agora)) continue;
      const caso = tituloCaso(c);
      this.#enfileirar({
        id: `lembrete:${c.id}:${c.data}T${c.hora}`,
        usernames: pessoas,
        title: `${c.tipo === "audiencia" ? "Audiência" : "Reunião"} às ${c.hora}: ${c.titulo}`,
        body: [caso, c.local, c.link ? "Link da videochamada na Agenda" : undefined].filter(Boolean).join(" · ") || "Hoje",
        url: "/gatekeepers/agenda",
        tag: `agenda-${c.id}`,
      }, agora);
    }

    this.ctx.storage.sql.exec("DELETE FROM avisos_gerados WHERE criado_em < ?", agora - 40 * 86_400_000);
  }

  /** Records that a reminder was generated; false when it already was. */
  #marcar(chave: string, agora: number): boolean {
    const novo = this.ctx.storage.sql
      .exec<{ chave: string }>("INSERT OR IGNORE INTO avisos_gerados (chave, criado_em) VALUES (?, ?) RETURNING chave", chave, agora)
      .toArray();
    return novo.length > 0;
  }

  #enfileirar(aviso: GatekeeperNotification, agora: number): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO avisos (id, dados, criado_em) VALUES (?, ?, ?)",
      aviso.id,
      JSON.stringify(aviso),
      agora,
    );
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
