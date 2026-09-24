import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { CasosGatekeeper } from "../src/casos.js";
import type {
  AlteracoesCaso,
  Caso,
  CasosSession,
  DocumentoInfo,
  FiltroCasos,
  NovoCaso,
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
