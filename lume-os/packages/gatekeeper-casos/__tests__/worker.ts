import { DurableObject, RpcStub, RpcTarget } from "cloudflare:workers";
import type { ActionDescription, ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { CasosGatekeeper } from "../src/casos.js";
import type { AlteracoesCaso, Caso, CasosSession, FiltroCasos, NovoCaso, ResumoCaso } from "../src/types.js";

export { default } from "../src/worker.js";
export * from "../src/worker.js";
// Vitest's ctx.exports analyzer does not follow the production barrel re-export.
export { CasosGatekeeper, CasosAccount, CasosVerifier } from "../src/casos.js";
export { CaseRegistry } from "../src/registry.js";

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
