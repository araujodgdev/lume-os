// STF: the search API behind jurisprudencia.stf.jus.br. It sits behind bot protection that blocks
// plain requests from some networks, so a blocked request is retried from inside the site's own
// page. The response is read defensively: field names are the portal's, not a published contract,
// and the admin diagnostic is how a change there shows up.

import { dataIso, digitos, idJulgado, limparTexto, nomeProprio } from "../julgado.js";
import type { Julgado } from "../types.js";
import { FalhaFonte, fetchPelaPagina, type ContextoFonte, type Fonte } from "./fonte.js";

const PORTAL = "https://jurisprudencia.stf.jus.br/pages/search";
const API = "https://jurisprudencia.stf.jus.br/api/search/search";

type Fonte_ = Record<string, unknown>;

function texto(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (Array.isArray(v) && typeof v[0] === "string") return v[0].trim();
  return undefined;
}

function primeiro(s: Fonte_, ...campos: string[]): string | undefined {
  for (const campo of campos) {
    const v = texto(s[campo]);
    if (v) return v;
  }
  return undefined;
}

export function julgadoDoStf(fonte: Fonte_, capturadoEm: number): Julgado | null {
  const titulo = primeiro(fonte, "titulo");
  const classe = primeiro(fonte, "processo_classe_processual_unificada_classe_sigla") ?? titulo?.split(/\s+/)[0];
  const numero = primeiro(fonte, "processo_numero") ?? digitos(titulo ?? "");
  const ementa = primeiro(fonte, "ementa_texto", "ementa");
  if (!classe || !numero || !ementa) return null;
  const j: Julgado = {
    id: "",
    tribunal: "STF",
    tipo: "acordao",
    classe,
    numero,
    ementa: limparTexto(ementa),
    url: fonte.id ? `https://jurisprudencia.stf.jus.br/pages/search/${String(fonte.id)}/false` : PORTAL,
    fonte: "STF (jurisprudência)",
    capturadoEm,
  };
  const uf = primeiro(fonte, "procedencia_geografica_uf_sigla");
  if (uf) j.uf = uf;
  const orgao = primeiro(fonte, "orgao_julgador");
  if (orgao) j.orgaoJulgador = orgao;
  const relator = primeiro(fonte, "relator_processo_nome", "ministro_relator", "relator_acordao_nome");
  if (relator) j.relator = nomeProprio(relator.replace(/^min(istro|\.)\s*/i, ""));
  const julgamento = dataIso(primeiro(fonte, "julgamento_data"));
  if (julgamento) j.dataJulgamento = julgamento;
  const publicacao = dataIso(primeiro(fonte, "publicacao_data"));
  if (publicacao) {
    j.dataPublicacao = publicacao;
    j.veiculoPublicacao = "DJe";
  }
  j.id = idJulgado(j);
  return j;
}

function consultaElastic(query: string, limite: number, desde?: string, ate?: string) {
  const filtros: unknown[] = [{
    query_string: { default_operator: "AND", fields: ["ementa_texto^3", "documental_texto_integral", "titulo^5"], query },
  }];
  if (desde || ate) filtros.push({ range: { julgamento_data: { ...(desde ? { gte: desde } : {}), ...(ate ? { lte: ate } : {}) } } });
  return {
    query: { bool: { filter: filtros } },
    post_filter: { bool: { must: [{ term: { base: "acordaos" } }] } },
    size: limite,
    from: 0,
    sort: [{ _score: "desc" }],
  };
}

export function lerRespostaStf(corpo: unknown, capturadoEm: number): Julgado[] {
  const r = corpo as { result?: { hits?: { hits?: { _source?: Fonte_ }[] } }; hits?: { hits?: { _source?: Fonte_ }[] } };
  const hits = r.result?.hits?.hits ?? r.hits?.hits;
  if (!Array.isArray(hits)) throw new FalhaFonte("STF respondeu num formato inesperado.");
  return hits.map((h) => (h._source ? julgadoDoStf(h._source, capturadoEm) : null)).filter((j): j is Julgado => j !== null);
}

async function pesquisar(ctx: ContextoFonte, query: string, limite: number, desde?: string, ate?: string): Promise<Julgado[]> {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(consultaElastic(query, limite, desde, ate)),
  };
  let status: number;
  let texto_: string;
  try {
    const resposta = await ctx.fetch(API, init);
    status = resposta.status;
    texto_ = await resposta.text();
  } catch {
    status = 0;
    texto_ = "";
  }
  if (status === 403 || status === 0 || status === 429) {
    ({ status, texto: texto_ } = await fetchPelaPagina(ctx, PORTAL, API, init));
  }
  if (status < 200 || status >= 300) throw new FalhaFonte(`STF respondeu ${status}.`);
  try {
    return lerRespostaStf(JSON.parse(texto_), ctx.agora());
  } catch (erro) {
    if (erro instanceof FalhaFonte) throw erro;
    throw new FalhaFonte("STF respondeu algo que não é JSON (provável bloqueio de acesso).");
  }
}

export const fonteStf: Fonte = {
  id: "stf",
  nome: "STF",
  tribunais: ["STF"],
  consultaTeste: "liberdade de expressão",
  buscar: (consulta, filtros, ctx) => pesquisar(ctx, consulta, filtros.limite, filtros.desde, filtros.ate),
  porNumero: (ref, ctx) => pesquisar(ctx, `titulo:"${ref.classe ? `${ref.classe} ` : ""}${digitos(ref.numero)}"`, 10),
};
