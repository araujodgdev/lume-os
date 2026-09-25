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
  GatekeeperUiFrame,
  GatekeeperUser,
  GatekeeperUserVerifier,
  ObservationAuthorizer,
  ResourceConfiguratorFrame,
  ResourceDescription,
  SupportedResource,
  VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { DEFAULT_SHARING_DOMAIN, registryFor } from "../casos.js";
import type { DocumentVault } from "../cofre/vault.js";
import type { CaseRegistry } from "../registry.js";
import type { Caso } from "../types.js";
import { aoVivoFor, FONTES_AO_VIVO } from "./ao-vivo.js";
import { pesquisar, validarPedido, verificarTexto } from "./busca.js";
import { indiceFor, type IndiceJurisprudencia } from "./indice.js";
import type { DiagnosticoFonte, EstadoImportacao } from "./pagina.js";
import { citacao, TRIBUNAIS } from "./julgado.js";
import type {
  Julgado,
  JulgadoSalvo,
  PedidoBusca,
  PesquisaSession,
  RelatorioCitacoes,
  ResultadoPesquisa,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "../generated/app.txt";

/** Phosphor "Books" icon, drawn with currentColor so the Workshop can tint it. */
const PESQUISA_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M231.65 194.55 198.46 36.75a16 16 0 0 0-19-12.39L132.65 34.42a16.08 16.08 0 0 0-12.3 19l33.19 157.8A16 16 0 0 0 169.16 224a16.25 16.25 0 0 0 3.38-.36l46.81-10.06a16.09 16.09 0 0 0 12.3-19.03ZM136 50.15h.09l46.8-10.06 3.33 15.87L139.38 66Zm6.67 31.7 46.82-10.05 3.34 15.9L146 97.85Zm6.66 31.61 46.82-10.06 13.3 63.24-46.82 10.06ZM216 197.94 169.18 208l-3.33-15.87 46.81-10.06 3.34 15.86ZM104 32H56a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h48a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16ZM56 48h48v16H56Zm0 32h48v96H56Zm48 128H56v-16h48v16Z'/></svg>",
    ),
};

const PESQUISA_HTML = APP_HTML.replace("<html", '<html data-app="pesquisa"');

const SALVAR_KIND: ActionKind = { tag: "pesquisa.salvar", label: "Salvar jurisprudência no caso" };

/** Largest text `verificar()` reads. */
const MAX_TEXTO_VERIFICAR = 2_000_000;
/** Most text of a Cofre document the page checks. */
const MAX_TEXTO_DOCUMENTO = 600_000;

type PesquisaProps = { sharingDomain: string };

type PropostaRow = {
  id: number;
  caso_id: string;
  julgado_id: string;
  nota: string | null;
  submitted_at: number;
  state: "pending" | "applied";
};

function validarTexto(texto: unknown): string {
  if (typeof texto !== "string" || !texto.trim()) throw new TypeError("Informe o texto a verificar.");
  if (texto.length > MAX_TEXTO_VERIFICAR) throw new TypeError("Texto grande demais para verificar de uma vez.");
  return texto;
}

function validarNota(nota: unknown): string | undefined {
  if (nota === undefined || nota === null || nota === "") return undefined;
  if (typeof nota !== "string" || nota.length > 2_000) throw new TypeError("A nota deve ser um texto de até 2.000 caracteres.");
  return nota.trim() || undefined;
}

/** What a session needs from its facet. Closures, so nothing here is reachable over RPC. */
export type PesquisaBackend = {
  exports: Cloudflare.Exports;
  indice(): DurableObjectStub<IndiceJurisprudencia>;
  registry(): DurableObjectStub<CaseRegistry>;
  salvosSimulados(casoId: string): Promise<JulgadoSalvo[]>;
  proporSalvar(queue: NativeRpcStub<ApprovalQueue>, casoId: string, julgadoId: string, nota?: string): Promise<void>;
};

@validateRpc()
export class PesquisaSessionImpl extends RpcTarget implements PesquisaSession {
  readonly #backend: PesquisaBackend;
  readonly #queue: NativeRpcStub<ApprovalQueue>;

  constructor(backend: PesquisaBackend, queue: NativeRpcStub<ApprovalQueue>) {
    super();
    this.#backend = backend;
    this.#queue = queue;
  }

