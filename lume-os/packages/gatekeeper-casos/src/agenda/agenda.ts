import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
  ActionDescription,
  ActionKind,
  AgentCatalog,
  AppUiContext,
  ApprovalQueue,
  Gatekeeper,
  GatekeeperConnectCallback,
  GatekeeperConnectOptions,
  GatekeeperNotification,
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import { DEFAULT_SHARING_DOMAIN, registryFor } from "../casos.js";
import type { CaseRegistry } from "../registry.js";
import type { Caso } from "../types.js";
import { Calendario, formatarData, formatarDataComDia, hojeEmBrasilia, type Feriado } from "./calendario.js";
import {
  aplicarAlteracoes,
  compararCompromissos,
  corresponde,
  entradaDe,
  responsaveisDe,
  validarAlteracoes,
  validarFeriado,
  validarFiltro,
  validarNovo,
  type Alteracoes,
  type DadosCompromisso,
  type Entrada,
  type Filtro,
} from "./compromisso.js";
import { validarRegra } from "./prazos.js";
import { agendaFor, type AgendaStore, type PreferenciasAgenda, type Reprogramado } from "./store.js";
import type {
  AgendaSession,
  AlteracoesCompromisso,
  CalculoPrazo,
  Compromisso,
  DiaSemExpediente,
  FiltroAgenda,
  LocalPrazo,
  NovoCompromisso,
  NovoFeriado,
  RegraPrazo,
  TipoCompromisso,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "../generated/app.txt";

/** Phosphor "Calendar" icon, drawn with currentColor so the Workshop can tint it. */
const AGENDA_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M208 32h-24v-8a8 8 0 0 0-16 0v8H88v-8a8 8 0 0 0-16 0v8H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16ZM72 48v8a8 8 0 0 0 16 0v-8h80v8a8 8 0 0 0 16 0v-8h24v32H48V48Zm136 160H48V96h160v112Z'/></svg>",
    ),
};

/** The page HTML is shared with Casos; this attribute tells it which page to render. */
const AGENDA_HTML = APP_HTML.replace("<html", '<html data-app="agenda"');

const CRIAR_KIND: ActionKind = { tag: "agenda.criar", label: "Agendar compromisso" };
const ALTERAR_KIND: ActionKind = { tag: "agenda.alterar", label: "Alterar compromisso" };
const FERIADO_KIND: ActionKind = { tag: "agenda.feriado", label: "Cadastrar feriado ou suspensão" };

/** How many upcoming entries the agent catalog lists. */
const CATALOG_LIMIT = 100;
/** Days ahead the agent catalog covers. */
const CATALOG_DIAS_UTEIS = 10;
const MAX_DIAS_UTEIS = 60;

const TIPO_LABEL: Record<TipoCompromisso, string> = {
  prazo: "Prazo",
  audiencia: "Audiência",
  tarefa: "Tarefa",
  reuniao: "Reunião",
};

type AgendaProps = { sharingDomain: string };

type PropostaRow = {
  id: number;
  kind: "criar" | "alterar" | "feriado";
  alvo: string;
  payload: string;
  submitted_at: number;
  state: "pending" | "applied";
  anterior: string | null;
};

/** Each case's responsible lawyers, for entries that name none of their own. */
function responsaveisPorCaso(casos: Caso[]): Map<string, string[]> {
  return new Map(casos.map((caso) => [caso.id, caso.responsaveis]));
}

/** The day `diasUteis` working days from today, on the national calendar. */
function limiteDiasUteis(diasUteis: number, hoje = hojeEmBrasilia()): string {
  return new Calendario([]).somarDiasUteis(hoje, diasUteis);
}

/**
 * What a session needs from its facet. Plain closures rather than facet methods, so none of this is
 * reachable over RPC by whoever holds the facet.
 */
