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
import { boundAgentCatalog } from "@gadgets/workshop-shared/gatekeeper";
import {
  applyAlteracoes,
  compareCasos,
  matchesFiltro,
  resumoCaso,
  validateAlteracoes,
  validateFiltro,
  validateNovoCaso,
  type Alteracoes,
  type DadosCaso,
} from "./caso.js";
import { normalizeCnj } from "./cnj.js";
import { agendaFor, type AgendaStore } from "./agenda/store.js";
import { verificarTexto } from "./pesquisa/busca.js";
import { indiceFor, type IndiceJurisprudencia } from "./pesquisa/indice.js";
import type { JulgadoSalvo } from "./pesquisa/types.js";
import type { Compromisso } from "./agenda/types.js";
import { montarCampos } from "./pecas/campos.js";
import { gerarDocx } from "./pecas/modelo.js";
import type { CaseRegistry } from "./registry.js";
import type {
  Achado,
  ConfiguracoesEscritorio,
  DocumentoCofre,
  DocumentVault,
  InfoModelo,
  JanelaTexto,
  UploadIniciado,
} from "./cofre/vault.js";
import type {
  AlteracoesCaso,
  Caso,
  CasosSession,
  DocumentoInfo,
  FiltroCasos,
  NovaPeca,
  NovoCaso,
  PecaGerada,
  ResultadoBusca,
  ResumoCaso,
  TrechoDocumento,
} from "./types.js";
import TYPES_CODE from "./types.txt";
import APP_HTML from "./generated/app.txt";

/** Phosphor "Scales" icon, drawn with currentColor so the Workshop can tint it. */
const CASOS_ICON = {
  url:
    "data:image/svg+xml," +
    encodeURIComponent(
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
        "<path d='M239.43 133l-32-80A8 8 0 0 0 200 48a8.39 8.39 0 0 0-1.73.19L136 62V40a8 8 0 0 0-16 0v25.52L54.27 80.19A8 8 0 0 0 48.57 85l-32 80a7.92 7.92 0 0 0-.57 3c0 23.31 24.54 32 40 32s40-8.69 40-32a7.92 7.92 0 0 0-.57-3L66.92 93.77 120 82v134H96a8 8 0 0 0 0 16h64a8 8 0 0 0 0-16h-24V78.42l51.61-11.47-28.18 70.46a7.92 7.92 0 0 0-.57 3c0 23.31 24.54 32 40 32s40-8.69 40-32a7.92 7.92 0 0 0-.43-3ZM56 184c-7.53 0-22.76-3.61-23.93-14.64L56 109.54l23.93 59.82C78.76 180.39 63.53 184 56 184Zm144-32c-7.53 0-22.76-3.61-23.93-14.64L200 77.54l23.93 59.82C222.76 148.39 207.53 152 200 152Z'/></svg>",
    ),
};

/** Deployments that pass no binding props (local dev) share this registry. */
export const DEFAULT_SHARING_DOMAIN = "default";

/** How many cases the agent catalog lists; the agent reaches the rest through `list()`. */
const CATALOG_LIMIT = 200;

/** Longest `resumo` quoted in an approval description before it is cut short. */
const DESCRIPTION_RESUMO_LIMIT = 4_000;

const CREATE_KIND: ActionKind = { tag: "casos.create", label: "Criar caso" };
const UPDATE_KIND: ActionKind = { tag: "casos.update", label: "Alterar caso" };
const PECA_KIND: ActionKind = { tag: "casos.peca", label: "Salvar peça gerada no Cofre" };

/** Largest HTML a piece may be generated from (the Documentos format embeds images inline). */
const MAX_HTML_PECA = 20 * 1024 * 1024;

type CasosProps = { sharingDomain: string };

/** A proposal the agent made through this workspace's session, as stored by the facet. */
type Proposta =
  | { id: number; kind: "create"; casoId: string; dados: DadosCaso; submittedAt: number }
  | { id: number; kind: "update"; casoId: string; alteracoes: Alteracoes; submittedAt: number };

/** A generated piece waiting for approval, as the facet stores it. */
type PecaPendente = { id: number; casoId: string; nome: string; tamanho: number; submittedAt: number };

type PropostaRow = {
  id: number;
  kind: "create" | "update" | "peca";
  caso_id: string;
  payload: string;
  submitted_at: number;
  state: "pending" | "applied";
  anterior: string | null;
};

export function registryFor(
  exports: Cloudflare.Exports,
  sharingDomain: string,
): DurableObjectStub<CaseRegistry> {
  return exports.CaseRegistry.getByName(sharingDomain);
}

function vaultFor(exports: Cloudflare.Exports, sharingDomain: string): DurableObjectStub<DocumentVault> {
  return exports.DocumentVault.getByName(sharingDomain);
}

