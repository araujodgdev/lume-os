// The contract every case-law source implements, and what they get to reach the outside world.

import type { Julgado } from "../types.js";

export type Filtros = {
  /** The court being searched, for sources that serve several (e-SAJ). */
  tribunal: string;
  desde?: string;
  ate?: string;
  limite: number;
};

/** A cited decision to look up by number. */
export type Referencia = {
  tribunal: string;
  classe?: string;
  /** Digits, or a CNJ number. */
  numero: string;
};

/** The subset of a browser page the sources use (a Puppeteer page in production). */
export interface PaginaNavegador {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number }): Promise<unknown>;
  type(selector: string, text: string): Promise<void>;
  click(selector: string): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
}

export type ContextoFonte = {
  fetch: typeof fetch;
  /**
   * Runs `usar` in a real browser page (Browser Rendering), for sources that need JavaScript or a
   * captcha token. Absent where no browser is bound.
   */
  navegador?: <T>(usar: (pagina: PaginaNavegador) => Promise<T>) => Promise<T>;
  agora: () => number;
};

export interface Fonte {
  id: string;
  nome: string;
  tribunais: readonly string[];
  /** A query the diagnostic runs, one that always has results. */
  consultaTeste: string;
  buscar(consulta: string, filtros: Filtros, ctx: ContextoFonte): Promise<Julgado[]>;
  /** Decisions with this number, for checking citations. */
  porNumero?(ref: Referencia, ctx: ContextoFonte): Promise<Julgado[]>;
}

/** A source answered in a way it should not have; the message says what, for the diagnostic. */
export class FalhaFonte extends Error {}

export async function respostaOk(resposta: Response, fonte: string): Promise<Response> {
  if (!resposta.ok) {
    throw new FalhaFonte(`${fonte} respondeu ${resposta.status}${resposta.status === 403 ? " (bloqueio de acesso)" : ""}.`);
  }
  return resposta;
}

/**
 * Calls `url` from inside a page of the source's own site, so cookies and bot-protection tokens the
 * site sets apply, as they would for a person. For sources that block plain requests.
 */
export async function fetchPelaPagina(
  ctx: ContextoFonte,
  origem: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; texto: string }> {
  if (!ctx.navegador) throw new FalhaFonte("Navegador indisponível para contornar o bloqueio.");
  return ctx.navegador(async (pagina) => {
    await pagina.goto(origem, { waitUntil: "networkidle2", timeout: 30_000 });
    return pagina.evaluate(async ({ url: alvo, init: opcoes }) => {
      // Same-origin, so the site's cookies go along by default.
      const r = await fetch(alvo, opcoes);
      return { status: r.status, texto: await r.text() };
    }, { url, init });
  });
}
