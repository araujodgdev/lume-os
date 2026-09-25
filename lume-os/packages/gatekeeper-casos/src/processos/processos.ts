import {
  DurableObject,
  RpcStub as NativeRpcStub,
  RpcTarget,
  WorkerEntrypoint,
} from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import type {
  AccountDescription,
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
import { DEFAULT_SHARING_DOMAIN, registryFor } from "../casos.js";
import type { DocumentVault } from "../cofre/vault.js";
import type { CaseRegistry } from "../registry.js";
import { normalizarTribunal, type EndpointMni } from "./fontes/tribunais.js";
import type {
  CredencialVisivel,
  DocumentoSalvo,
  EstadoSincronia,
  ItemDiagnostico,
  Oab,
  PreferenciasProcessos,
  RegistroAuditoria,
} from "./pagina.js";
import { processosFor, type ProcessosStore } from "./store.js";
import type { FiltroIntimacoes, Intimacao, Movimentacao, ProcessosSession, StatusIntimacao } from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "../generated/app.txt";

/** Phosphor "Scales" icon, drawn with currentColor so the Workshop can tint it. */
const PROCESSOS_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M239.43 133l-32-80A8 8 0 0 0 200 48h-64V32a8 8 0 0 0-16 0v16H56a8 8 0 0 0-7.43 5l-32 80a8.07 8.07 0 0 0-.57 3c0 23.31 24.54 32 40 32s40-8.69 40-32a8.07 8.07 0 0 0-.57-3L66.62 64H120v144H96a8 8 0 0 0 0 16h64a8 8 0 0 0 0-16h-24V64h53.38l-28.81 72a8.07 8.07 0 0 0-.57 3c0 23.31 24.54 32 40 32s40-8.69 40-32a8.07 8.07 0 0 0-.57-3ZM56 152c-7.53 0-22.76-3.61-23.93-14.64L56 77.54l23.93 59.82C78.76 148.39 63.53 152 56 152Zm144-16c-7.53 0-22.76-3.61-23.93-14.64L200 61.54l23.93 59.82C222.76 132.39 207.53 136 200 136Z'/></svg>",
    ),
};

const PROCESSOS_HTML = APP_HTML.replace("<html", '<html data-app="processos"');

type ProcessosProps = { sharingDomain: string };

const STATUS: (StatusIntimacao | "todas")[] = ["nova", "aberta", "descartada", "todas"];

function validarFiltro(filtro: unknown): FiltroIntimacoes {
  if (filtro === undefined || filtro === null) return {};
  if (typeof filtro !== "object") throw new TypeError("O filtro deve ser um objeto.");
  const f = filtro as Record<string, unknown>;
  const saida: FiltroIntimacoes = {};
  if (f.status !== undefined) {
    if (!STATUS.includes(f.status as StatusIntimacao)) throw new TypeError(`status deve ser ${STATUS.join(", ")}.`);
    saida.status = f.status as StatusIntimacao | "todas";
  }
  if (f.casoId !== undefined) saida.casoId = String(f.casoId);
  if (f.desde !== undefined) {
    if (typeof f.desde !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f.desde)) throw new TypeError("desde deve ser AAAA-MM-DD.");
    saida.desde = f.desde;
  }
  return saida;
}

/** The CNJ numbers a docket query covers: a case's number, or the one given. */
async function processosDoAlvo(registry: DurableObjectStub<CaseRegistry>, alvo: { casoId?: string; processo?: string }): Promise<{ processos: string[]; casoId?: string }> {
  if (alvo?.casoId) {
    const caso = await registry.get(String(alvo.casoId));
    if (!caso) throw new Error("Caso não encontrado.");
    return { processos: caso.numeroCnj ? [caso.numeroCnj] : [], casoId: caso.id };
  }
  if (alvo?.processo) return { processos: [String(alvo.processo)] };
  throw new TypeError("Informe casoId ou processo.");
}

@validateRpc()
export class ProcessosSessionImpl extends RpcTarget implements ProcessosSession {
  readonly #store: DurableObjectStub<ProcessosStore>;
  readonly #registry: DurableObjectStub<CaseRegistry>;
  readonly #queue: NativeRpcStub<ApprovalQueue>;

  constructor(store: DurableObjectStub<ProcessosStore>, registry: DurableObjectStub<CaseRegistry>, queue: NativeRpcStub<ApprovalQueue>) {
    super();
    this.#store = store;
    this.#registry = registry;
    this.#queue = queue;
  }

