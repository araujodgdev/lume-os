import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { CasosGatekeeper } from "../src/casos.js";
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
} from "../src/types.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { CasosGatekeeper, CasosAccount, CasosVerifier } from "../src/casos.js";
export { CaseRegistry } from "../src/registry.js";
export { DocumentVault } from "../src/cofre/vault.js";
export { AgendaStore } from "../src/agenda/store.js";
export { AgendaGatekeeper, AgendaAccount } from "../src/agenda/agenda.js";
import type { AgendaGatekeeper } from "../src/agenda/agenda.js";
import type { AgendaSession } from "../src/agenda/types.js";
import { setExtratorFactory } from "../src/cofre/vault.js";
import type { Extrator } from "../src/cofre/extrator.js";

type Recorded =
  | { type: "observation"; description: ObservationDescription }
  | { type: "action"; action: number; description: ActionDescription };

class TestApprovalQueue extends RpcTarget {
  constructor(private readonly events: Recorded[]) {
    super();
  }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.events.push({ type: "observation", description });
  }
  async submitAction(action: number, description: ActionDescription): Promise<void> {
    this.events.push({ type: "action", action, description });
  }
  async bindHook(): Promise<void> {
    throw new Error("Casos binds no hooks.");
  }
}

/**
 * Stands in for the Overseer: hosts one CasosGatekeeper facet per name (a workspace) and drives it
 * the way the Workshop does, recording what the facet reports to the approval queue.
 */
export class CasosTestParent extends DurableObject<Cloudflare.Env> {
  #events: Recorded[] = [];