/** The agent's view of a vault document: OCR in progress is just "processando". */
export function documentoInfo(doc: DocumentoCofre): DocumentoInfo {
  const info: DocumentoInfo = {
    id: doc.id,
    casoId: doc.casoId,
    nome: doc.nome,
    tipo: doc.mime,
    tamanho: doc.tamanho,
    status: doc.status === "ocr" || doc.status === "enviando" ? "processando" : doc.status,
    criadoEm: doc.criadoEm,
  };
  if (doc.paginas !== undefined) info.paginas = doc.paginas;
  if (doc.aviso) info.aviso = doc.aviso;
  return info;
}

/**
 * The agent's view of the registry: the stored cases with this workspace's pending proposals laid
 * over them, so the agent reads back what it proposed before a lawyer approves it.
 */
export function simulate(stored: Caso[], propostas: Proposta[]): Caso[] {
  const byId = new Map(stored.map((caso) => [caso.id, caso]));
  for (const proposta of propostas) {
    if (proposta.kind === "create") {
      if (!byId.has(proposta.casoId)) {
        byId.set(proposta.casoId, {
          ...proposta.dados,
          id: proposta.casoId,
          criadoEm: proposta.submittedAt,
          atualizadoEm: proposta.submittedAt,
        });
      }
    } else {
      const current = byId.get(proposta.casoId);
      if (current) {
        byId.set(proposta.casoId, applyAlteracoes(current, proposta.alteracoes, proposta.submittedAt));
      }
    }
  }
  return [...byId.values()].toSorted(compareCasos);
}

/**
 * What a session needs from its facet. Plain closures rather than facet methods, so none of this is
 * reachable over RPC by whoever holds the facet.
 */
export type CasosBackend = {
  simulated(): Promise<Caso[]>;
  proposeCreate(queue: NativeRpcStub<ApprovalQueue>, dados: DadosCaso): Promise<string>;
  proposeUpdate(
    queue: NativeRpcStub<ApprovalQueue>, casoId: string, alteracoes: Alteracoes,
  ): Promise<void>;
  proposePeca(queue: NativeRpcStub<ApprovalQueue>, peca: NovaPeca): Promise<PecaGerada>;
  pecasPendentes(casoId: string): PecaPendente[];
  vault(): DurableObjectStub<DocumentVault>;
};

@validateRpc()
export class CasosSessionImpl extends RpcTarget implements CasosSession {
  readonly #gatekeeper: CasosBackend;
  readonly #approvalQueue: NativeRpcStub<ApprovalQueue>;

  constructor(gatekeeper: CasosBackend, approvalQueue: NativeRpcStub<ApprovalQueue>) {
    super();
    this.#gatekeeper = gatekeeper;
    this.#approvalQueue = approvalQueue;
  }

