// e-SAJ "Consulta de Jurisprudência" (cjsg), used by TJSP and other state courts. The search form
// requires a reCAPTCHA v3 token, which only a real browser running the page produces, so it goes
// through Browser Rendering: open the form, type the query, submit, read the results table.

import { parseDocument } from "htmlparser2";
import { dataIso, idJulgado, limparTexto, nomeProprio } from "../julgado.js";
import type { Julgado } from "../types.js";
import { FalhaFonte, type ContextoFonte, type Fonte } from "./fonte.js";

/** e-SAJ hosts per court. */
export const HOSTS_ESAJ: Record<string, string> = {
  TJSP: "https://esaj.tjsp.jus.br",
  TJAC: "https://esaj.tjac.jus.br",
  TJAL: "https://www2.tjal.jus.br",
  TJAM: "https://consultasaj.tjam.jus.br",
  TJCE: "https://esaj.tjce.jus.br",
  TJMS: "https://esaj.tjms.jus.br",
};

type No = { type: string; name?: string; data?: string; attribs?: Record<string, string>; children?: No[] };

function textoDe(no: No): string {
  if (no.type === "text") return no.data ?? "";
  if (no.name === "br") return "\n";
  if (no.name === "script" || no.name === "style") return "";
  const interno = (no.children ?? []).map(textoDe).join("");
  return no.name === "tr" || no.name === "div" || no.name === "p" ? `${interno}\n` : interno;
}

function todos(raiz: No, teste: (no: No) => boolean): No[] {
  const achados: No[] = [];
  const visitar = (no: No) => {
    if (teste(no)) achados.push(no);
    for (const filho of no.children ?? []) visitar(filho);
  };
  visitar(raiz);
  return achados;
}

const ROTULOS = ["Classe/Assunto", "Relator(a)", "Comarca", "Órgão julgador", "Data do julgamento", "Data de publicação", "Data de registro", "Ementa", "Outros números"];

/** Reads an e-SAJ cjsg results page into decisions. */
export function lerResultadosEsaj(html: string, tribunal: string, capturadoEm: number): Julgado[] {
  const host = HOSTS_ESAJ[tribunal];
  const raiz = parseDocument(html) as unknown as No;
  const linhas = todos(raiz, (no) => no.name === "tr" && (no.attribs?.class ?? "").split(/\s+/).includes("fundocinza1"));
  const julgados: Julgado[] = [];
  for (const linha of linhas) {
    const texto = limparTexto(textoDe(linha));
    const cnj = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/.exec(texto)?.[0];
    const campos = new Map<string, string>();
    const padrao = new RegExp(`(${ROTULOS.map((r) => r.replace(/[()/]/g, "\\$&")).join("|")}):\\s*`, "g");
    const partes = texto.split(padrao);
    for (let i = 1; i < partes.length - 1; i += 2) campos.set(partes[i], partes[i + 1].trim());
    const ementa = campos.get("Ementa");
    if (!cnj || !ementa) continue;
    const link = todos(linha, (no) => no.name === "a" && Boolean(no.attribs?.cdacordao))[0];
    const [classe] = (campos.get("Classe/Assunto") ?? "Acórdão").split("/");
    const j: Julgado = {
      id: "",
      tribunal,
      tipo: "acordao",
      classe: classe.trim(),
      numero: cnj,
      ementa: ementa.replace(/\s*Ementa:\s*/g, " ").trim(),
      url: link ? `${host}/cjsg/getArquivo.do?cdAcordao=${link.attribs!.cdacordao}&cdForo=${link.attribs!.cdforo ?? "0"}` : `${host}/cjsg/consultaCompleta.do`,
      fonte: `${tribunal} (e-SAJ)`,
      capturadoEm,
    };
    const relator = campos.get("Relator(a)");
    if (relator) j.relator = nomeProprio(relator);
    const orgao = campos.get("Órgão julgador");
    if (orgao) j.orgaoJulgador = orgao;
    const julgamento = dataIso(campos.get("Data do julgamento"));
    if (julgamento) j.dataJulgamento = julgamento;
    const publicacao = dataIso(campos.get("Data de publicação") ?? campos.get("Data de registro"));
    if (publicacao) {
      j.dataPublicacao = publicacao;
      j.veiculoPublicacao = "DJe";
    }
    j.id = idJulgado(j);
    julgados.push(j);
  }
  return julgados;
}

async function pesquisar(ctx: ContextoFonte, tribunal: string, consulta: string, limite: number, desde?: string, ate?: string): Promise<Julgado[]> {
  const host = HOSTS_ESAJ[tribunal];
  if (!host) throw new FalhaFonte(`Sem e-SAJ configurado para ${tribunal}.`);
  if (!ctx.navegador) throw new FalhaFonte(`${tribunal} exige navegador (reCAPTCHA), indisponível aqui.`);
  const br = (d: string) => d.split("-").toReversed().join("/");
  const html = await ctx.navegador(async (p) => {
    await p.goto(`${host}/cjsg/consultaCompleta.do`, { waitUntil: "networkidle2", timeout: 30_000 });
    await p.type("[name='dados.buscaInteiroTeor']", consulta);
    if (desde) await p.type("[name='dados.dtJulgamentoInicio']", br(desde));
    if (ate) await p.type("[name='dados.dtJulgamentoFim']", br(ate));
    await p.click("#pbSubmit");
    await p.waitForSelector("#divDadosResultado-A, #mensagemRetorno, .fundocinza1", { timeout: 30_000 });
    return p.content();
  });
  if (/Não foi encontrado nenhum resultado/i.test(html)) return [];
  const julgados = lerResultadosEsaj(html, tribunal, ctx.agora());
  if (julgados.length === 0 && /recaptcha|captcha/i.test(html) && !html.includes("fundocinza1")) {
    throw new FalhaFonte(`${tribunal} recusou a busca (verificação anti-robô).`);
  }
  return julgados.slice(0, limite);
}

export const fonteEsaj: Fonte = {
  id: "esaj",
  nome: "e-SAJ (TJs)",
  tribunais: Object.keys(HOSTS_ESAJ),
  consultaTeste: "dano moral",
  buscar: (consulta, filtros, ctx) => pesquisar(ctx, filtros.tribunal, consulta, filtros.limite, filtros.desde, filtros.ate),
  porNumero: (ref, ctx) => pesquisar(ctx, ref.tribunal, `"${ref.numero}"`, 10),
};
