// STJ SCON (scon.stj.jus.br): the live search, for judgments newer than the open-data files. The
// results page is HTML with "docTitulo"/"docTexto" pairs per document. It blocks plain requests
// from some networks, so a blocked request is repeated in a browser.

import { parseDocument } from "htmlparser2";
import { dataIso, digitos, idJulgado, limparTexto, nomeProprio, orgaoProprio } from "../julgado.js";
import type { Julgado } from "../types.js";
import { FalhaFonte, type ContextoFonte, type Fonte } from "./fonte.js";

const BASE = "https://scon.stj.jus.br/SCON/pesquisar.jsp";

type No = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: No[] };

function textoDe(no: No): string {
  if (no.type === "text") return no.data ?? "";
  if (no.name === "br") return "\n";
  const interno = (no.children ?? []).map(textoDe).join("");
  return no.name === "p" || no.name === "div" ? `${interno}\n` : interno;
}

function comClasse(raiz: No, classe: string): No[] {
  const achados: No[] = [];
  const visitar = (no: No) => {
    if (no.attribs?.class?.split(/\s+/).includes(classe)) achados.push(no);
    for (const filho of no.children ?? []) visitar(filho);
  };
  visitar(raiz);
  return achados;
}

/** Reads a SCON results page into decisions. */
export function lerResultadosScon(html: string, capturadoEm: number): Julgado[] {
  const raiz = parseDocument(html) as unknown as No;
  const julgados: Julgado[] = [];
  for (const doc of comClasse(raiz, "documento")) {
    // Titles and texts in document order: each title labels the text that follows it.
    const campos = new Map<string, string>();
    let rotulo: string | undefined;
    for (const no of rotulados(doc)) {
      if (no.classe === "docTitulo") rotulo = limparTexto(textoDe(no.no)).replace(/:$/, "");
      else if (rotulo && !campos.has(rotulo)) {
        campos.set(rotulo, limparTexto(textoDe(no.no)));
        rotulo = undefined;
      }
    }
    const processo = campos.get("Processo") ?? "";
    const m = /^(.+?)\s+(\d[\d.]*)\s*\/\s*([A-Z]{2})/.exec(processo);
    const ementa = campos.get("Ementa");
    if (!m || !ementa) continue;
    const registro = /(\d{4})\/(\d{7})-(\d)/.exec(processo);
    const j: Julgado = {
      id: "",
      tribunal: "STJ",
      tipo: "acordao",
      classe: m[1].trim(),
      numero: digitos(m[2]),
      uf: m[3],
      ementa,
      url: registro
        ? `https://processo.stj.jus.br/processo/pesquisa/?tipoPesquisa=tipoPesquisaNumeroRegistro&termo=${registro[1]}${registro[2]}${registro[3]}`
        : `${BASE}?b=ACOR&livre=${encodeURIComponent(`${m[1]} ${digitos(m[2])}`)}`,
      fonte: "STJ (SCON)",
      capturadoEm,
    };
    const relator = campos.get("Relator") ?? campos.get("Relator(a)") ?? campos.get("Relatora");
    if (relator) j.relator = nomeProprio(relator.replace(/^Ministr[oa]\s+/i, "").replace(/\s*\(\d+\)\s*$/, ""));
    const orgao = campos.get("Órgão Julgador");
    if (orgao) j.orgaoJulgador = orgaoProprio(orgao.replace(/^T\d\s*-\s*/, ""));
    const julgamento = dataIso(campos.get("Data do Julgamento"));
    if (julgamento) j.dataJulgamento = julgamento;
    const publicacao = /([A-Za-z]+)\s+(\d{2}\/\d{2}\/\d{4})/.exec(campos.get("Data da Publicação/Fonte") ?? "");
    if (publicacao) {
      j.veiculoPublicacao = publicacao[1];
      j.dataPublicacao = dataIso(publicacao[2]);
    }
    j.id = idJulgado(j);
    julgados.push(j);
  }
  return julgados;
}

/** The "docTitulo" and "docTexto" elements under `raiz`, in document order. */
function rotulados(raiz: No): { classe: "docTitulo" | "docTexto"; no: No }[] {
  const lista: { classe: "docTitulo" | "docTexto"; no: No }[] = [];
  const visitar = (no: No) => {
    const classes = no.attribs?.class?.split(/\s+/) ?? [];
    if (classes.includes("docTitulo")) lista.push({ classe: "docTitulo", no });
    else if (classes.includes("docTexto")) lista.push({ classe: "docTexto", no });
    else for (const filho of no.children ?? []) visitar(filho);
  };
  visitar(raiz);
  return lista;
}

async function pagina(ctx: ContextoFonte, url: string): Promise<string> {
  let html = "";
  let status = 0;
  try {
    const resposta = await ctx.fetch(url, { headers: { Accept: "text/html" } });
    status = resposta.status;
    html = await resposta.text();
  } catch {
    status = 0;
  }
  if (status === 200 && html.includes("documento")) return html;
  if (!ctx.navegador) throw new FalhaFonte(`STJ (SCON) respondeu ${status || "sem conexão"}.`);
  return ctx.navegador(async (p) => {
    await p.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    return p.content();
  });
}

function url(livre: string, limite: number, desde?: string, ate?: string): string {
  const params = new URLSearchParams({ b: "ACOR", livre, tp: "T", i: "1", l: String(limite), ordenacao: "MAT" });
  const br = (d: string) => d.split("-").toReversed().join("/");
  if (desde || ate) params.set("data", `@DTDE >= "${desde ? br(desde) : "01/01/1990"}" e @DTDE <= "${ate ? br(ate) : "31/12/2999"}"`);
  return `${BASE}?${params}`;
}

export const fonteScon: Fonte = {
  id: "stj-scon",
  nome: "STJ (SCON)",
  tribunais: ["STJ"],
  consultaTeste: "dano moral",
  async buscar(consulta, filtros, ctx) {
    return lerResultadosScon(await pagina(ctx, url(consulta, filtros.limite, filtros.desde, filtros.ate)), ctx.agora());
  },
  async porNumero(ref, ctx) {
    const livre = `${ref.classe ? `${ref.classe} ` : ""}${digitos(ref.numero)}`;
    return lerResultadosScon(await pagina(ctx, url(livre, 10)), ctx.agora());
  },
};