  /** Lists the firm's cases matching `filtro`, without their `resumo`. */
  async list(filtro?: FiltroCasos): Promise<ResumoCaso[]> {
    const valid = validateFiltro(filtro);
    const casos = (await this.#gatekeeper.simulated()).filter((caso) => matchesFiltro(caso, valid));
    await this.#approvalQueue.authorizeObservation({
      title: "Listar casos",
      description: `Listou ${casos.length} caso(s) do escritório${describeFiltro(valid)}.`,
    });
    return casos.map(resumoCaso);
  }

  /** Reads one case, including its `resumo`. */
  async get(id: string): Promise<Caso | null> {
    const caso = (await this.#gatekeeper.simulated()).find((c) => c.id === id) ?? null;
    await this.#approvalQueue.authorizeObservation({
      title: caso ? `Ler caso: ${caso.titulo}` : "Ler caso inexistente",
      description: caso ? `Leu o caso "${caso.titulo}" (${caso.id}).` : `Nenhum caso com id ${id}.`,
    });
    return caso;
  }

  /** Reads the case with a CNJ number. */
  async findByNumero(numeroCnj: string): Promise<Caso | null> {
    const numero = normalizeCnj(numeroCnj);
    const caso = (await this.#gatekeeper.simulated()).find((c) => c.numeroCnj === numero) ?? null;
    await this.#approvalQueue.authorizeObservation({
      title: `Buscar processo ${numero}`,
      description: caso
        ? `Encontrou o caso "${caso.titulo}" (${caso.id}) pelo número ${numero}.`
        : `Nenhum caso com o número ${numero}.`,
    });
    return caso;
  }

  /** Proposes a new case. */
  create(novo: NovoCaso): Promise<string> {
    return this.#gatekeeper.proposeCreate(this.#approvalQueue, validateNovoCaso(novo));
  }

  /** Proposes changes to a case. */
  update(id: string, alteracoes: AlteracoesCaso): Promise<void> {
    return this.#gatekeeper.proposeUpdate(this.#approvalQueue, id, validateAlteracoes(alteracoes));
  }

  /** Lists a case's documents. */
  async listDocumentos(casoId: string): Promise<DocumentoInfo[]> {
    // Pieces this workspace generated appear as soon as they are proposed, like any proposal.
    const pendentes: DocumentoInfo[] = this.#gatekeeper.pecasPendentes(casoId).map((peca) => ({
      id: `pendente-${peca.id}`,
      casoId,
      nome: peca.nome,
      tipo: TIPO_DOCX,
      tamanho: peca.tamanho,
      status: "processando",
      aviso: "Aguardando aprovação para entrar no Cofre.",
      criadoEm: peca.submittedAt,
    }));
    const docs = [...pendentes, ...(await this.#gatekeeper.vault().listar(casoId)).map(documentoInfo)];
    await this.#approvalQueue.authorizeObservation({
      title: "Listar documentos do caso",
      description: `Listou ${docs.length} documento(s) do caso ${casoId}.`,
    });
    return docs;
  }

  /** Reads a window of a document's text. */
  async lerDocumento(
    documentoId: string,
    janela?: { inicio?: number; limite?: number },
  ): Promise<TrechoDocumento | null> {
    const vault = this.#gatekeeper.vault();
    const doc = await vault.obter(documentoId);
    const texto: JanelaTexto | null = doc
      ? await vault.lerTexto(documentoId, janela?.inicio ?? 0, janela?.limite ?? 40_000)
      : null;
    await this.#approvalQueue.authorizeObservation({
      title: doc ? `Ler documento: ${doc.nome}` : "Ler documento inexistente",
      description: doc && texto
        ? `Leu os caracteres ${texto.inicio} a ${texto.inicio + texto.texto.length} de ${texto.total} ` +
          `do documento "${doc.nome}" (${doc.id}).`
        : `Nenhum documento com id ${documentoId}.`,
    });
    return doc && texto ? { documentoId, ...texto } : null;
  }

  /** Generates a piece in the firm's template and proposes saving it to the case's Cofre. */
  gerarPeca(peca: NovaPeca): Promise<PecaGerada> {
    return this.#gatekeeper.proposePeca(this.#approvalQueue, peca);
  }

  /** Searches the documents' text. */
  async buscarDocumentos(consulta: string, filtro?: { casoId?: string }): Promise<ResultadoBusca[]> {
    const achados: Achado[] = await this.#gatekeeper.vault().buscar(consulta, filtro?.casoId);
    await this.#approvalQueue.authorizeObservation({
      title: "Buscar nos documentos",
      description: `Buscou "${consulta}" nos documentos${filtro?.casoId ? ` do caso ${filtro.casoId}` : ""} ` +
        `e encontrou ${achados.length} documento(s).`,
    });
    return achados;
  }

  [Symbol.dispose](): void {
    this.#approvalQueue[Symbol.dispose]?.();
  }
}

/**
 * The agent singleton, one facet per workspace. It keeps the proposals made through its sessions
 * in its own storage, applies them to the firm's registry once a lawyer approves, and lays pending
 * ones over reads (see `simulate`).
 */
