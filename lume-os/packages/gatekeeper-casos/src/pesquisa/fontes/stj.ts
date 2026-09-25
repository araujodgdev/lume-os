// STJ open data (dadosabertos.web.stj.jus.br, CKAN): monthly JSON "espelhos de acórdãos" per
// judging body, and the repetitive-appeal themes. Imported into Pesquisa's own index.

import { dataIso, idJulgado, limparTexto, nomeProprio, orgaoProprio } from "../julgado.js";
import type { Julgado } from "../types.js";
import { respostaOk, type ContextoFonte } from "./fonte.js";

export const STJ_CKAN = "https://dadosabertos.web.stj.jus.br/api/3/action";

/** The judging bodies whose "espelhos" the STJ publishes, one dataset each. */
export const DATASETS_ESPELHOS = [
  "espelhos-de-acordaos-corte-especial",
  "espelhos-de-acordaos-primeira-secao",
  "espelhos-de-acordaos-segunda-secao",
  "espelhos-de-acordaos-terceira-secao",
  "espelhos-de-acordaos-primeira-turma",
  "espelhos-de-acordaos-segunda-turma",
  "espelhos-de-acordaos-terceira-turma",
  "espelhos-de-acordaos-quarta-turma",
  "espelhos-de-acordaos-quinta-turma",
  "espelhos-de-acordaos-sexta-turma",
] as const;

export const DATASET_PRECEDENTES = "precedentes-qualificados";

/** One file to import. */
export type RecursoStj = { id: string; dataset: string; nome: string; url: string; tipo: "espelhos" | "temas" };

/** An "espelho de acórdão" record, as the STJ publishes it. Only the fields Pesquisa reads. */
export type EspelhoStj = {
  id: string;
  numeroProcesso: string | null;
  numeroRegistro: string | null;
  siglaClasse: string | null;
  nomeOrgaoJulgador: string | null;
  ministroRelator: string | null;
  dataPublicacao: string | null;
  ementa: string | null;
  dataDecisao: string | null;
  teseJuridica?: string | null;
};

/** The STJ's own page for a case, by its registration number. */
export function urlProcessoStj(numeroRegistro: string): string {
  return `https://processo.stj.jus.br/processo/pesquisa/?tipoPesquisa=tipoPesquisaNumeroRegistro&termo=${numeroRegistro}`;
}

export function julgadoDeEspelho(e: EspelhoStj, capturadoEm: number): Julgado | null {
  if (!e.siglaClasse || !e.numeroProcesso || !e.ementa) return null;
  const publicacao = /^\s*([A-Za-z]+)\s+DATA:\s*(\d{2}\/\d{2}\/\d{4})/.exec(e.dataPublicacao ?? "");
  const j: Julgado = {
    id: "",
    tribunal: "STJ",
    tipo: "acordao",
    classe: e.siglaClasse.trim(),
    numero: e.numeroProcesso.trim(),
    ementa: desfazerQuebras(e.ementa),
    url: e.numeroRegistro ? urlProcessoStj(e.numeroRegistro) : "https://scon.stj.jus.br/SCON/",
    fonte: "STJ (dados abertos)",
    capturadoEm,
  };
  if (e.nomeOrgaoJulgador) j.orgaoJulgador = orgaoProprio(e.nomeOrgaoJulgador.trim());
  if (e.ministroRelator) j.relator = nomeProprio(e.ministroRelator.trim());
  const julgamento = dataIso(e.dataDecisao);
  if (julgamento) j.dataJulgamento = julgamento;
  if (publicacao) {
    j.veiculoPublicacao = publicacao[1];
    j.dataPublicacao = dataIso(publicacao[2]);
  }
  if (e.teseJuridica) j.tese = limparTexto(e.teseJuridica);
  j.id = idJulgado(j);
  return j;
}

/**
 * The STJ's headnotes are hard-wrapped at a fixed width. Lines are joined back into sentences;
 * breaks before a numbered paragraph ("2. …") are kept.
 */
