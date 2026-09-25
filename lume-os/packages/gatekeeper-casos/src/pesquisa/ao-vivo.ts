import { DurableObject } from "cloudflare:workers";
import { connect, launch, sessions } from "@cloudflare/puppeteer";
import type { Julgado } from "./types.js";
import { FalhaFonte, type ContextoFonte, type Filtros, type Fonte, type PaginaNavegador, type Referencia } from "./fontes/fonte.js";
import { fonteEsaj } from "./fontes/esaj.js";
import { fonteScon } from "./fontes/stj-scon.js";
import { fonteStf } from "./fontes/stf.js";
import { fonteTst } from "./fontes/tst.js";

/** The live sources, by id. */
export const FONTES_AO_VIVO: Record<string, Fonte> = {
  [fonteStf.id]: fonteStf,
  [fonteScon.id]: fonteScon,
  [fonteTst.id]: fonteTst,
  [fonteEsaj.id]: fonteEsaj,
};

/** The live source that serves a court. */
export function fonteDoTribunal(tribunal: string): Fonte | undefined {
  return Object.values(FONTES_AO_VIVO).find((f) => f.tribunais.includes(tribunal));
}

/** At least this long between two requests to the same source, to be a polite visitor. */
const INTERVALO_MINIMO_MS = 1_000;
/** A browser session stays open this long between searches, to skip the startup. */
const MANTER_NAVEGADOR_MS = 120_000;

/** Builds what sources use to reach the outside. Replaced in tests. */
let contextoFactory: (env: Cloudflare.Env) => ContextoFonte = contextoPadrao;

export function setContextoAoVivo(factory: ((env: Cloudflare.Env) => ContextoFonte) | null): void {
  contextoFactory = factory ?? contextoPadrao;
}

function contextoPadrao(env: Cloudflare.Env): ContextoFonte {
  const ctx: ContextoFonte = {
    fetch: (input, init) => fetch(input, {
      ...init,
      headers: { "Accept-Language": "pt-BR,pt;q=0.9", "User-Agent": "Mozilla/5.0 (compatible; Lume/1.0)", ...(init?.headers as Record<string, string>) },
    }),
    agora: () => Date.now(),
  };
  const browser = env.BROWSER;
  if (browser) ctx.navegador = (usar) => comNavegador(browser, usar);
  return ctx;
}

/**
 * Runs `usar` in a Browser Rendering page located in Brazil, reusing an idle session when there is
 * one: starting a browser takes seconds.
 */
async function comNavegador<T>(binding: Fetcher, usar: (pagina: PaginaNavegador) => Promise<T>): Promise<T> {
  let browser: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    const livre = (await sessions(binding)).find((s) => !s.connectionId);
    if (livre) browser = await connect(binding, livre.sessionId).catch(() => null);
  } catch {
    browser = null;
  }
  browser ??= await launch(binding, { keep_alive: MANTER_NAVEGADOR_MS, location: "BR" });
  const pagina = await browser.newPage();
  try {
    await pagina.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await pagina.setViewport({ width: 1280, height: 900 });
    return await usar(pagina as unknown as PaginaNavegador);
  } finally {
    await pagina.close().catch(() => {});
    // Disconnecting (not closing) leaves the session alive for the next search.
    browser.disconnect();
  }
}

export function aoVivoFor(exports: Cloudflare.Exports): DurableObjectStub<BuscaAoVivo> {
  // Located in South America: several courts refuse requests from abroad.
  const ns = exports.BuscaAoVivo;
  return ns.get(ns.idFromName("sam"), { locationHint: "sam" });
}

export type RespostaAoVivo = { julgados: Julgado[] } | { erro: string };

/** Searches the courts' own sites. Answers errors as values: a failed court is data, not a crash. */
export class BuscaAoVivo extends DurableObject<Cloudflare.Env> {
  readonly #ultimaChamada = new Map<string, number>();

  async buscar(fonteId: string, consulta: string, filtros: Filtros): Promise<RespostaAoVivo> {
    return this.#executar(fonteId, (fonte, ctx) => fonte.buscar(consulta, filtros, ctx));
  }

  async porNumero(fonteId: string, ref: Referencia): Promise<RespostaAoVivo> {
    return this.#executar(fonteId, (fonte, ctx) =>
      fonte.porNumero ? fonte.porNumero(ref, ctx) : Promise.reject(new FalhaFonte(`${fonte.nome} não busca por número.`)));
  }

  async #executar(fonteId: string, usar: (fonte: Fonte, ctx: ContextoFonte) => Promise<Julgado[]>): Promise<RespostaAoVivo> {
    const fonte = FONTES_AO_VIVO[fonteId];
    if (!fonte) return { erro: `Fonte desconhecida: ${fonteId}.` };
    const espera = (this.#ultimaChamada.get(fonteId) ?? 0) + INTERVALO_MINIMO_MS - Date.now();
    if (espera > 0) await new Promise((r) => setTimeout(r, espera));
    this.#ultimaChamada.set(fonteId, Date.now());
    try {
      return { julgados: await usar(fonte, contextoFactory(this.env)) };
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      return { erro: erro instanceof FalhaFonte ? mensagem : `${fonte.nome}: ${mensagem}` };
    }
  }
}