export type AgendaBackend = {
  simulados(filtro: Filtro): Promise<Compromisso[]>;
  casos(): Promise<Caso[]>;
  store(): DurableObjectStub<AgendaStore>;
  tribunalDe(local: LocalPrazo | undefined): Promise<{ tribunal?: string; comarca?: string }>;
  proporCriar(queue: NativeRpcStub<ApprovalQueue>, entrada: Entrada): Promise<string>;
  proporAlterar(queue: NativeRpcStub<ApprovalQueue>, id: string, alteracoes: Alteracoes): Promise<void>;
  proporFeriado(queue: NativeRpcStub<ApprovalQueue>, feriado: Omit<Feriado, "id">): Promise<void>;
};

@validateRpc()
export class AgendaSessionImpl extends RpcTarget implements AgendaSession {
  readonly #backend: AgendaBackend;
  readonly #queue: NativeRpcStub<ApprovalQueue>;

  constructor(backend: AgendaBackend, queue: NativeRpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  /** Counts a deadline without saving anything. */
  async calcularPrazo(regra: RegraPrazo, local?: LocalPrazo): Promise<CalculoPrazo> {
    const valida = validarRegra(regra);
    const onde = await this.#backend.tribunalDe(local);
    const calculo = await this.#backend.store().calcular(valida, onde);
    await this.#queue.authorizeObservation({
      title: "Calcular prazo",
      description: `Calculou um prazo de ${valida.dias} dia(s)${onde.tribunal ? ` no ${onde.tribunal}` : ""}: ` +
        `vence em ${formatarData(calculo.vencimento)}.`,
    });
    return calculo;
  }

  /** Lists entries matching `filtro`. */
  async listar(filtro?: FiltroAgenda): Promise<Compromisso[]> {
    const valido = validarFiltro(filtro);
    const lista = await this.#backend.simulados(valido);
    await this.#queue.authorizeObservation({
      title: "Consultar a agenda",
      description: `Listou ${lista.length} compromisso(s) da agenda do escritório.`,
    });
    return lista;
  }

  /** Pending entries due within the next working days, overdue ones included. */
  async proximos(diasUteis?: number): Promise<Compromisso[]> {
    const n = diasUteis ?? 7;
    if (!Number.isInteger(n) || n < 0 || n > MAX_DIAS_UTEIS) {
      throw new TypeError(`diasUteis deve ser um inteiro de 0 a ${MAX_DIAS_UTEIS}.`);
    }
    const lista = await this.#backend.simulados({ status: "pendente", ate: limiteDiasUteis(n) });
    await this.#queue.authorizeObservation({
      title: "Consultar os próximos compromissos",
      description: `Listou ${lista.length} compromisso(s) pendente(s) até ${n} dia(s) útil(eis) adiante.`,
    });
    return lista;
  }

  /** Proposes a new entry. */
  criar(novo: NovoCompromisso): Promise<string> {
    return this.#backend.proporCriar(this.#queue, validarNovo(novo));
  }

  /** Proposes changes to an entry. */
  alterar(id: string, alteracoes: AlteracoesCompromisso): Promise<void> {
    return this.#backend.proporAlterar(this.#queue, id, validarAlteracoes(alteracoes));
  }

  /** Proposes marking an entry as done. */
  concluir(id: string): Promise<void> {
    return this.#backend.proporAlterar(this.#queue, id, { status: "cumprido" });
  }

  /** Proposes cancelling an entry. */
  cancelar(id: string): Promise<void> {
    return this.#backend.proporAlterar(this.#queue, id, { status: "cancelado" });
  }

  /** Days without court business in a range. */
  async feriados(de: string, ate: string, local?: LocalPrazo): Promise<DiaSemExpediente[]> {
    if (typeof de !== "string" || typeof ate !== "string" || de > ate) {
      throw new TypeError("Informe de e ate como datas AAAA-MM-DD, com de <= ate.");
    }
    if (Date.parse(ate) - Date.parse(de) > 3 * 366 * 86_400_000) {
      throw new TypeError("Consulte no máximo três anos por vez.");
    }
    const onde = local ? await this.#backend.tribunalDe(local) : undefined;
    const dias = await this.#backend.store().diasSemExpediente(de, ate, onde);
    await this.#queue.authorizeObservation({
      title: "Consultar feriados",
      description: `Listou ${dias.length} dia(s) sem expediente entre ${formatarData(de)} e ${formatarData(ate)}.`,
    });
    return dias;
  }

  /** Proposes registering a local holiday or suspension. */
  proporFeriado(feriado: NovoFeriado): Promise<void> {
    return this.#backend.proporFeriado(this.#queue, validarFeriado(feriado));
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

/**
 * The agent singleton, one facet per workspace. Like the Casos facet, it keeps the proposals made
 * through its sessions, applies them once a lawyer approves, and lays pending ones over reads.
 */
@validateRpc()
export class AgendaGatekeeper
  extends DurableObject<Cloudflare.Env, AgendaProps>
  implements Gatekeeper<AgendaSession>
{
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS propostas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        alvo TEXT NOT NULL,
        payload TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        anterior TEXT
      )
    `);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "agenda://escritorio",
      title: "Agenda",
      snippet: "Prazos, audiências, tarefas e reuniões do escritório, com contagem de prazos processuais.",
      suggestedBindingName: "AGENDA",
      tsType: "AgendaSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Scheduling and updating entries may be auto-approved: they are reversible and the lawyer asked
   * for them. A holiday recounts every deadline of the firm, so it always waits for a lawyer.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [CRIAR_KIND, ALTERAR_KIND];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<AgendaSession> {
    return new AgendaSessionImpl({
      simulados: (filtro) => this.#simulados(filtro),
      casos: () => this.#registry().list(),
      store: () => this.#store(),
      tribunalDe: (local) => this.#tribunalDe(local),
      proporCriar: (queue, entrada) => this.#proporCriar(queue, entrada),
      proporAlterar: (queue, id, alteracoes) => this.#proporAlterar(queue, id, alteracoes),
      proporFeriado: (queue, feriado) => this.#proporFeriado(queue, feriado),
    }, approvalQueue.dup());
  }

  /** Lists what is due soon, so the agent sees the firm's urgent work without asking. */
  async getAgentCatalog(authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    const limite = limiteDiasUteis(CATALOG_DIAS_UTEIS);
    const lista = await this.#simulados({ status: "pendente", ate: limite });
    await authorizer.authorizeObservation({
      title: "Listar próximos compromissos",
      description: `Listou ${lista.length} compromisso(s) pendente(s) até ${formatarData(limite)}.`,
    });
    return boundAgentCatalog(
      lista.slice(0, CATALOG_LIMIT).map((c) => ({
        id: c.id,
        title: `${TIPO_LABEL[c.tipo]}: ${c.titulo}`,
        description: [
          `${c.tipo === "prazo" ? "Vence" : "Em"} ${formatarDataComDia(c.data)}${c.hora ? ` às ${c.hora}` : ""}`,
          c.casoId ? `caso ${c.casoId}` : undefined,
          c.responsaveis.length ? `responsáveis: ${c.responsaveis.join(", ")}` : undefined,
        ].filter(Boolean).join(" · "),
      })),
    );
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    const row = this.#row(action);
    if (!row || row.state !== "pending") throw new Error(`Proposta ${action} não está pendente.`);
    const store = this.#store();
    let anterior: unknown = null;
    if (row.kind === "criar") {
      const dados = JSON.parse(row.payload) as DadosCompromisso;
      if (dados.casoId && !(await this.#registry().get(dados.casoId))) {
        throw new Error("O caso deste compromisso não existe mais.");
      }
      await store.criar(row.alvo, dados);
    } else if (row.kind === "alterar") {
      const atual = await store.obter(row.alvo);
      if (!atual) throw new Error("O compromisso não existe mais. Aprove primeiro a proposta que o cria.");
      const alteracoes = JSON.parse(row.payload) as Alteracoes;
      const dados = await this.#aplicar(atual, alteracoes, store);
      anterior = (await store.substituir(row.alvo, dados)).anterior;
    } else {
      await store.adicionarFeriado(row.alvo, JSON.parse(row.payload) as Omit<Feriado, "id">);
    }
    this.ctx.storage.sql.exec(
      "UPDATE propostas SET state = 'applied', anterior = ? WHERE id = ?",
      anterior === null ? null : JSON.stringify(anterior),
      action,
    );
  }

  async rejectAction(action: number): Promise<void> {
    const row = this.#row(action);
    if (!row || row.state !== "pending") return;
    this.ctx.storage.sql.exec("DELETE FROM propostas WHERE id = ?", action);
  }

  async revertAction(
    action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const row = this.#row(action);
    if (!row || row.state !== "applied") {
      return { message: "Esta alteração não foi aplicada, então não há o que desfazer." };
    }
    const store = this.#store();
    if (row.kind === "criar") {
      await store.excluir(row.alvo);
    } else if (row.kind === "alterar") {
      if (!(await store.obter(row.alvo))) {
        return { message: "O compromisso foi excluído depois desta alteração, então não há o que desfazer." };
      }
      await store.restaurar(JSON.parse(row.anterior!) as Compromisso);
    } else {
      await store.removerFeriado(row.alvo);
    }
    this.ctx.storage.sql.exec("DELETE FROM propostas WHERE id = ?", action);
  }

  /** The calendar as this workspace's agent sees it: stored entries with pending proposals applied. */
  async #simulados(filtro: Filtro): Promise<Compromisso[]> {
    const store = this.#store();
    const [base, casos] = await Promise.all([
      // Status and dates may change in a pending proposal, so only the case narrows the query.
      store.consultar({ status: "todos", ...(filtro.casoId ? { casoId: filtro.casoId } : {}) }),
      this.#registry().list(),
    ]);
    const porId = new Map(base.map((c) => [c.id, c]));
    for (const row of this.#pendentes()) {
      if (row.kind === "criar") {
        const dados = JSON.parse(row.payload) as DadosCompromisso;
        porId.set(row.alvo, { ...dados, id: row.alvo, criadoEm: row.submitted_at, atualizadoEm: row.submitted_at });
      } else if (row.kind === "alterar") {
        const atual = porId.get(row.alvo) ?? (await store.obter(row.alvo));
        if (!atual) continue;
        try {
          const dados = await this.#aplicar(atual, JSON.parse(row.payload) as Alteracoes, store);
          porId.set(row.alvo, { ...dados, id: atual.id, criadoEm: atual.criadoEm, atualizadoEm: row.submitted_at });
        } catch {
          // A change that no longer applies (say, to a case since deleted) waits for the lawyer.
        }
      }
    }
    const doCaso = responsaveisPorCaso(casos);
    return [...porId.values()].filter((c) => corresponde(c, filtro, doCaso)).toSorted(compararCompromissos);
  }

  /** An entry with validated changes applied and its deadline recounted. */
  async #aplicar(atual: Compromisso, alteracoes: Alteracoes, store: DurableObjectStub<AgendaStore>): Promise<DadosCompromisso> {
    const entrada = aplicarAlteracoes(entradaDe(atual), alteracoes);
    const caso = entrada.casoId ? await this.#registry().get(entrada.casoId) : null;
    if (entrada.casoId && !caso) throw new Error("Caso não encontrado.");
    return store.resolver(entrada, alteracoes.status ?? atual.status, caso);
  }

  async #tribunalDe(local: LocalPrazo | undefined): Promise<{ tribunal?: string; comarca?: string }> {
    if (!local) return {};
    let tribunal = typeof local.tribunal === "string" && local.tribunal.trim() ? local.tribunal.trim() : undefined;
    if (!tribunal && local.casoId) {
      const caso = await this.#registry().get(String(local.casoId));
      if (!caso) throw new Error("Caso não encontrado.");
      tribunal = caso.tribunal;
    }
    const comarca = typeof local.comarca === "string" && local.comarca.trim() ? local.comarca.trim() : undefined;
    return { ...(tribunal ? { tribunal } : {}), ...(comarca ? { comarca } : {}) };
  }

  async #proporCriar(queue: NativeRpcStub<ApprovalQueue>, entrada: Entrada): Promise<string> {
    const caso = entrada.casoId ? await this.#registry().get(entrada.casoId) : null;
    if (entrada.casoId && !caso) {
      throw new Error("Caso não encontrado. Se o caso foi proposto agora, espere a aprovação para agendar nele.");
    }
    const dados = await this.#store().resolver(entrada, "pendente", caso);
    const id = crypto.randomUUID();
    const action = this.#insert("criar", id, dados);
    await queue.submitAction(action, descreverCriar(dados, caso));
    return id;
  }

  async #proporAlterar(queue: NativeRpcStub<ApprovalQueue>, id: string, alteracoes: Alteracoes): Promise<void> {
    const store = this.#store();
    const [atual] = (await this.#simulados({ status: "todos" })).filter((c) => c.id === id);
    if (!atual) throw new Error(`Nenhum compromisso com o id ${id}.`);
    const dados = await this.#aplicar(atual, alteracoes, store);
    const action = this.#insert("alterar", id, alteracoes);
    await queue.submitAction(action, descreverAlterar(atual, dados, alteracoes));
  }

  async #proporFeriado(queue: NativeRpcStub<ApprovalQueue>, feriado: Omit<Feriado, "id">): Promise<void> {
    const action = this.#insert("feriado", crypto.randomUUID(), feriado);
    await queue.submitAction(action, descreverFeriado(feriado));
  }

  #insert(kind: PropostaRow["kind"], alvo: string, payload: unknown): number {
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO propostas (kind, alvo, payload, submitted_at) VALUES (?, ?, ?, ?) RETURNING id",
        kind,
        alvo,
        JSON.stringify(payload),
        Date.now(),
      )
      .one().id;
  }

  #pendentes(): PropostaRow[] {
    return this.ctx.storage.sql
      .exec<PropostaRow>("SELECT * FROM propostas WHERE state = 'pending' ORDER BY id")
      .toArray();
  }

  #row(action: number): PropostaRow | undefined {
    return this.ctx.storage.sql.exec<PropostaRow>("SELECT * FROM propostas WHERE id = ?", action).toArray()[0];
  }

  #store(): DurableObjectStub<AgendaStore> {
    return agendaFor(this.ctx.exports, this.ctx.props.sharingDomain);
  }

  #registry(): DurableObjectStub<CaseRegistry> {
    return registryFor(this.ctx.exports, this.ctx.props.sharingDomain);
  }
}

function quando(c: Pick<DadosCompromisso, "tipo" | "data" | "hora">): string {
  return `${formatarDataComDia(c.data)}${c.hora ? ` às ${c.hora}` : ""}`;
}

function descreverCriar(dados: DadosCompromisso, caso: Caso | null): ActionDescription {
  const linhas = [
    `O agente propõe agendar ${TIPO_LABEL[dados.tipo].toLowerCase()} na agenda do escritório.`,
    "",
    `- **Título:** ${dados.titulo}`,
    `- **${dados.tipo === "prazo" ? "Vencimento" : "Data"}:** ${quando(dados)}`,
    caso ? `- **Caso:** ${caso.titulo}` : undefined,
    dados.tribunal ? `- **Tribunal:** ${dados.tribunal}${dados.comarca ? ` (${dados.comarca})` : ""}` : undefined,
    dados.local ? `- **Local:** ${dados.local}` : undefined,
    dados.link ? `- **Link:** ${dados.link}` : undefined,
    dados.responsaveis.length ? `- **Responsáveis:** ${dados.responsaveis.join(", ")}` : undefined,
    dados.descricao ? `\n${dados.descricao}` : undefined,
    dados.prazo ? `\n**Cálculo do prazo** (confira antes de protocolar)\n\n${dados.prazo.calculo.memoria.map((l) => `1. ${l}`).join("\n")}` : undefined,
  ].filter((linha) => linha !== undefined);
  return {
    title: `${TIPO_LABEL[dados.tipo]}: ${dados.titulo} — ${formatarData(dados.data)}`,
    description: linhas.join("\n"),
    implementsRevert: true,
    actionKind: CRIAR_KIND,
  };
}

function descreverAlterar(atual: Compromisso, dados: DadosCompromisso, alt: Alteracoes): ActionDescription {
  const titulo =
    alt.status === "cumprido" ? `Marcar como cumprido: ${atual.titulo}` :
    alt.status === "cancelado" ? `Cancelar: ${atual.titulo}` :
    `Alterar ${TIPO_LABEL[atual.tipo].toLowerCase()}: ${atual.titulo}`;
  const campos = Object.keys(alt).filter((k) => k !== "status");
  const linhas = [
    `O agente propõe alterar "${atual.titulo}" (${quando(atual)}).`,
    alt.status ? `\n- **Situação:** ${atual.status} → ${alt.status}` : undefined,
    dados.data !== atual.data || dados.hora !== atual.hora ? `- **Data:** ${quando(atual)} → ${quando(dados)}` : undefined,
    campos.length ? `- **Campos alterados:** ${campos.join(", ")}` : undefined,
    dados.prazo && alt.regra
      ? `\n**Novo cálculo do prazo** (confira antes de protocolar)\n\n${dados.prazo.calculo.memoria.map((l) => `1. ${l}`).join("\n")}`
      : undefined,
  ].filter((linha) => linha !== undefined);
  return { title: titulo, description: linhas.join("\n"), implementsRevert: true, actionKind: ALTERAR_KIND };
}

function descreverFeriado(feriado: Omit<Feriado, "id">): ActionDescription {
  const periodo = feriado.ate ? `de ${formatarData(feriado.data)} a ${formatarData(feriado.ate)}` : `em ${formatarData(feriado.data)}`;
  const onde = feriado.tribunal ? `no ${feriado.tribunal}${feriado.comarca ? `, comarca de ${feriado.comarca}` : ""}` : "em todos os tribunais";
  return {
    title: `Cadastrar dia sem expediente: ${feriado.descricao}`,
    description:
      `O agente propõe cadastrar um dia sem expediente ${periodo}, ${onde}: ${feriado.descricao}.\n\n` +
      "Ao aprovar, todos os prazos pendentes afetados são recontados. Confira a fonte (lei, portaria) antes.",
    implementsRevert: true,
    actionKind: FERIADO_KIND,
  };
}

/** What the Agenda page may do: lawyers edit the calendar directly; only admins change holidays. */
@validateRpc()
export class AgendaManagementApi extends RpcTarget {
  readonly #store: DurableObjectStub<AgendaStore>;
  readonly #registry: DurableObjectStub<CaseRegistry>;
  readonly #admin: boolean;
  readonly #usuario: string | null;

  constructor(
    store: DurableObjectStub<AgendaStore>,
    registry: DurableObjectStub<CaseRegistry>,
    admin: boolean,
    usuario: string | null,
  ) {
    super();
    this.#store = store;
    this.#registry = registry;
    this.#admin = admin;
    this.#usuario = usuario;
  }

  ehAdmin(): boolean {
    return this.#admin;
  }

  /** The login of whoever opened the page, for "my entries". */
  usuario(): string | null {
    return this.#usuario;
  }

  /** Today in Brasília, so the page does not trust the device clock's time zone. */
  hoje(): string {
    return hojeEmBrasilia();
  }

  /** Cases to link entries to: everything but closed cases. */
  async casos(): Promise<Pick<Caso, "id" | "titulo" | "tribunal" | "responsaveis" | "status">[]> {
    return (await this.#registry.list())
      .filter((caso) => caso.status !== "encerrado")
      .map(({ id, titulo, tribunal, responsaveis, status }) => ({ id, titulo, tribunal, responsaveis, status }));
  }

  async listar(filtro?: FiltroAgenda): Promise<Compromisso[]> {
    const valido = validarFiltro(filtro);
    const [lista, casos] = await Promise.all([
      this.#store.consultar({ status: valido.status, de: valido.de, ate: valido.ate, casoId: valido.casoId }),
      this.#registry.list(),
    ]);
    const doCaso = responsaveisPorCaso(casos);
    return lista.filter((c) => corresponde(c, valido, doCaso));
  }

  /** Who gets reminders for each entry: its own responsible lawyers, or else the case's. */
  async destinatarios(ids: string[]): Promise<Record<string, string[]>> {
    const casos = responsaveisPorCaso(await this.#registry.list());
    const out: Record<string, string[]> = {};
    for (const id of ids.slice(0, 500)) {
      const c = await this.#store.obter(String(id));
      if (c) out[c.id] = responsaveisDe(c, casos);
    }
    return out;
  }

  async criar(novo: NovoCompromisso): Promise<Compromisso> {
    const entrada = validarNovo(novo);
    const caso = await this.#caso(entrada.casoId);
    return this.#store.criar(crypto.randomUUID(), await this.#store.resolver(entrada, "pendente", caso));
  }

  async alterar(id: string, alteracoes: AlteracoesCompromisso): Promise<Compromisso> {
    const alt = validarAlteracoes(alteracoes);
    const atual = await this.#store.obter(id);
    if (!atual) throw new Error("Compromisso não encontrado.");
    const entrada = aplicarAlteracoes(entradaDe(atual), alt);
    const caso = await this.#caso(entrada.casoId);
    const dados = await this.#store.resolver(entrada, alt.status ?? atual.status, caso);
    return (await this.#store.substituir(id, dados)).compromisso;
  }

  excluir(id: string): Promise<void> {
    return this.#store.excluir(id);
  }

  /** Confirms an entry case tracking suggested. */
  confirmarSugestao(id: string): Promise<Compromisso> {
    return this.#store.confirmarSugestao(String(id));
  }

  /** Discards an entry case tracking suggested. */
  descartarSugestao(id: string): Promise<void> {
    return this.#store.descartarSugestao(String(id));
  }

  /** Counts a deadline for the form, before saving. */
  async calcularPrazo(regra: RegraPrazo, local?: { tribunal?: string; comarca?: string; casoId?: string }): Promise<CalculoPrazo> {
    const valida = validarRegra(regra);
    let tribunal = local?.tribunal?.trim() || undefined;
    if (!tribunal && local?.casoId) tribunal = (await this.#caso(local.casoId))?.tribunal;
    return this.#store.calcular(valida, { tribunal, comarca: local?.comarca?.trim() || undefined });
  }

  /** National and registered days without court business in a range. */
  diasSemExpediente(de: string, ate: string): Promise<DiaSemExpediente[]> {
    return this.#store.diasSemExpediente(de, ate);
  }

  /** The firm's registered holidays and suspensions. */
  feriados(): Promise<Feriado[]> {
    return this.#store.feriados();
  }

  /** The viewer's reminder preferences. */
  async preferencias(): Promise<PreferenciasAgenda> {
    if (!this.#usuario) return { resumoConversa: false };
    return this.#store.preferencias(this.#usuario);
  }

  /** Changes the viewer's reminder preferences. */
  async salvarPreferencias(preferencias: PreferenciasAgenda): Promise<PreferenciasAgenda> {
    if (!this.#usuario) throw new Error("Não foi possível identificar o seu usuário.");
    if (typeof preferencias?.resumoConversa !== "boolean") throw new TypeError("resumoConversa deve ser true ou false.");
    return this.#store.salvarPreferencias(this.#usuario, { resumoConversa: preferencias.resumoConversa });
  }

  /** Registers a holiday or suspension. Admins only. Returns the deadlines it moved. */
  async adicionarFeriado(feriado: NovoFeriado): Promise<Reprogramado[]> {
    this.#exigirAdmin();
    return this.#store.adicionarFeriado(crypto.randomUUID(), validarFeriado(feriado));
  }

  /** Removes a holiday or suspension. Admins only. Returns the deadlines it moved. */
  async removerFeriado(id: string): Promise<Reprogramado[]> {
    this.#exigirAdmin();
    return this.#store.removerFeriado(id);
  }

  async #caso(casoId: string | undefined): Promise<Caso | null> {
    if (!casoId) return null;
    const caso = await this.#registry.get(casoId);
    if (!caso) throw new Error("Caso não encontrado.");
    return caso;
  }

  #exigirAdmin(): void {
    if (!this.#admin) throw new Error("Só administradores cadastram feriados e suspensões.");
  }
}

export function describeAgendaAccount(): AccountDescription {
  return {
    displayName: "Agenda",
    avatar: AGENDA_ICON,
    singleton: { tsType: "AgendaSession" },
    providesUi: { title: "Agenda", icon: AGENDA_ICON },
  };
}

@validateRpc()
export class AgendaAccount
  extends WorkerEntrypoint<Cloudflare.Env, AgendaProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return describeAgendaAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<AgendaSession>>> {
    return this.ctx.exports.AgendaGatekeeper({ props: this.ctx.props });
  }

  /** Opens the Agenda page. `isAdmin` and `username` come fresh from the Workshop on every open. */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const ui = new NativeRpcStub(
      new AgendaManagementApi(
        agendaFor(this.ctx.exports, this.ctx.props.sharingDomain),
        registryFor(this.ctx.exports, this.ctx.props.sharingDomain),
        context.isAdmin === true,
        typeof context.username === "string" ? context.username : null,
      ),
    );
    return { iframeHtml: AGENDA_HTML, ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("A Agenda não tem recursos endereçados por URL.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("A Agenda não tem recursos endereçados por URL.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revoking one lawyer's account leaves the firm's calendar in place. */
  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("A Agenda não tem fluxo de conexão.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Every member of the firm sees the whole calendar, as with cases. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CasosVerifier({});
  }
}

@validateRpc()
export class AgendaVendor extends WorkerEntrypoint<Cloudflare.Env, Partial<AgendaProps>> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Agenda",
      url: "https://lume.app/",
      logo: AGENDA_ICON,
      tagline: "Prazos, audiências e compromissos do escritório",
      description:
        "Controle prazos processuais (contados em dias úteis, com feriados e recesso), audiências, " +
        "tarefas e reuniões, ligados aos casos. O agente calcula e agenda prazos com aprovação.",
      autoProvisionsAccount: true,
      providesAuth: false,
      providesNotifications: true,
    };
  }

  /** Reminders due for delivery: the morning summary and hearing and meeting reminders. */
  async takeNotifications(): Promise<GatekeeperNotification[]> {
    const domain = this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN;
    const casos = await registryFor(this.ctx.exports, domain).list();
    return agendaFor(this.ctx.exports, domain).retirarAvisos(
      Object.fromEntries(casos.map((caso) => [caso.id, { titulo: caso.titulo, responsaveis: caso.responsaveis }])),
    );
  }

  /** Drops reminders the Workshop delivered. */
  async ackNotifications(ids: string[]): Promise<void> {
    const domain = this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN;
    await agendaFor(this.ctx.exports, domain).confirmarAvisos(ids);
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.AgendaAccount({
      props: { sharingDomain: this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("A Agenda é provisionada automaticamente e não tem fluxo de conexão.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
