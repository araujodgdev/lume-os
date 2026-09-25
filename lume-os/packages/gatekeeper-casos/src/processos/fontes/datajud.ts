// DataJud: the CNJ's public API over every court's procedural data. Used for docket entries of the
// firm's cases. Updated with a delay of days, and without cases under seal.

import { indiceDataJud } from "./tribunais.js";

const BASE = "https://api-publica.datajud.cnj.jus.br";

/** The public key the CNJ publishes on its wiki; `DATAJUD_API_KEY` overrides it when it rotates. */
export const CHAVE_PUBLICA_DATAJUD = "cDZHYzlZa0JadVREZDJCendQbXY6SkJlTzNjLV9TRENyQk1RdnFKZGRQdw==";

export class FalhaDataJud extends Error {}

export type MovimentoDataJud = { dataHora: string; codigo?: number; descricao: string };

type Movimento = { codigo?: number; nome?: string; dataHora?: string; complementosTabelados?: { nome?: string; descricao?: string }[] };

export function lerMovimentos(corpo: unknown): MovimentoDataJud[] {
  const hits = (corpo as { hits?: { hits?: { _source?: { movimentos?: Movimento[] } }[] } }).hits?.hits;
  if (!Array.isArray(hits)) throw new FalhaDataJud("O DataJud respondeu num formato inesperado.");
  const vistos = new Set<string>();
  const movimentos: MovimentoDataJud[] = [];
  // A case may appear once per instance; their entries are merged.
  for (const hit of hits) {
    for (const m of hit._source?.movimentos ?? []) {
      if (!m.dataHora) continue;
      const complementos = (m.complementosTabelados ?? []).map((c) => c.nome ?? c.descricao).filter(Boolean);
      const descricao = [m.nome ?? "Movimentação", ...complementos].join(" · ");
      const dataHora = m.dataHora.slice(0, 16);
      const chave = `${dataHora}|${m.codigo ?? ""}|${descricao}`;
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      movimentos.push({ dataHora, descricao, ...(m.codigo ? { codigo: m.codigo } : {}) });
    }
  }
  return movimentos.toSorted((a, b) => b.dataHora.localeCompare(a.dataHora));
}

export async function movimentosDoProcesso(fetcher: typeof fetch, chave: string, tribunal: string, numero: string): Promise<MovimentoDataJud[]> {
  let resposta: Response;
  try {
    resposta = await fetcher(`${BASE}/${indiceDataJud(tribunal)}/_search`, {
      method: "POST",
      headers: { Authorization: `APIKey ${chave}`, "Content-Type": "application/json" },
      body: JSON.stringify({ size: 5, query: { match: { numeroProcesso: numero.replace(/\D/g, "") } } }),
    });
  } catch (erro) {
    throw new FalhaDataJud(`Sem conexão com o DataJud: ${(erro as Error).message}`);
  }
  if (resposta.status === 401 || resposta.status === 403) {
    throw new FalhaDataJud(`O DataJud recusou a chave de acesso (${resposta.status}). Atualize DATAJUD_API_KEY.`);
  }
  if (!resposta.ok) throw new FalhaDataJud(`O DataJud respondeu ${resposta.status}.`);
  return lerMovimentos(await resposta.json());
}