export function desfazerQuebras(ementa: string): string {
  return limparTexto(ementa).replace(/\n(?!\d+\s*[.)-]\s)/g, " ").replace(/ {2,}/g, " ");
}

/** The STJ's page for a repetitive-appeal theme. */
export function urlTemaStj(numero: string): string {
  return `https://processo.stj.jus.br/repetitivos/temas_repetitivos/pesquisa.jsp?novaConsulta=true&tipo_pesquisa=T&cod_tema_inicial=${numero}&cod_tema_final=${numero}`;
}

/** A theme row of temas.csv, when it is a numbered repetitive-appeal theme. */
export function julgadoDeTema(linha: Record<string, string>, capturadoEm: number): Julgado | null {
  if (linha.tipoPrecedente !== "Tema" || !/^\d+$/.test(linha.numeroPrecedente ?? "")) return null;
  const questao = limparTexto(linha.questaoSubmetidaAJulgamento ?? "");
  const tese = limparTexto(linha.teseFirmada ?? "");
  const j: Julgado = {
    id: "",
    tribunal: "STJ",
    tipo: "tema",
    classe: "Tema",
    numero: linha.numeroPrecedente,
    ementa: [questao && `Questão: ${questao}`, tese && `Tese firmada: ${tese}`].filter(Boolean).join("\n\n") || "(sem descrição)",
    url: urlTemaStj(linha.numeroPrecedente),
    fonte: "STJ (dados abertos)",
    capturadoEm,
  };
  if (tese) j.tese = tese;
  if (linha.situacao) j.situacao = linha.situacao.trim();
  if (linha.orgaoJulgador) j.orgaoJulgador = linha.orgaoJulgador.trim();
  const julgamento = dataIso(linha.dataJulgamento);
  if (julgamento) j.dataJulgamento = julgamento;
  j.id = idJulgado(j);
  return j;
}

/** RFC 4180 CSV into records keyed by the header row. */
export function lerCsv(texto: string): Record<string, string>[] {
  const linhas: string[][] = [];
  let campo = "";
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') {
        campo += '"';
        i++;
      } else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ",") {
      linha.push(campo);
      campo = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && texto[i + 1] === "\n") i++;
      linha.push(campo);
      linhas.push(linha);
      linha = [];
      campo = "";
    } else campo += c;
  }
  if (campo || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  const [cabecalho, ...corpo] = linhas.filter((l) => l.length > 1 || l[0] !== "");
  if (!cabecalho) return [];
  const nomes = cabecalho.map((h) => h.replace(/^﻿/, "").trim());
  return corpo.map((l) => Object.fromEntries(nomes.map((h, i) => [h, l[i] ?? ""])));
}

/** Every file the STJ currently publishes for Pesquisa's index, in import order. */
export async function listarRecursos(ctx: ContextoFonte): Promise<RecursoStj[]> {
  const recursos: RecursoStj[] = [];
  for (const dataset of [...DATASETS_ESPELHOS, DATASET_PRECEDENTES]) {
    const resposta = await respostaOk(await ctx.fetch(`${STJ_CKAN}/package_show?id=${dataset}`), "STJ dados abertos");
    const corpo = (await resposta.json()) as { result?: { resources?: { id: string; name: string; url: string; format: string }[] } };
    for (const r of corpo.result?.resources ?? []) {
      if (dataset === DATASET_PRECEDENTES) {
        if (/^temas\.csv$/i.test(r.name)) recursos.push({ id: r.id, dataset, nome: r.name, url: r.url, tipo: "temas" });
      } else if (r.format?.toUpperCase() === "JSON" && /^\d{8}\.json$/.test(r.name)) {
        recursos.push({ id: r.id, dataset, nome: r.name, url: r.url, tipo: "espelhos" });
      }
    }
  }
  // Themes first (small, and what citation checks lean on), then the newest months: recent case
  // law is what lawyers look for, and the full backfill takes a while.
  return recursos.toSorted((a, b) => (a.tipo === "temas" ? -1 : b.tipo === "temas" ? 1 : b.nome.localeCompare(a.nome)));
}