@validateRpc()
export class CasosGatekeeper
  extends DurableObject<Cloudflare.Env, CasosProps>
  implements Gatekeeper<CasosSession>
{
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS propostas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        caso_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        submitted_at INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        anterior TEXT
      )
    `);
  }

  /** Describes the ambient case-registry binding. */
  async describe(): Promise<ResourceDescription> {
    return {
      url: "casos://escritorio",
      title: "Casos",
      snippet: "Os casos do escritório: cliente, partes, processo, status e resumo.",
      suggestedBindingName: "CASOS",
      tsType: "CasosSession",
    };
  }

  /** Returns the agent-facing CasosSession declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  /**
   * Case changes always wait for a lawyer. Saving a generated piece may be auto-approved: it only
   * adds a document the lawyer asked for, and reverting deletes it.
   */
  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [PECA_KIND];
  }

  /** Opens a session for the agent. */
  async startSession(approvalQueue: NativeRpcStub<ApprovalQueue>): Promise<CasosSession> {
    return new CasosSessionImpl({
      simulated: () => this.#simulated(),
      proposeCreate: (queue, dados) => this.#proposeCreate(queue, dados),
      proposeUpdate: (queue, casoId, alteracoes) => this.#proposeUpdate(queue, casoId, alteracoes),
      proposePeca: (queue, peca) => this.#proposePeca(queue, peca),
      pecasPendentes: (casoId) => this.#pecasPendentes(casoId),
      vault: () => vaultFor(this.ctx.exports, this.ctx.props.sharingDomain),
    }, approvalQueue.dup());
  }

  /** Lists the firm's open cases so the agent can find the one the lawyer means. */
  async getAgentCatalog(
    authorizer: NativeRpcStub<ObservationAuthorizer>,
  ): Promise<AgentCatalog | null> {
    const casos = (await this.#simulated()).filter((caso) => caso.status !== "encerrado");
    const documentos = await vaultFor(this.ctx.exports, this.ctx.props.sharingDomain).contarPorCaso();
    await authorizer.authorizeObservation({
      title: "Listar casos em andamento",
      description: `Listou ${casos.length} caso(s) em andamento do escritório.`,
    });
    return boundAgentCatalog(
      casos.slice(0, CATALOG_LIMIT).map((caso) => ({
        id: caso.id,
        title: caso.titulo,
        description: [
          `Cliente: ${caso.cliente.nome}`,
          caso.numeroCnj,
          caso.tribunal,
          caso.area,
          caso.status,
          documentos[caso.id] ? `${documentos[caso.id]} documento(s)` : undefined,
        ].filter(Boolean).join(" · "),
      })),
    );
  }

  /** Any collaborator is a member of the firm, and every member sees every case. */
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}

  /** No observer state is kept. */
  async removeObserver(_id: string): Promise<void> {}

  /** Applies an approved proposal to the registry. */
  async applyAction(action: number): Promise<void> {
    const row = this.#row(action);
    if (!row || row.state !== "pending") throw new Error(`Proposta ${action} não está pendente.`);
    const registry = this.#registry();
    if (row.kind === "peca") {
      const { nome } = JSON.parse(row.payload) as { nome: string };
      const objeto = await this.env.COFRE.get(this.#chavePendente(action));
      if (!objeto) throw new Error("O arquivo da peça gerada não foi encontrado. Peça ao agente para gerá-la de novo.");
      const doc = await vaultFor(this.ctx.exports, this.ctx.props.sharingDomain)
        .importarArquivo(row.caso_id, nome, new Uint8Array(await objeto.arrayBuffer()));
      this.ctx.storage.sql.exec(
        "UPDATE propostas SET state = 'applied', anterior = ? WHERE id = ?",
        JSON.stringify({ documentoId: doc.id }),
        action,
      );
      await this.env.COFRE.delete(this.#chavePendente(action));
    } else if (row.kind === "create") {
      await registry.create(row.caso_id, JSON.parse(row.payload) as DadosCaso);
      this.ctx.storage.sql.exec("UPDATE propostas SET state = 'applied' WHERE id = ?", action);
    } else {
      if (!(await registry.get(row.caso_id))) {
        throw new Error("O caso ainda não existe. Aprove primeiro a proposta que o cria.");
      }
      const { anterior } = await registry.update(row.caso_id, JSON.parse(row.payload) as Alteracoes);
      this.ctx.storage.sql.exec(
        "UPDATE propostas SET state = 'applied', anterior = ? WHERE id = ?",
        JSON.stringify(anterior),
        action,
      );
    }
  }

  /** Forgets a rejected proposal, which also drops it from simulated reads. */
  async rejectAction(action: number): Promise<void> {
    const row = this.#row(action);
    if (!row || row.state !== "pending") return;
    if (row.kind === "peca") await this.env.COFRE.delete(this.#chavePendente(action));
    this.ctx.storage.sql.exec("DELETE FROM propostas WHERE id = ?", action);
  }

  /** Undoes an applied proposal: deletes a created case, or restores the overwritten fields. */
  async revertAction(
    action: number,
  ): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const row = this.#row(action);
    if (!row || row.state !== "applied") {
      return { message: "Esta alteração não foi aplicada, então não há o que desfazer." };
    }
    const registry = this.#registry();
    if (row.kind === "peca") {
      const { documentoId } = JSON.parse(row.anterior ?? "{}") as { documentoId?: string };
      if (documentoId) await vaultFor(this.ctx.exports, this.ctx.props.sharingDomain).excluir(documentoId);
    } else if (row.kind === "create") {
      await registry.delete(row.caso_id);
    } else {
      if (!(await registry.get(row.caso_id))) {
        return { message: "O caso foi excluído depois desta alteração, então não há o que desfazer." };
      }
      await registry.update(row.caso_id, JSON.parse(row.anterior ?? "{}") as Alteracoes);
    }
    this.ctx.storage.sql.exec("DELETE FROM propostas WHERE id = ?", action);
  }

  /** The registry as this workspace's agent sees it. */
  async #simulated(): Promise<Caso[]> {
    return simulate(await this.#registry().list(), this.#pending());
  }

  /** Records a proposed case and submits it for approval, returning the new case's id. */
  async #proposeCreate(queue: NativeRpcStub<ApprovalQueue>, dados: DadosCaso): Promise<string> {
    const casos = await this.#simulated();
    assertNumeroLivre(casos, dados.numeroCnj, undefined);
    const casoId = crypto.randomUUID();
    const action = this.#insert("create", casoId, dados);
    await queue.submitAction(action, describeCreate(dados));
    return casoId;
  }

  /** Records proposed changes and submits them for approval. */
  async #proposeUpdate(
    queue: NativeRpcStub<ApprovalQueue>,
    casoId: string,
    alteracoes: Alteracoes,
  ): Promise<void> {
    const casos = await this.#simulated();
    const caso = casos.find((c) => c.id === casoId);
    if (!caso) throw new Error(`Caso não encontrado: ${casoId}.`);
    if (alteracoes.numeroCnj) assertNumeroLivre(casos, alteracoes.numeroCnj, casoId);
    const action = this.#insert("update", casoId, alteracoes);
    await queue.submitAction(action, describeUpdate(caso, alteracoes));
  }

  /**
   * Generates a piece from the Documentos HTML in the firm's template (or the built-in one), keeps
   * the file in R2 until a lawyer decides, and submits saving it to the case's Cofre.
   */
  async #proposePeca(queue: NativeRpcStub<ApprovalQueue>, peca: NovaPeca): Promise<PecaGerada> {
    const titulo = typeof peca?.titulo === "string" ? peca.titulo.trim() : "";
    if (!titulo || titulo.length > 150) throw new TypeError("Informe um título de até 150 caracteres.");
    if (typeof peca.html !== "string" || !peca.html.trim()) throw new TypeError("Informe o HTML da peça.");
    if (peca.html.length > MAX_HTML_PECA) throw new TypeError("A peça é grande demais para gerar em DOCX.");
    const caso = (await this.#simulated()).find((c) => c.id === peca.casoId);
    if (!caso) throw new Error(`Caso não encontrado: ${peca.casoId}.`);

    const vault = vaultFor(this.ctx.exports, this.ctx.props.sharingDomain);
    const [modelo, configuracoes] = await Promise.all([vault.modelo(), vault.configuracoes()]);
    const bytes = gerarDocx(modelo, peca.html, montarCampos(caso, configuracoes.cidade, new Date()));
    const nome = `${nomeDeArquivo(titulo)}.docx`;
    const citacoes = await conferirCitacoes(this.ctx.exports, peca.html);
    const action = this.#insert("peca", caso.id, { nome, tamanho: bytes.byteLength });
    await this.env.COFRE.put(this.#chavePendente(action), bytes);
    await queue.submitAction(action, {
      title: `Salvar peça no Cofre: ${nome}`,
      description:
        `O agente gerou a peça **${nome}** (${Math.max(1, Math.round(bytes.byteLength / 1024))} KB) ` +
        `para o caso "${caso.titulo}" e propõe salvá-la no Cofre do caso.\n\n` +
        (modelo
          ? "Gerada no modelo do escritório, com os campos preenchidos a partir do caso."
          : "O escritório ainda não enviou um modelo, então foi usado o padrão forense (Times New Roman 12, espaçamento 1,5).") +
        `\n\n${citacoes.texto}`,
      implementsRevert: true,
      // A piece citing case law that does not check out always waits for a lawyer.
      autoApprovable: !citacoes.problemas,
      actionKind: PECA_KIND,
    });
    return { casoId: caso.id, nome, tamanho: bytes.byteLength };
  }

  #pecasPendentes(casoId: string): PecaPendente[] {
    return this.ctx.storage.sql
      .exec<PropostaRow>(
        "SELECT * FROM propostas WHERE state = 'pending' AND kind = 'peca' AND caso_id = ? ORDER BY id DESC",
        casoId,
      )
      .toArray()
      .map((row) => {
        const { nome, tamanho } = JSON.parse(row.payload) as { nome: string; tamanho: number };
        return { id: row.id, casoId: row.caso_id, nome, tamanho, submittedAt: row.submitted_at };
      });
  }

  /** Where a generated piece waits for approval: namespaced by this facet, keyed by action. */
  #chavePendente(action: number): string {
    return `pendentes/${this.ctx.id.toString()}/${action}.docx`;
  }

  #insert(kind: PropostaRow["kind"], casoId: string, payload: unknown): number {
    return this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO propostas (kind, caso_id, payload, submitted_at) VALUES (?, ?, ?, ?) RETURNING id",
        kind,
        casoId,
        JSON.stringify(payload),
        Date.now(),
      )
      .one().id;
  }

  #pending(): Proposta[] {
    return this.ctx.storage.sql
      .exec<PropostaRow>("SELECT * FROM propostas WHERE state = 'pending' AND kind != 'peca' ORDER BY id")
      .toArray()
      .map((row) =>
        row.kind === "create"
          ? { id: row.id, kind: "create", casoId: row.caso_id, dados: JSON.parse(row.payload), submittedAt: row.submitted_at }
          : { id: row.id, kind: "update", casoId: row.caso_id, alteracoes: JSON.parse(row.payload), submittedAt: row.submitted_at },
      );
  }

  #row(action: number): PropostaRow | undefined {
    return this.ctx.storage.sql
      .exec<PropostaRow>("SELECT * FROM propostas WHERE id = ?", action)
      .toArray()[0];
  }

  #registry(): DurableObjectStub<CaseRegistry> {
    return registryFor(this.ctx.exports, this.ctx.props.sharingDomain);
  }
}

/** What the Casos page may do: lawyers edit the registry and the vault directly, without approvals. */
@validateRpc()
export class CasosManagementApi extends RpcTarget {
  readonly #registry: DurableObjectStub<CaseRegistry>;
  readonly #vault: DurableObjectStub<DocumentVault>;
  readonly #agenda: DurableObjectStub<AgendaStore>;
  readonly #indice: DurableObjectStub<IndiceJurisprudencia>;
  readonly #dominio: string;
  readonly #admin: boolean;

  constructor(
    registry: DurableObjectStub<CaseRegistry>,
    vault: DurableObjectStub<DocumentVault>,
    agenda: DurableObjectStub<AgendaStore>,
    jurisprudencia: { indice: DurableObjectStub<IndiceJurisprudencia>; dominio: string },
    admin: boolean,
  ) {
    super();
    this.#registry = registry;
    this.#vault = vault;
    this.#agenda = agenda;
    this.#indice = jurisprudencia.indice;
    this.#dominio = jurisprudencia.dominio;
    this.#admin = admin;
  }

  /** Whether this page may change the firm's settings and template. */
  ehAdmin(): boolean {
    return this.#admin;
  }

  /** The firm's settings and template description. */
  configuracoes(): Promise<ConfiguracoesEscritorio> {
    return this.#vault.configuracoes();
  }

  /** Changes the firm's settings. Admins only. */
  salvarConfiguracoes(input: { pjeLimiteMb?: number; cidade?: string }): Promise<ConfiguracoesEscritorio> {
    this.#exigirAdmin();
    return this.#vault.salvarConfiguracoes(input);
  }

  /** Replaces the firm's piece template. Admins only. */
  salvarModelo(bytes: Uint8Array): Promise<InfoModelo> {
    this.#exigirAdmin();
    return this.#vault.salvarModelo(bytes);
  }

  /** Goes back to the built-in template. Admins only. */
  removerModelo(): Promise<void> {
    this.#exigirAdmin();
    return this.#vault.removerModelo();
  }

  /** The firm's template, for checking it in Word. */
  baixarModelo(): Promise<Uint8Array | null> {
    return this.#vault.modelo();
  }

  #exigirAdmin(): void {
    if (!this.#admin) throw new Error("Só administradores podem mudar o modelo e as configurações do escritório.");
  }

  /** Cases matching `filtro`, most recently changed first, without their `resumo`. */
  async list(filtro?: FiltroCasos): Promise<ResumoCaso[]> {
    const valid = validateFiltro(filtro);
    return (await this.#registry.list()).filter((caso) => matchesFiltro(caso, valid)).map(resumoCaso);
  }

  /** The complete case, or null. */
  get(id: string): Promise<Caso | null> {
    return this.#registry.get(id);
  }

  /** Creates a case. */
  create(novo: NovoCaso): Promise<Caso> {
    return this.#registry.create(crypto.randomUUID(), validateNovoCaso(novo));
  }

  /** Changes a case. */
  async update(id: string, alteracoes: AlteracoesCaso): Promise<Caso> {
    return (await this.#registry.update(id, validateAlteracoes(alteracoes))).caso;
  }

  /** Deletes a case, every document in it and its calendar entries. */
  async delete(id: string): Promise<void> {
    await this.#vault.excluirCaso(id);
    await this.#agenda.excluirDoCaso(id);
    await this.#registry.delete(id);
  }

  /** Case law saved to a case. */
  jurisprudenciaDoCaso(casoId: string): Promise<JulgadoSalvo[]> {
    return this.#indice.salvos(this.#dominio, casoId);
  }

  /** A case's pending calendar entries, soonest first. */
  compromissosDoCaso(casoId: string): Promise<Compromisso[]> {
    return this.#agenda.consultar({ casoId, status: "pendente" });
  }

  /** A case's documents, newest first. */
  documentos(casoId: string): Promise<DocumentoCofre[]> {
    return this.#vault.listar(casoId);
  }

  /** Opens an upload to an existing case. */
  async iniciarUpload(casoId: string, arquivo: { nome: string; tamanho: number }): Promise<UploadIniciado> {
    if (!(await this.#registry.get(casoId))) throw new Error("Caso não encontrado.");
    return this.#vault.iniciarUpload(casoId, arquivo);
  }

  /** Sends one chunk of an upload. */
  enviarParte(uploadId: string, numero: number, bytes: Uint8Array): Promise<void> {
    return this.#vault.enviarParte(uploadId, numero, bytes);
  }

  /** Completes an upload and queues the document for reading. */
  concluirUpload(uploadId: string): Promise<DocumentoCofre> {
    return this.#vault.concluirUpload(uploadId);
  }

  /** Abandons an upload. */
  cancelarUpload(uploadId: string): Promise<void> {
    return this.#vault.cancelarUpload(uploadId);
  }

  /** A window of a document's extracted text, to check what was read. */
  textoDocumento(id: string, inicio?: number): Promise<JanelaTexto | null> {
    return this.#vault.lerTexto(id, inicio ?? 0, 100_000);
  }

  /** One chunk of a document's original file, for downloading. */
  baixarParte(id: string, numero: number): Promise<Uint8Array> {
    return this.#vault.baixarParte(id, numero);
  }

  /** Deletes a document. */
  excluirDocumento(id: string): Promise<void> {
    return this.#vault.excluir(id);
  }

  /** Full-text search across every case's documents. */
  buscarDocumentos(consulta: string): Promise<Achado[]> {
    return this.#vault.buscar(consulta);
  }
}

/** Describes the account's agent singleton and its Casos page. */
export function describeCasosAccount(): AccountDescription {
  return {
    displayName: "Casos",
    avatar: CASOS_ICON,
    singleton: { tsType: "CasosSession" },
    providesUi: { title: "Casos", icon: CASOS_ICON },
  };
}

@validateRpc()
export class CasosAccount
  extends WorkerEntrypoint<Cloudflare.Env, CasosProps>
  implements GatekeeperUser
{
  /** Describes the auto-provisioned Casos account. */
  async describe(): Promise<AccountDescription> {
    return describeCasosAccount();
  }

  /** Returns the firm-scoped agent singleton class. */
  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<CasosSession>>> {
    return this.ctx.exports.CasosGatekeeper({ props: this.ctx.props });
  }

  /**
   * Opens the Casos page. Every lawyer edits cases and documents; only admins change the firm's
   * template and settings. `isAdmin` comes fresh from the Workshop on every open.
   */
  async startAppUi(context: AppUiContext): Promise<GatekeeperUiFrame> {
    const ui = new NativeRpcStub(
      new CasosManagementApi(
        registryFor(this.ctx.exports, this.ctx.props.sharingDomain),
        vaultFor(this.ctx.exports, this.ctx.props.sharingDomain),
        agendaFor(this.ctx.exports, this.ctx.props.sharingDomain),
        { indice: indiceFor(this.ctx.exports), dominio: this.ctx.props.sharingDomain },
        context.isAdmin === true,
      ),
    );
    return { iframeHtml: APP_HTML, ui };
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  /** Rejects URL resource lookup because Casos is ambient-only. */
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Casos não tem recursos endereçados por URL.");
  }

  /** Rejects resource configuration because Casos is ambient-only. */
  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Casos não tem recursos endereçados por URL.");
  }

  /** Confirms there are no grantable resource scopes to expand. */
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  /** Revoking one lawyer's account leaves the firm's cases in place. */
  async revoke(): Promise<void> {}

  /** Rejects reconnect because Casos has no credentials. */
  reconnect(): Promise<{ url: string }> {
    throw new Error("Casos não tem fluxo de conexão.");
  }

  /** Returns no authentication identity. */
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  /** Mints the trivial verifier of the firm-wide observer policy. */
  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.CasosVerifier({});
  }
}

@validateRpc()
export class CasosVerifier extends WorkerEntrypoint<Cloudflare.Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Cloudflare.Env, Partial<CasosProps>> {
  /** Describes the auto-provisioned Casos vendor. */
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Casos",
      url: "https://lume.app/",
      logo: CASOS_ICON,
      tagline: "Os casos do escritório, ao alcance do agente",
      description:
        "Cadastre os casos do escritório (cliente, partes, número do processo e resumo) para que o " +
        "agente trabalhe a partir do caso inteiro. Alterações propostas pelo agente passam por aprovação.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  /** Mints an account bound to this deployment's case registry. */
  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.CasosAccount({
      props: { sharingDomain: this.ctx.props?.sharingDomain || DEFAULT_SHARING_DOMAIN },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  /** Rejects interactive connection because Casos is auto-provisioned. */
  connectAccount(
    _callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    throw new Error("Casos é provisionado automaticamente e não tem fluxo de conexão.");
  }

  /** Returns no URL-addressed resources. */
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }

  /** Returns the complete agent-facing Casos declarations. */
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

function assertNumeroLivre(casos: Caso[], numeroCnj: string | undefined, id: string | undefined) {
  if (!numeroCnj) return;
  const owner = casos.find((caso) => caso.numeroCnj === numeroCnj && caso.id !== id);
  if (owner) throw new Error(`O número ${numeroCnj} já pertence ao caso "${owner.titulo}".`);
}

function describeFiltro(filtro: FiltroCasos): string {
  const parts = [
    filtro.status && `status "${filtro.status}"`,
    filtro.busca && `busca "${filtro.busca}"`,
  ].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

const FIELD_LABELS: Record<string, string> = {
  titulo: "Título",
  cliente: "Cliente",
  poloCliente: "Polo do cliente",
  parteContraria: "Parte contrária",
  numeroCnj: "Número CNJ",
  tribunal: "Tribunal",
  orgaoJulgador: "Órgão julgador",
  area: "Área",
  status: "Status",
  responsaveis: "Responsáveis",
  resumo: "Resumo",
};

function describeCreate(dados: DadosCaso): ActionDescription {
  return {
    title: `Criar caso: ${dados.titulo}`,
    description: `O agente propõe cadastrar um novo caso no escritório.\n\n${describeFields(dados)}`,
    implementsRevert: true,
    actionKind: CREATE_KIND,
  };
}

function describeUpdate(caso: Caso, alteracoes: Alteracoes): ActionDescription {
  return {
    title: `Alterar caso: ${caso.titulo}`,
    description:
      `O agente propõe alterar o caso "${caso.titulo}".\n\n` +
      `**Novos valores**\n\n${describeFields(alteracoes)}`,
    implementsRevert: true,
    actionKind: UPDATE_KIND,
  };
}

function describeFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([key, value]) => `- **${FIELD_LABELS[key] ?? key}:** ${formatValue(key, value)}`)
    .join("\n");
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return "_(vazio)_";
  }
  if (Array.isArray(value)) return value.join("; ");
  if (typeof value === "object") {
    const cliente = value as Caso["cliente"];
    return cliente.documento ? `${cliente.nome} (${cliente.documento})` : cliente.nome;
  }
  const text = String(value);
  if (key === "resumo") {
    const cut = text.length > DESCRIPTION_RESUMO_LIMIT;
    return `\n\n${quote(cut ? text.slice(0, DESCRIPTION_RESUMO_LIMIT) : text)}${cut ? "\n\n_(resumo cortado)_" : ""}`;
  }
  return text;
}

function quote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

const TIPO_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** How long a piece's citation check may take before the approval goes out without it. */
const LIMITE_VERIFICACAO_MS = 25_000;

/**
 * Checks the case law a piece cites, for its approval description. Never blocks generating the
 * piece: past the time limit, or on error, the description says the check did not run.
 */
async function conferirCitacoes(exports: Cloudflare.Exports, html: string): Promise<{ texto: string; problemas: boolean }> {
  try {
    const relatorio = await Promise.race([
      verificarTexto(exports, html),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LIMITE_VERIFICACAO_MS)),
    ]);
    if (!relatorio) return { texto: "**Citações de jurisprudência:** a conferência demorou demais; use a página Pesquisa → Verificar citações.", problemas: false };
    if (relatorio.citacoes.length === 0) return { texto: "**Citações de jurisprudência:** nenhuma.", problemas: false };
    const rotulo = { confirmada: "confirmada", divergente: "DIVERGENTE", nao_encontrada: "NÃO ENCONTRADA", nao_verificavel: "não verificável" } as const;
    const linhas = relatorio.citacoes.map((c) => `- ${c.trecho}: **${rotulo[c.status]}**. ${c.observacao}`);
    const problemas = relatorio.citacoes.some((c) => c.status === "divergente" || c.status === "nao_encontrada");
    return { texto: `**Citações de jurisprudência:** ${relatorio.resumo}\n\n${linhas.join("\n")}`, problemas };
  } catch {
    return { texto: "**Citações de jurisprudência:** não foi possível conferir agora.", problemas: false };
  }
}

/** A safe file name from a piece title: no path separators or control characters, at most 120 chars. */
export function nomeDeArquivo(titulo: string): string {
  const limpo = [...titulo.normalize("NFC")]
    .map((c) => (/[\\/:*?"<>|]/.test(c) || c.charCodeAt(0) < 0x20 ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return limpo || "peca";
}