  /** Searches the courts. */
  async buscar(pedido: PedidoBusca): Promise<ResultadoPesquisa> {
    const valido = validarPedido(pedido);
    const resultado = await pesquisar(this.#backend.exports, valido);
    const falhas = resultado.fontes.filter((f) => f.status === "falhou").map((f) => f.fonte);
    await this.#queue.authorizeObservation({
      title: "Buscar jurisprudência",
      description: `Buscou "${valido.consulta}" em ${valido.tribunais.join(", ")} e recebeu ${resultado.resultados.length} decisão(ões).` +
        (falhas.length ? ` Fontes indisponíveis: ${falhas.join(", ")}.` : ""),
    });
    return resultado;
  }

  /** A decision Pesquisa has seen. */
  async obter(id: string): Promise<Julgado | null> {
    const julgado = await this.#backend.indice().obter(String(id));
    await this.#queue.authorizeObservation({
      title: "Ler decisão",
      description: julgado ? `Leu ${citacao(julgado)}.` : `Nenhuma decisão com id ${id}.`,
    });
    return julgado;
  }

  /** The canonical citation. */
  async citar(id: string): Promise<string> {
    const julgado = await this.#backend.indice().obter(String(id));
    if (!julgado) throw new Error("Decisão desconhecida: use um id devolvido por buscar().");
    return citacao(julgado);
  }

  /** Checks every citation in a text. */
  async verificar(texto: string): Promise<RelatorioCitacoes> {
    const relatorio = await verificarTexto(this.#backend.exports, validarTexto(texto));
    await this.#queue.authorizeObservation({ title: "Verificar citações", description: relatorio.resumo });
    return relatorio;
  }

  /** Proposes attaching a decision to a case. */
  async salvarNoCaso(casoId: string, julgadoId: string, nota?: string): Promise<void> {
    await this.#backend.proporSalvar(this.#queue, String(casoId), String(julgadoId), validarNota(nota));
  }

  /** Decisions attached to a case. */
  async salvos(casoId: string): Promise<JulgadoSalvo[]> {
    const lista = await this.#backend.salvosSimulados(String(casoId));
    await this.#queue.authorizeObservation({
      title: "Listar jurisprudência do caso",
      description: `Listou ${lista.length} decisão(ões) salvas no caso ${casoId}.`,
    });
    return lista;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