  /** Notices and publications. Closed PJe notices come without text: the agent can never open them. */
  async intimacoes(filtro?: FiltroIntimacoes): Promise<Intimacao[]> {
    const valido = validarFiltro(filtro);
    const lista = await this.#store.intimacoes(valido);
    const fechadas = lista.filter((i) => i.origem === "pje" && i.status === "nova").length;
    await this.#queue.authorizeObservation({
      title: "Ler intimações",
      description: `Leu ${lista.length} intimação(ões)${valido.status ? ` (${valido.status})` : " novas"}` +
        (fechadas ? `, ${fechadas} ainda fechada(s) no PJe` : "") + ".",
    });
    return lista;
  }

  async movimentacoes(alvo: { casoId?: string; processo?: string }): Promise<Movimentacao[]> {
    const { processos, casoId } = await processosDoAlvo(this.#registry, alvo);
    const lista = (await this.#store.movimentacoes({ processos })).map((m) => (casoId ? { ...m, casoId } : m));
    await this.#queue.authorizeObservation({
      title: "Ler movimentações",
      description: `Leu ${lista.length} movimentação(ões) de ${processos.join(", ") || "um caso sem número CNJ"}.`,
    });
    return lista;
  }

  [Symbol.dispose](): void {
    this.#queue[Symbol.dispose]?.();
  }
}

/** The agent singleton: read only, so it never proposes anything. */
@validateRpc()
export class ProcessosGatekeeper
  extends DurableObject<Cloudflare.Env, ProcessosProps>
  implements Gatekeeper<ProcessosSession>
{
  async describe(): Promise<ResourceDescription> {
    return {
      url: "processos://acompanhamento",
      title: "Intimações",
      snippet: "Intimações do PJe, publicações do DJEN e movimentações dos processos do escritório.",
      suggestedBindingName: "PROCESSOS",
      tsType: "ProcessosSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<ProcessosSession> {
    const dominio = this.ctx.props.sharingDomain;
    const store = processosFor(this.ctx.exports, dominio);
    await store.configurar(dominio);
    return new ProcessosSessionImpl(store, registryFor(this.ctx.exports, dominio), approvalQueue.dup());
  }

  async getAgentCatalog(_authorizer: NativeRpcStub<ObservationAuthorizer>): Promise<AgentCatalog | null> {
    return null;
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  async removeObserver(_id: string): Promise<void> {}

  applyAction(_action: number): Promise<void> {
    throw new Error("Processos não propõe alterações.");
  }

  rejectAction(_action: number): Promise<void> {
    throw new Error("Processos não propõe alterações.");
  }

  async revertAction(_action: number): Promise<{ message?: string }> {
    return { message: "Processos não propõe alterações." };
  }
}

function extensaoDoMime(mime: string): string | undefined {
  const m = mime.toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("html") || m.startsWith("text/")) return "txt";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("png")) return "png";
  return undefined;
}

function textoDeHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** What the Intimações page may do. Credentials are always the signed-in lawyer's own. */
@validateRpc()
export class ProcessosManagementApi extends RpcTarget {
  readonly #store: DurableObjectStub<ProcessosStore>;
  readonly #registry: DurableObjectStub<CaseRegistry>;
  readonly #vault: DurableObjectStub<DocumentVault>;
  readonly #admin: boolean;
  readonly #usuario: string | null;

  constructor(
    store: DurableObjectStub<ProcessosStore>,
    registry: DurableObjectStub<CaseRegistry>,
    vault: DurableObjectStub<DocumentVault>,
    admin: boolean,
    usuario: string | null,
  ) {
    super();
    this.#store = store;
    this.#registry = registry;
    this.#vault = vault;
    this.#admin = admin;
    this.#usuario = usuario;
  }

  ehAdmin(): boolean {
    return this.#admin;
  }

  usuario(): string | null {
    return this.#usuario;
  }

  #eu(): string {
    if (!this.#usuario) throw new Error("Não foi possível identificar o seu usuário.");
    return this.#usuario;
  }

  #exigirAdmin(): void {
    if (!this.#admin) throw new Error("Só administradores alteram os tribunais.");
  }