  #facet(name: string, sharingDomain: string): DurableObjectStub<CasosGatekeeper> {
    return this.ctx.facets.get<CasosGatekeeper>(name, () => ({
      class: this.ctx.exports.CasosGatekeeper({ props: { sharingDomain } }),
    })) as unknown as DurableObjectStub<CasosGatekeeper>;
  }

  async #session(name: string, sharingDomain: string): Promise<CasosSession> {
    const queue = new RpcStub(new TestApprovalQueue(this.#events));
    return (await this.#facet(name, sharingDomain).startSession(queue as never)) as unknown as CasosSession;
  }

  events(): Recorded[] {
    return this.#events;
  }

  async list(name: string, domain: string, filtro?: FiltroCasos): Promise<ResumoCaso[]> {
    return (await this.#session(name, domain)).list(filtro);
  }

  async get(name: string, domain: string, id: string): Promise<Caso | null> {
    return (await this.#session(name, domain)).get(id);
  }

  async findByNumero(name: string, domain: string, numero: string): Promise<Caso | null> {
    return (await this.#session(name, domain)).findByNumero(numero);
  }

  async create(name: string, domain: string, novo: NovoCaso): Promise<string> {
    return (await this.#session(name, domain)).create(novo);
  }

  /**
   * Like `create`, but returns the error message, or null on success. A rejection that crosses
   * the test's RPC boundary is reported by workerd as uncaught even when the test awaits it.
   */
  async createError(name: string, domain: string, novo: NovoCaso): Promise<string | null> {
    try {
      await (await this.#session(name, domain)).create(novo);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async update(name: string, domain: string, id: string, alteracoes: AlteracoesCaso): Promise<void> {
    return (await this.#session(name, domain)).update(id, alteracoes);
  }

  async listDocumentos(name: string, domain: string, casoId: string): Promise<DocumentoInfo[]> {
    return (await this.#session(name, domain)).listDocumentos(casoId);
  }

  async lerDocumento(
    name: string, domain: string, id: string, janela?: { inicio?: number; limite?: number },
  ): Promise<TrechoDocumento | null> {
    return (await this.#session(name, domain)).lerDocumento(id, janela);
  }

  async buscarDocumentos(
    name: string, domain: string, consulta: string, casoId?: string,
  ): Promise<ResultadoBusca[]> {
    return (await this.#session(name, domain)).buscarDocumentos(consulta, casoId ? { casoId } : undefined);
  }

  async gerarPeca(name: string, domain: string, peca: NovaPeca): Promise<PecaGerada> {
    return (await this.#session(name, domain)).gerarPeca(peca);
  }

  async autoApprovable(name: string, domain: string) {
    return this.#facet(name, domain).getAutoApprovableActions();
  }

  async catalog(name: string, domain: string) {
    const queue = new RpcStub(new TestApprovalQueue(this.#events));
    return this.#facet(name, domain).getAgentCatalog(queue as never);
  }

  async apply(name: string, domain: string, action: number): Promise<void> {
    return this.#facet(name, domain).applyAction(action);
  }

  async reject(name: string, domain: string, action: number): Promise<void> {
    await this.#facet(name, domain).rejectAction(action);
  }

  async revert(name: string, domain: string, action: number) {
    return this.#facet(name, domain).revertAction(action);
  }
}

/**
 * Stands in for the Overseer for the Agenda facet. `sessao` runs one session method and returns
 * its result or error message, since a rejection crossing the test's RPC boundary is reported as
 * uncaught.
 */
export class AgendaTestParent extends DurableObject<Cloudflare.Env> {
  #events: Recorded[] = [];

  #facet(name: string, sharingDomain: string): DurableObjectStub<AgendaGatekeeper> {
    return this.ctx.facets.get<AgendaGatekeeper>(name, () => ({
      class: this.ctx.exports.AgendaGatekeeper({ props: { sharingDomain } }),
    })) as unknown as DurableObjectStub<AgendaGatekeeper>;
  }

  events(): Recorded[] {
    return this.#events;
  }

  async sessao<M extends keyof AgendaSession>(
    name: string,
    domain: string,
    metodo: M,
    ...args: Parameters<AgendaSession[M]>
  ): Promise<{ ok: Awaited<ReturnType<AgendaSession[M]>> } | { erro: string }> {
    const queue = new RpcStub(new TestApprovalQueue(this.#events));
    const session = (await this.#facet(name, domain).startSession(queue as never)) as unknown as AgendaSession;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: await (session[metodo] as any)(...args) };
    } catch (error) {
      return { erro: (error as Error).message };
    }
  }

  async autoApprovable(name: string, domain: string) {
    return this.#facet(name, domain).getAutoApprovableActions();
  }

  async catalog(name: string, domain: string) {
    const queue = new RpcStub(new TestApprovalQueue(this.#events));
    return this.#facet(name, domain).getAgentCatalog(queue as never);
  }

  async apply(name: string, domain: string, action: number): Promise<string | null> {
    try {
      await this.#facet(name, domain).applyAction(action);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async reject(name: string, domain: string, action: number): Promise<void> {
    await this.#facet(name, domain).rejectAction(action);
  }

  async revert(name: string, domain: string, action: number) {
    return this.#facet(name, domain).revertAction(action);
  }
}

/**
 * A serializable description of a fake extractor, so a test can configure it over RPC and it lands
 * in the same module instance as the vault.
 */
export type FakeExtrator = {
  /** Markdown `paraMarkdown` returns, by file name; missing names return "". */
  markdown?: Record<string, string>;
  /** Page count of the original PDF. */
  paginas?: number;
  /** Whether OCR is configured. */
  ocr?: boolean;
  /** What each successive OCR call answers; "ok" once the script runs out. */
  ocrRoteiro?: ("ok" | "longo" | "recusado" | "falha")[];
  /** How many `paraMarkdown` calls fail before one succeeds. */
  falhasMarkdown?: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
let chamadas: string[] = [];

/** A fake batch PDF: its bytes just record how many pages it holds. */
function lotePdf(paginas: number): Uint8Array {
  return encoder.encode(`%PDF-paginas:${paginas}`);
}

function fakeExtrator(spec: FakeExtrator): Extrator {
  const roteiro = [...(spec.ocrRoteiro ?? [])];
  let falhas = spec.falhasMarkdown ?? 0;
  const paginasDe = (pdf: Uint8Array) =>
    Number(/^%PDF-paginas:(\d+)/.exec(decoder.decode(pdf))?.[1] ?? spec.paginas ?? 1);
  return {
    async paraMarkdown(nome) {
      chamadas.push(`markdown:${nome}`);
      if (falhas-- > 0) throw new Error("falha temporária");
      return spec.markdown?.[nome] ?? "";
    },
    contarPaginas: async (pdf) => paginasDe(pdf),
    async dividirPdf(pdf, porLote) {
      const total = paginasDe(pdf);
      const lotes: Uint8Array[] = [];
      for (let feitas = 0; feitas < total; feitas += porLote) {
        lotes.push(lotePdf(Math.min(porLote, total - feitas)));
      }
      return lotes;
    },
    ocr: spec.ocr
      ? {
          async transcreverPdf(pdf, primeira, paginas) {
            chamadas.push(`ocr:${primeira}+${paginas}`);
            if (paginasDe(pdf) !== paginas) throw new Error(`lote com ${paginasDe(pdf)} páginas, esperado ${paginas}`);
            const proximo = roteiro.shift() ?? "ok";
            if (proximo === "falha") throw new Error("OCR indisponível");
            if (proximo !== "ok") return { status: proximo };
            const texto = Array.from({ length: paginas }, (_, i) =>
              `--- Página ${primeira + i} ---\nConteúdo da página ${primeira + i}`).join("\n");
            return { status: "ok", texto };
          },
          async transcreverImagem() {
            chamadas.push("ocr:imagem");
            return { status: "ok", texto: "Texto da imagem digitalizada" };
          },
        }
      : null,
  };
}

/** Installs a fake extractor for every vault in this isolate, and resets the call log. */
export class CofreTestHooks extends DurableObject<Cloudflare.Env> {
  configurar(spec: FakeExtrator | null): void {
    chamadas = [];
    // One instance for the whole test, so its script and failure counter carry across alarms.
    const fake = spec ? fakeExtrator(spec) : null;
    setExtratorFactory(fake ? () => fake : null);
  }

  chamadas(): string[] {
    return chamadas;
  }
}

// --- Pesquisa ---

export { IndiceJurisprudencia } from "../src/pesquisa/indice.js";
export { BuscaAoVivo } from "../src/pesquisa/ao-vivo.js";
export { PesquisaGatekeeper, PesquisaAccount } from "../src/pesquisa/pesquisa.js";
import type { PesquisaGatekeeper } from "../src/pesquisa/pesquisa.js";
import type { PesquisaSession } from "../src/pesquisa/types.js";
import { setFetchIndice } from "../src/pesquisa/indice.js";
import { setContextoAoVivo } from "../src/pesquisa/ao-vivo.js";
import type { PaginaNavegador } from "../src/pesquisa/fontes/fonte.js";
import stjEspelhos from "./fixtures/stj-espelhos.json";
import stjTemas from "./fixtures/stj-temas.csv?raw";
import tstPesquisa from "./fixtures/tst-pesquisa.json";
import sconHtml from "./fixtures/scon-resultados.sintetico.html?raw";
import esajHtml from "./fixtures/esaj-resultados.sintetico.html?raw";

/** How the fake courts behave. */
export type FakeTribunais = { stfBloqueado?: boolean; sconVazio?: boolean };

let requisicoes: string[] = [];

function json(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "Content-Type": "application/json" } });
}

/** The STJ's open data: one espelhos file for the Terceira Turma and the themes file. */
const fetchStj: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input);
  requisicoes.push(url);
  const show = /package_show\?id=(.+)$/.exec(url);
  if (show) {
    const recursos =
      show[1] === "espelhos-de-acordaos-terceira-turma"
        ? [{ id: "r-202608", name: "20260831.json", format: "JSON", url: "https://fixture/stj-espelhos.json" }]
        : show[1] === "precedentes-qualificados"
          ? [{ id: "r-temas", name: "Temas.csv", format: "CSV", url: "https://fixture/temas.csv" }]
          : [];
    return json({ success: true, result: { resources: recursos } });
  }
  if (url === "https://fixture/stj-espelhos.json") return json(stjEspelhos);
  if (url === "https://fixture/temas.csv") return new Response(stjTemas);
  return new Response("not found", { status: 404 });
};

function fakeTribunais(spec: FakeTribunais) {
  const fetchFake: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    requisicoes.push(url);
    if (url.includes("jurisprudencia-backend2.tst.jus.br")) {
      const corpo = JSON.parse(String(init?.body ?? "{}")) as { numeracaoUnica?: { numero?: string } };
      const alvo = corpo.numeracaoUnica?.numero;
      const registros = (tstPesquisa as { registros: { registro: { numeracaoUnica: { numero: number } } }[] }).registros
        .filter((r) => !alvo || String(r.registro.numeracaoUnica.numero) === alvo);
      return json({ ...tstPesquisa, registros });
    }
    if (url.includes("jurisprudencia.stf.jus.br")) return new Response("blocked", { status: spec.stfBloqueado ? 403 : 500 });
    if (url.includes("scon.stj.jus.br")) {
      return new Response(spec.sconVazio ? "<html><body>Nenhum documento encontrado</body></html>" : sconHtml, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  const pagina: PaginaNavegador = {
    async goto(url) { requisicoes.push(`navegador:${url}`); },
    async type() {},
    async click() {},
    async waitForSelector() {},
    async content() { return esajHtml; },
    async evaluate() { return { status: 403, texto: "blocked" } as never; },
  };
  return { fetch: fetchFake, agora: () => Date.now(), navegador: <T,>(usar: (p: PaginaNavegador) => Promise<T>) => usar(pagina) };
}

/** Points Pesquisa's network at fixtures, from inside the Worker's module instance. */
export class PesquisaTestHooks extends DurableObject<Cloudflare.Env> {
  configurar(spec: FakeTribunais | null): void {
    requisicoes = [];
    setFetchIndice(spec ? fetchStj : null);
    setContextoAoVivo(spec ? () => fakeTribunais(spec) : null);
  }

  requisicoes(): string[] {
    return requisicoes;
  }
}

/** Hosts the Pesquisa facet as the Overseer would. */
export class PesquisaTestParent extends DurableObject<Cloudflare.Env> {
  #events: Recorded[] = [];

  #facet(name: string, sharingDomain: string): DurableObjectStub<PesquisaGatekeeper> {
    return this.ctx.facets.get<PesquisaGatekeeper>(name, () => ({
      class: this.ctx.exports.PesquisaGatekeeper({ props: { sharingDomain } }),
    })) as unknown as DurableObjectStub<PesquisaGatekeeper>;
  }

  events(): Recorded[] {
    return this.#events;
  }

  async sessao<M extends keyof PesquisaSession>(
    name: string,
    domain: string,
    metodo: M,
    ...args: Parameters<PesquisaSession[M]>
  ): Promise<{ ok: Awaited<ReturnType<PesquisaSession[M]>> } | { erro: string }> {
    const queue = new RpcStub(new TestApprovalQueue(this.#events));
    const session = (await this.#facet(name, domain).startSession(queue as never)) as unknown as PesquisaSession;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: await (session[metodo] as any)(...args) };
    } catch (error) {
      return { erro: (error as Error).message };
    }
  }

  async apply(name: string, domain: string, action: number): Promise<string | null> {
    try {
      await this.#facet(name, domain).applyAction(action);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }

  async revert(name: string, domain: string, action: number) {
    return this.#facet(name, domain).revertAction(action);
  }
}

// --- Processos ---

export { ProcessosStore } from "../src/processos/store.js";
export { ProcessosGatekeeper, ProcessosAccount } from "../src/processos/processos.js";
import type { ProcessosGatekeeper } from "../src/processos/processos.js";
import type { ProcessosSession } from "../src/processos/types.js";
import { setFetchProcessos } from "../src/processos/store.js";
import { ProcessosManagementApi } from "../src/processos/processos.js";

/** How the fake courts behave: what each source answers. */
export type FakeProcessos = {
  /** The PJe password the fake MNI accepts. */
  senha: string;
  avisos?: { idAviso: string; processo: string; data: string; tipo?: string }[];
  teor?: { texto: string; prazo?: number; documentoPdf?: boolean };
  djen?: { id: string; processo: string; data: string; texto: string }[];
  datajud?: { dataHora: string; codigo: number; nome: string }[];
  /** Answer DataJud and DJEN with 403, as they do from abroad. */
  bloqueado?: boolean;
};

let chamadasProcessos: string[] = [];

function soap(corpo: string, status = 200): Response {
  return new Response(
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${corpo}</soap:Body></soap:Envelope>`,
    { status, headers: { "Content-Type": "text/xml" } },
  );
}

/** Responses shaped by the MNI 2.2.3 XSD (tipoAvisoComunicacaoPendente, tipoComunicacaoProcessual). */
function fakeProcessos(spec: FakeProcessos): typeof fetch {
  const ns = 'xmlns:ns2="http://www.cnj.jus.br/servico-intercomunicacao-2.2.3/" xmlns:ns4="http://www.cnj.jus.br/intercomunicacao-2.2.3"';
  return async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const corpo = String(init?.body ?? "");
    if (url.includes("/intercomunicacao")) {
      const op = /<ser:(\w+)>/.exec(corpo)?.[1] ?? "wsdl";
      chamadasProcessos.push(`mni:${op}`);
      const senha = /<tip:senhaConsultante>([^<]*)</.exec(corpo)?.[1];
      if (senha !== spec.senha) {
        return soap(`<ns2:${op}Resposta ${ns}><sucesso>false</sucesso><mensagem>Usuário ou senha inválidos.</mensagem></ns2:${op}Resposta>`);
      }
      // Everything lives in the first instance; the second has nothing pending.
      const primeiroGrau = url.startsWith("https://pje-consulta-publica.tjmg.jus.br/");
      if (op === "consultarAvisosPendentes") {
        const avisos = (primeiroGrau ? spec.avisos ?? [] : []).map((a) =>
          `<ns2:aviso idAviso="${a.idAviso}" tipoComunicacao="${a.tipo ?? "INT"}">` +
          `<ns4:destinatario><ns4:pessoa nome="ANA SOUZA"/></ns4:destinatario>` +
          `<ns4:processo numero="${a.processo.replace(/\D/g, "")}"><ns4:orgaoJulgador nomeOrgao="1ª Vara Cível de Belo Horizonte"/></ns4:processo>` +
          `<ns4:dataDisponibilizacao>${a.data.replace(/-/g, "")}093000</ns4:dataDisponibilizacao></ns2:aviso>`).join("");
        return soap(`<ns2:consultarAvisosPendentesResposta ${ns}><sucesso>true</sucesso><mensagem>ok</mensagem>${avisos}</ns2:consultarAvisosPendentesResposta>`);
      }
      if (op === "consultarTeorComunicacao") {
        if (!primeiroGrau) {
          return soap(`<ns2:${op}Resposta ${ns}><sucesso>false</sucesso><mensagem>Aviso não encontrado.</mensagem></ns2:${op}Resposta>`);
        }
        const t = spec.teor ?? { texto: "Intime-se." };
        const doc = t.documentoPdf
          ? `<ns4:documento descricao="Decisão.pdf" mimetype="application/pdf"><ns4:conteudo>${btoa("%PDF-1.4 decisão")}</ns4:conteudo></ns4:documento>`
          : "";
        return soap(
          `<ns2:consultarTeorComunicacaoResposta ${ns}><sucesso>true</sucesso><mensagem>ok</mensagem>` +
          `<ns2:comunicacao id="1" ${t.prazo ? `prazo="${t.prazo}" tipoPrazo="DIA"` : ""}><ns4:destinatario/><ns4:processo>x</ns4:processo>` +
          `<ns4:teor>${t.texto}</ns4:teor>${doc}</ns2:comunicacao></ns2:consultarTeorComunicacaoResposta>`,
        );
      }
      return new Response("?", { status: 404 });
    }
    if (url.startsWith("https://comunicaapi.pje.jus.br/")) {
      chamadasProcessos.push(`djen:${new URL(url).searchParams.get("numeroOab")}`);
      if (spec.bloqueado) return new Response("forbidden", { status: 403 });
      return Response.json({
        status: "success",
        items: (spec.djen ?? []).map((p) => ({
          id: p.id, numeroprocessocommascara: p.processo, siglaTribunal: "TJMG", data_disponibilizacao: p.data,
          tipoComunicacao: "Intimação", nomeOrgao: "2ª Vara Cível", texto: p.texto, link: "https://comunica.pje.jus.br/x",
        })),
      });
    }
    if (url.startsWith("https://api-publica.datajud.cnj.jus.br/")) {
      chamadasProcessos.push(`datajud:${url.split("/")[3]}`);
      if (spec.bloqueado) return new Response("forbidden", { status: 403 });
      return Response.json({ hits: { hits: [{ _source: { movimentos: spec.datajud ?? [] } }] } });
    }
    return new Response("not found", { status: 404 });
  };
}

/** Points Processos' network at fake courts, from inside the Worker's module instance. */
export class ProcessosTestHooks extends DurableObject<Cloudflare.Env> {
  configurar(spec: FakeProcessos | null): void {
    chamadasProcessos = [];
    setFetchProcessos(spec ? fakeProcessos(spec) : null);
  }

  chamadas(): string[] {
    return chamadasProcessos;
  }

  /**
   * Runs one page method as `usuario` and returns its error message, or null. A rejection that
   * crosses the test's RPC boundary is reported as uncaught even when the test awaits it.
   */
  async erroDe<M extends keyof ProcessosManagementApi>(
    domain: string,
    usuario: string,
    metodo: M,
    ...args: Parameters<ProcessosManagementApi[M]>
  ): Promise<string | null> {
    const api = new ProcessosManagementApi(
      this.ctx.exports.ProcessosStore.getByName(domain),
      this.ctx.exports.CaseRegistry.getByName(domain),
      this.ctx.exports.DocumentVault.getByName(domain),
      false,
      usuario,
    );
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (api[metodo] as any)(...args);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  }
}

/** Hosts the Processos facet as the Overseer would. */
export class ProcessosTestParent extends DurableObject<Cloudflare.Env> {
  #events: Recorded[] = [];

  #facet(name: string, sharingDomain: string): DurableObjectStub<ProcessosGatekeeper> {
    return this.ctx.facets.get<ProcessosGatekeeper>(name, () => ({
      class: this.ctx.exports.ProcessosGatekeeper({ props: { sharingDomain } }),
    })) as unknown as DurableObjectStub<ProcessosGatekeeper>;
  }

  events(): Recorded[] {
    return this.#events;
  }

  async sessao<M extends keyof ProcessosSession>(
    name: string,
    domain: string,
    metodo: M,
    ...args: Parameters<ProcessosSession[M]>
  ): Promise<{ ok: Awaited<ReturnType<ProcessosSession[M]>> } | { erro: string }> {
    const queue = new RpcStub(new TestApprovalQueue(this.#events));
    const session = (await this.#facet(name, domain).startSession(queue as never)) as unknown as ProcessosSession;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { ok: await (session[metodo] as any)(...args) };
    } catch (error) {
      return { erro: (error as Error).message };
    }
  }
}
