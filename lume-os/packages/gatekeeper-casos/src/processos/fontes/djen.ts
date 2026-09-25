// DJEN (Diário de Justiça Eletrônico Nacional) through the CNJ's Comunica API: publications for an
// OAB number, from every court. Public, no credentials; it refuses requests from abroad. Read
// defensively: the API has no published contract, and the admin diagnostic shows when it changes.

import { dataIso } from "../../pesquisa/julgado.js";
import { formatarCnj } from "./mni.js";

const API = "https://comunicaapi.pje.jus.br/api/v1/comunicacao";

export type PublicacaoDjen = {
  id: string;
  processo: string;
  tribunal: string;
  /** "AAAA-MM-DD". */
  dataDisponibilizacao: string;
  tipo?: string;
  orgao?: string;
  texto: string;
  link?: string;
};

export class FalhaDjen extends Error {}

type Item = Record<string, unknown>;

function campo(item: Item, ...nomes: string[]): string | undefined {
  for (const nome of nomes) {
    const v = item[nome];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

/** Strips the HTML some publications carry. */
function textoPlano(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

export function lerPublicacoes(corpo: unknown): PublicacaoDjen[] {
  const c = corpo as { items?: Item[]; data?: Item[]; content?: Item[] };
  const itens = c.items ?? c.data ?? c.content;
  if (!Array.isArray(itens)) throw new FalhaDjen("O DJEN respondeu num formato inesperado.");
  return itens.map((item) => {
    const numero = campo(item, "numeroprocessocommascara", "numero_processo", "numeroProcesso") ?? "";
    const data = dataIso(campo(item, "data_disponibilizacao", "dataDisponibilizacao", "datadisponibilizacao"));
    const pub: PublicacaoDjen = {
      id: campo(item, "id", "hash") ?? "",
      processo: formatarCnj(numero),
      tribunal: campo(item, "siglaTribunal", "sigla_tribunal", "tribunal") ?? "",
      dataDisponibilizacao: data ?? "",
      texto: textoPlano(campo(item, "texto", "conteudo") ?? ""),
    };
    const tipo = campo(item, "tipoComunicacao", "tipo_comunicacao", "tipoDocumento");
    if (tipo) pub.tipo = tipo;
    const orgao = campo(item, "nomeOrgao", "nome_orgao", "orgao");
    if (orgao) pub.orgao = orgao;
    const link = campo(item, "link", "url");
    if (link?.startsWith("https://")) pub.link = link;
    return pub;
  }).filter((p) => p.id && p.processo && p.dataDisponibilizacao);
}

/** Publications for an OAB number in a date range, all pages up to `maxPaginas`. */
export async function buscarPorOab(
  fetcher: typeof fetch,
  oab: { numero: string; uf: string },
  de: string,
  ate: string,
  maxPaginas = 5,
): Promise<PublicacaoDjen[]> {
  const todas: PublicacaoDjen[] = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const params = new URLSearchParams({
      numeroOab: oab.numero.replace(/\D/g, ""),
      ufOab: oab.uf.toUpperCase(),
      dataDisponibilizacaoInicio: de,
      dataDisponibilizacaoFim: ate,
      pagina: String(pagina),
      itensPorPagina: "100",
    });
    let resposta: Response;
    try {
      resposta = await fetcher(`${API}?${params}`, { headers: { Accept: "application/json" } });
    } catch (erro) {
      throw new FalhaDjen(`Sem conexão com o DJEN: ${(erro as Error).message}`);
    }
    if (resposta.status === 403) throw new FalhaDjen("O DJEN bloqueou o acesso (403; ele só atende a partir do Brasil).");
    if (!resposta.ok) throw new FalhaDjen(`O DJEN respondeu ${resposta.status}.`);
    const lote = lerPublicacoes(await resposta.json());
    todas.push(...lote);
    if (lote.length < 100) break;
  }
  return todas;
}