  async casos(): Promise<{ id: string; titulo: string; numeroCnj?: string }[]> {
    return (await this.#registry.list())
      .filter((c) => c.status !== "encerrado")
      .map(({ id, titulo, numeroCnj }) => ({ id, titulo, ...(numeroCnj ? { numeroCnj } : {}) }));
  }

  // --- notices ---

  intimacoes(filtro?: FiltroIntimacoes, somenteMinhas?: boolean): Promise<Intimacao[]> {
    return this.#store.intimacoes(validarFiltro(filtro), somenteMinhas ? this.#eu() : undefined);
  }

  /**
   * Opens a PJe notice with the lawyer's own password. THIS REGISTERS THE NOTIFICATION IN THE PJe.
   * The page asks for confirmation first. The content and documents go to the case's Cofre.
   */
  async abrir(id: string): Promise<{ intimacao: Intimacao; documentos: DocumentoSalvo[]; semCaso: boolean }> {
    const eu = this.#eu();
    // Checked here too, so a refusal never reaches the PJe step (the store checks again).
    const atual = await this.#store.intimacao(String(id));
    if (!atual) throw new Error("Intimação não encontrada.");
    if (atual.origem !== "pje") throw new Error("Só intimações do PJe são abertas; publicações do DJEN já estão disponíveis.");
    if (atual.advogado !== eu) throw new Error("Só o advogado que recebeu a intimação pode abri-la, com a própria senha do PJe.");
    const { intimacao, documentos } = await this.#store.abrir(eu, String(id));
    if (!intimacao.casoId) return { intimacao, documentos: [], semCaso: documentos.length > 0 || !!intimacao.texto };
    const salvos: DocumentoSalvo[] = [];
    const base = `Intimação ${intimacao.processo} ${intimacao.dataDisponibilizacao}`;
    const arquivos: { nome: string; bytes: Uint8Array }[] = [];
    if (intimacao.texto) arquivos.push({ nome: `${base}.txt`, bytes: new TextEncoder().encode(intimacao.texto) });
    for (const [n, d] of documentos.entries()) {
      const ext = extensaoDoMime(d.mime);
      if (!ext) continue;
      const nome = `${base} - ${(d.nome || `documento ${n + 1}`).replace(/\.[a-z0-9]{2,4}$/i, "")}.${ext}`;
      const bytes = ext === "txt" && d.mime.includes("html") ? new TextEncoder().encode(textoDeHtml(new TextDecoder().decode(d.bytes))) : d.bytes;
      arquivos.push({ nome, bytes });
    }
    for (const a of arquivos) {
      try {
        const doc = await this.#vault.importarArquivo(intimacao.casoId, a.nome, a.bytes);
        salvos.push({ id: doc.id, nome: doc.nome });
      } catch {
        // A document the Cofre refuses (unknown format, too large) stays in the PJe.
      }
    }
    return { intimacao, documentos: salvos, semCaso: false };
  }

  descartar(id: string): Promise<void> {
    return this.#store.descartar(String(id));
  }

  async vincular(id: string, casoId: string): Promise<Intimacao> {
    if (!(await this.#registry.get(String(casoId)))) throw new Error("Caso não encontrado.");
    return this.#store.vincular(String(id), String(casoId));
  }

  async movimentacoes(alvo: { casoId?: string; processo?: string }): Promise<Movimentacao[]> {
    const { processos, casoId } = await processosDoAlvo(this.#registry, alvo);
    return (await this.#store.movimentacoes({ processos })).map((m) => (casoId ? { ...m, casoId } : m));
  }

  /** The newest docket entries of every open case. */
  async movimentacoesRecentes(): Promise<Movimentacao[]> {
    const casos = (await this.#registry.list()).filter((c) => c.numeroCnj && c.status !== "encerrado");
    const porNumero = new Map(casos.map((c) => [c.numeroCnj!, c.id]));
    const lista = await this.#store.movimentacoes({ processos: [...porNumero.keys()] });
    return lista.map((m) => ({ ...m, casoId: porNumero.get(m.processo)! }));
  }

  // --- the lawyer's own OAB numbers and PJe passwords ---

  oabs(): Promise<Oab[]> {
    return this.#store.oabs(this.#eu());
  }

  adicionarOab(oab: Oab): Promise<Oab[]> {
    return this.#store.adicionarOab(this.#eu(), { numero: String(oab?.numero ?? ""), uf: String(oab?.uf ?? "") });
  }

  removerOab(oab: Oab): Promise<Oab[]> {
    return this.#store.removerOab(this.#eu(), { numero: String(oab?.numero ?? ""), uf: String(oab?.uf ?? "") });
  }

  credenciais(): Promise<CredencialVisivel[]> {
    return this.#store.credenciais(this.#eu());
  }

  /** Saves the password encrypted. It is never sent back. */
  async salvarCredencial(entrada: { tribunal: string; cpf: string; senha: string }): Promise<CredencialVisivel[]> {
    const eu = this.#eu();
    const tribunal = normalizarTribunal(String(entrada?.tribunal ?? ""));
    if (!(await this.#store.endpoints()).some((e) => e.tribunal === tribunal)) {
      throw new Error(`O Lume ainda não conhece o MNI do ${tribunal}. Peça a um administrador para cadastrar o endereço.`);
    }
    return this.#store.salvarCredencial(eu, {
      tribunal,
      cpf: String(entrada?.cpf ?? ""),
      senha: String(entrada?.senha ?? ""),
    });
  }

  removerCredencial(tribunal: string): Promise<CredencialVisivel[]> {
    return this.#store.removerCredencial(this.#eu(), String(tribunal));
  }

  testarCredencial(tribunal: string): Promise<CredencialVisivel[]> {
    return this.#store.testarCredencial(this.#eu(), String(tribunal));
  }

  auditoria(): Promise<RegistroAuditoria[]> {
    return this.#store.auditoria(this.#eu());
  }

  async preferenciasAcompanhamento(): Promise<PreferenciasProcessos> {
    return this.#usuario ? this.#store.preferencias(this.#usuario) : { resumoAgente: false };
  }

  salvarPreferenciasAcompanhamento(p: PreferenciasProcessos): Promise<PreferenciasProcessos> {
    return this.#store.salvarPreferencias(this.#eu(), { resumoAgente: p?.resumoAgente === true });
  }

  // --- courts and syncing ---

  endpoints(): Promise<EndpointMni[]> {
    return this.#store.endpoints();
  }

  salvarEndpoint(e: EndpointMni): Promise<EndpointMni[]> {
    this.#exigirAdmin();
    return this.#store.salvarEndpoint({ tribunal: String(e?.tribunal ?? ""), grau: Number(e?.grau) as 1 | 2, url: String(e?.url ?? "") });
  }

  removerEndpoint(tribunal: string, grau: number): Promise<EndpointMni[]> {
    this.#exigirAdmin();
    return this.#store.removerEndpoint(String(tribunal), Number(grau));
  }

  estadoSincronia(): Promise<EstadoSincronia> {
    return this.#store.estadoSincronia();
  }

  /** Syncs now instead of waiting for the next pass. */
  async sincronizar(): Promise<{ intimacoes: number; movimentacoes: number }> {
    return this.#store.sincronizar();
  }

  /** Reaches every source from the store's location. Admins only. */
  diagnosticoFontes(): Promise<ItemDiagnostico[]> {
    this.#exigirAdmin();
    return this.#store.diagnostico();
  }
}

export function describeProcessosAccount(): AccountDescription {
  return {
    displayName: "Intimações",
    avatar: PROCESSOS_ICON,
    singleton: { tsType: "ProcessosSession" },
    providesUi: { title: "Intimações", icon: PROCESSOS_ICON },
  };
}

@validateRpc()
export class ProcessosAccount
  extends WorkerEntrypoint<Cloudflare.Env, ProcessosProps>
  implements GatekeeperUser
{
  async describe(): Promise<AccountDescription> {
    return describeProcessosAccount();
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<ProcessosSession>>> {
    return this.ctx.exports.ProcessosGatekeeper({ props: this.ctx.props });
  }

  /** Opens the Intimações page for the signed-in lawyer. */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const dominio = this.ctx.props.sharingDomain;
    const store = processosFor(this.ctx.exports, dominio);
    await store.configurar(dominio);
    const ui = new NativeRpcStub(new ProcessosManagementApi(
      store,
      registryFor(this.ctx.exports, dominio),
      this.ctx.exports.DocumentVault.getByName(dominio),
      context.isAdmin === true,
      typeof context.username === "string" ? context.username : null,
    ));
    return { iframeHtml: PROCESSOS_HTML, ui };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): never {
    throw new Error("Processos não tem recursos endereçados por URL.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Processos não tem recursos endereçados por URL.");
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async revoke(): Promise<void> {}

  reconnect(): Promise<{ url: string }> {
    throw new Error("Processos não tem fluxo de conexão.");
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
export class ProcessosVendor extends WorkerEntrypoint<Cloudflare.Env, Partial<ProcessosProps>> {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Intimações",
      url: "https://lume.app/",
      logo: PROCESSOS_ICON,
      tagline: "Acompanhamento de intimações e movimentações",
      description:
        "Acompanha as intimações pendentes no PJe (pelo MNI, com a senha de cada advogado, sem abrir " +
        "nada sozinho), as publicações do DJEN pela OAB e as movimentações do DataJud, e sugere os " +
        "prazos na Agenda.",
      autoProvisionsAccount: true,
      providesAuth: false,
      providesNotifications: true,
    };
  }

  /** New notices and docket entries to announce. */
  async takeNotifications(): Promise<GatekeeperNotification[]> {
    const domain = this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN;
    const store = processosFor(this.ctx.exports, domain);
    // The cron that polls notifications also keeps the sync alarm armed.
    await store.configurar(domain);
    return store.retirarAvisos();
  }

  async ackNotifications(ids: string[]): Promise<void> {
    const domain = this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN;
    await processosFor(this.ctx.exports, domain).confirmarAvisos(ids);
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.ProcessosAccount({
      props: { sharingDomain: this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Processos é provisionado automaticamente e não tem fluxo de conexão.");
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