/** The agent singleton, one facet per workspace: keeps "save to case" proposals until approved. */
@validateRpc()
export class PesquisaGatekeeper
  extends DurableObject<Cloudflare.Env, PesquisaProps>
  implements Gatekeeper<PesquisaSession>
{
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS propostas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        caso_id TEXT NOT NULL,
        julgado_id TEXT NOT NULL,
        nota TEXT,
        submitted_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending'
      )
    `);
  }

  async describe(): Promise<ResourceDescription> {
    return {
      url: "pesquisa://jurisprudencia",
      title: "Pesquisa",
      snippet: "Jurisprudência do STF, STJ, TST e TJs, com verificação de citações.",
      suggestedBindingName: "PESQUISA",
      tsType: "PesquisaSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /** Attaching a decision to a case only adds a reference, and reverting removes it. */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [SALVAR_KIND];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<PesquisaSession> {
    await indiceFor(this.ctx.exports).iniciarImportacao();
    return new PesquisaSessionImpl({
      exports: this.ctx.exports,
      indice: () => indiceFor(this.ctx.exports),
      registry: () => this.#registry(),
      salvosSimulados: (casoId) => this.#salvosSimulados(casoId),
      proporSalvar: (queue, casoId, julgadoId, nota) => this.#proporSalvar(queue, casoId, julgadoId, nota),
    }, approvalQueue.dup());
  }

  /** No catalog: what to search depends on the question. */
  async getAgentCatalog(_authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    return null;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  async applyAction(action: number): Promise<void> {
    const row = this.#row(action);
    if (!row || row.state !== "pending") throw new Error(`Proposta ${action} não está pendente.`);
    if (!(await this.#registry().get(row.caso_id))) throw new Error("O caso não existe mais.");
    await indiceFor(this.ctx.exports).salvar(this.ctx.props.sharingDomain, row.caso_id, row.julgado_id, row.nota ?? undefined);
    this.ctx.storage.sql.exec("UPDATE propostas SET state = 'applied' WHERE id = ?", action);
  }

  async rejectAction(action: number): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM propostas WHERE id = ? AND state = 'pending'", action);
  }

  async revertAction(action: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const row = this.#row(action);
    if (!row || row.state !== "applied") return { message: "Esta alteração não foi aplicada, então não há o que desfazer." };
    await indiceFor(this.ctx.exports).removerSalvo(this.ctx.props.sharingDomain, row.caso_id, row.julgado_id);
    this.ctx.storage.sql.exec("DELETE FROM propostas WHERE id = ?", action);
  }

  async #salvosSimulados(casoId: string): Promise<JulgadoSalvo[]> {
    const indice = indiceFor(this.ctx.exports);
    const salvos = await indice.salvos(this.ctx.props.sharingDomain, casoId);
    const ja = new Set(salvos.map((s) => s.julgado.id));
    const pendentes = this.ctx.storage.sql
      .exec<PropostaRow>("SELECT * FROM propostas WHERE state = 'pending' AND caso_id = ? ORDER BY id DESC", casoId)
      .toArray();
    const simulados: JulgadoSalvo[] = [];
    for (const p of pendentes) {
      if (ja.has(p.julgado_id)) continue;
      const julgado = await indice.obter(p.julgado_id);
      if (julgado) simulados.push({ casoId, julgado, ...(p.nota ? { nota: p.nota } : {}), salvoEm: p.submitted_at });
    }
    return [...simulados, ...salvos];
  }

  async #proporSalvar(queue: NativeRpcStub<ApprovalQueue>, casoId: string, julgadoId: string, nota?: string): Promise<void> {
    const caso = await this.#registry().get(casoId);
    if (!caso) throw new Error("Caso não encontrado.");
    const julgado = await indiceFor(this.ctx.exports).obter(julgadoId);
    if (!julgado) throw new Error("Decisão desconhecida: use um id devolvido por buscar().");
    const action = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO propostas (caso_id, julgado_id, nota, submitted_at) VALUES (?, ?, ?, ?) RETURNING id",
        casoId,
        julgadoId,
        nota ?? null,
        Date.now(),
      )
      .one().id;
    await queue.submitAction(action, descreverSalvar(caso, julgado, nota));
  }

  #row(action: number): PropostaRow | undefined {
    return this.ctx.storage.sql.exec<PropostaRow>("SELECT * FROM propostas WHERE id = ?", action).toArray()[0];
  }

  #registry(): DurableObjectStub<CaseRegistry> {
    return registryFor(this.ctx.exports, this.ctx.props.sharingDomain);
  }
}

function descreverSalvar(caso: Caso, julgado: Julgado, nota?: string): ActionDescription {
  return {
    title: `Salvar jurisprudência no caso: ${caso.titulo}`,
    description:
      `O agente propõe salvar esta decisão no caso "${caso.titulo}".\n\n**${citacao(julgado)}**\n\n` +
      `> ${julgado.ementa.slice(0, 1_500).replace(/\n/g, "\n> ")}\n\n[Ver no site do tribunal](${julgado.url})` +
      (nota ? `\n\n**Nota:** ${nota}` : ""),
    implementsRevert: true,
    actionKind: SALVAR_KIND,
  };
}

export type { DiagnosticoFonte } from "./pagina.js";

/** What the Pesquisa page may do. */
@validateRpc()
export class PesquisaManagementApi extends RpcTarget {
  readonly #exports: Cloudflare.Exports;
  readonly #dominio: string;
  readonly #registry: DurableObjectStub<CaseRegistry>;
  readonly #vault: DurableObjectStub<DocumentVault>;
  readonly #admin: boolean;

  constructor(exports: Cloudflare.Exports, dominio: string, registry: DurableObjectStub<CaseRegistry>, vault: DurableObjectStub<DocumentVault>, admin: boolean) {
    super();
    this.#exports = exports;
    this.#dominio = dominio;
    this.#registry = registry;
    this.#vault = vault;
    this.#admin = admin;
  }

  ehAdmin(): boolean {
    return this.#admin;
  }

  tribunais(): string[] {
    return [...TRIBUNAIS];
  }

  async buscar(pedido: PedidoBusca): Promise<ResultadoPesquisa> {
    return pesquisar(this.#exports, validarPedido(pedido));
  }

  async citar(id: string): Promise<string> {
    const julgado = await indiceFor(this.#exports).obter(String(id));
    if (!julgado) throw new Error("Decisão desconhecida.");
    return citacao(julgado);
  }

  verificar(texto: string): Promise<RelatorioCitacoes> {
    return verificarTexto(this.#exports, validarTexto(texto));
  }

  /** Checks the citations in a Cofre document's extracted text. */
  async verificarDocumento(documentoId: string): Promise<RelatorioCitacoes & { nome: string }> {
    const doc = await this.#vault.obter(String(documentoId));
    if (!doc) throw new Error("Documento não encontrado.");
    let texto = "";
    for (let inicio = 0; texto.length < MAX_TEXTO_DOCUMENTO;) {
      const janela = await this.#vault.lerTexto(doc.id, inicio, 100_000);
      if (!janela) break;
      texto += janela.texto;
      if (janela.fim) break;
      inicio = janela.inicio + janela.texto.length;
    }
    if (!texto.trim()) throw new Error("Este documento não tem texto legível.");
    return { nome: doc.nome, ...(await verificarTexto(this.#exports, texto)) };
  }

  /** Cases to save decisions to: everything but closed ones. */
  async casos(): Promise<{ id: string; titulo: string }[]> {
    return (await this.#registry.list()).filter((c) => c.status !== "encerrado").map(({ id, titulo }) => ({ id, titulo }));
  }

  /** A case's Cofre documents with readable text, for the citation checker. */
  async documentos(casoId: string): Promise<{ id: string; nome: string }[]> {
    return (await this.#vault.listar(String(casoId))).filter((d) => d.status === "pronto").map(({ id, nome }) => ({ id, nome }));
  }

  async salvar(casoId: string, julgadoId: string, nota?: string): Promise<JulgadoSalvo> {
    if (!(await this.#registry.get(String(casoId)))) throw new Error("Caso não encontrado.");
    return indiceFor(this.#exports).salvar(this.#dominio, String(casoId), String(julgadoId), validarNota(nota));
  }

  removerSalvo(casoId: string, julgadoId: string): Promise<void> {
    return indiceFor(this.#exports).removerSalvo(this.#dominio, String(casoId), String(julgadoId));
  }

  salvos(casoId: string): Promise<JulgadoSalvo[]> {
    return indiceFor(this.#exports).salvos(this.#dominio, String(casoId));
  }

  estadoImportacao(): Promise<EstadoImportacao> {
    return indiceFor(this.#exports).estadoImportacao();
  }

  /** Runs a sample search on every live source. Admins only: it spends browser time. */
  async diagnostico(): Promise<DiagnosticoFonte[]> {
    if (!this.#admin) throw new Error("Só administradores rodam o diagnóstico das fontes.");
    const vivo = aoVivoFor(this.#exports);
    const alvos = Object.values(FONTES_AO_VIVO).flatMap((f) => f.tribunais.map((tribunal) => ({ fonte: f, tribunal })));
    return Promise.all(alvos.map(async ({ fonte, tribunal }) => {
      const inicio = Date.now();
      const resposta = await vivo.buscar(fonte.id, fonte.consultaTeste, { tribunal, limite: 1 });
      const ms = Date.now() - inicio;
      if ("erro" in resposta) return { fonte: fonte.nome, tribunal, status: "falhou" as const, ms, erro: resposta.erro };
      const [primeiro] = resposta.julgados;
      return {
        fonte: fonte.nome,
        tribunal,
        status: primeiro ? "ok" as const : "sem_resultados" as const,
        ms,
        ...(primeiro ? { exemplo: citacao(primeiro) } : {}),
      };
    }));
  }
}

export function describePesquisaAccount(): AccountDescription {
  return {
    displayName: "Pesquisa",
    avatar: PESQUISA_ICON,
    singleton: { tsType: "PesquisaSession" },
    providesUi: { title: "Pesquisa", icon: PESQUISA_ICON },
  };
}

@validateRpc()
export class PesquisaAccount
  extends WorkerEntrypoint<Cloudflare.Env, PesquisaProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return describePesquisaAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<PesquisaSession>>> {
    return this.ctx.exports.PesquisaGatekeeper({ props: this.ctx.props });
  }

  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const dominio = this.ctx.props.sharingDomain;
    await indiceFor(this.ctx.exports).iniciarImportacao();
    const ui = new NativeRpcStub(new PesquisaManagementApi(
      this.ctx.exports,
      dominio,
      registryFor(this.ctx.exports, dominio),
      this.ctx.exports.DocumentVault.getByName(dominio),
      context.isAdmin === true,
    ));
    return { iframeHtml: PESQUISA_HTML, ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("A Pesquisa não tem recursos endereçados por URL.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("A Pesquisa não tem recursos endereçados por URL.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("A Pesquisa não tem fluxo de conexão.");
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CasosVerifier({});
  }
}

@validateRpc()
export class PesquisaVendor extends WorkerEntrypoint<Cloudflare.Env, Partial<PesquisaProps>> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Pesquisa",
      url: "https://lume.app/",
      logo: PESQUISA_ICON,
      tagline: "Jurisprudência verificável, direto dos tribunais",
      description:
        "Busca jurisprudência no STF, STJ, TST e TJs pelas fontes dos próprios tribunais e confere as " +
        "citações das peças, para o agente nunca citar uma decisão que não existe.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.PesquisaAccount({
      props: { sharingDomain: this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("A Pesquisa é provisionada automaticamente e não tem fluxo de conexão.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
