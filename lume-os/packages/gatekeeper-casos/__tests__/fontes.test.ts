import { describe, expect, it } from "vitest";
import { lerResultadosEsaj } from "../src/pesquisa/fontes/esaj.js";
import { lerRespostaStf } from "../src/pesquisa/fontes/stf.js";
import { desfazerQuebras, julgadoDeEspelho, julgadoDeTema, lerCsv, type EspelhoStj } from "../src/pesquisa/fontes/stj.js";
import { lerResultadosScon } from "../src/pesquisa/fontes/stj-scon.js";
import { julgadoDoTst, numeracaoUnica, type RespostaTst } from "../src/pesquisa/fontes/tst.js";
import { citacao } from "../src/pesquisa/julgado.js";
import espelhos from "./fixtures/stj-espelhos.json";
import temasCsv from "./fixtures/stj-temas.csv?raw";
import tst from "./fixtures/tst-pesquisa.json";
import stf from "./fixtures/stf-resposta.sintetico.json";
import scon from "./fixtures/scon-resultados.sintetico.html?raw";
import esaj from "./fixtures/esaj-resultados.sintetico.html?raw";

describe("STJ dados abertos", () => {
  it("lê os espelhos de acórdãos publicados", () => {
    const julgados = (espelhos as EspelhoStj[]).map((e) => julgadoDeEspelho(e, 1)).filter(Boolean);
    expect(julgados).toHaveLength(25);
    expect(julgados[0]).toMatchObject({
      id: "STJ:RESP:1990285:2025-10-27",
      tribunal: "STJ",
      classe: "REsp",
      numero: "1990285",
      relator: "Moura Ribeiro",
      orgaoJulgador: "Terceira Turma",
      dataJulgamento: "2025-10-27",
      dataPublicacao: "2025-10-30",
      veiculoPublicacao: "DJEN",
      url: "https://processo.stj.jus.br/processo/pesquisa/?tipoPesquisa=tipoPesquisaNumeroRegistro&termo=202200686198",
    });
    expect(julgados[0]!.ementa).toMatch(/^DIREITO CIVIL E PROCESSO CIVIL\. RECURSO ESPECIAL\./);
    // Hard wraps joined; numbered paragraphs still start on their own line.
    expect(desfazerQuebras("A inscrição\nindevida gera dano.\n1. Primeiro\nponto.\n2. Segundo.")).toBe("A inscrição indevida gera dano.\n1. Primeiro ponto.\n2. Segundo.");
    expect(citacao(julgados[0]!)).toBe("STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro, Terceira Turma, j. 27/10/2025, DJEN 30/10/2025");
  });

  it("lê os temas repetitivos do CSV", () => {
    const linhas = lerCsv(temasCsv);
    expect(linhas).toHaveLength(25);
    const temas = linhas.map((l) => julgadoDeTema(l, 1)).filter(Boolean);
    expect(temas).toHaveLength(20);
    expect(temas[0]).toMatchObject({ tribunal: "STJ", tipo: "tema", classe: "Tema", id: expect.stringMatching(/^STJ:TEMA:\d+:/) });
    expect(temas[0]!.url).toContain(`cod_tema_inicial=${temas[0]!.numero}`);
  });
});

describe("TST", () => {
  it("lê a resposta da API de pesquisa", () => {
    const julgados = (tst as unknown as RespostaTst).registros.map((r) => julgadoDoTst(r.registro, 1));
    expect(julgados).toHaveLength(3);
    expect(julgados[0]).toMatchObject({ tribunal: "TST", classe: "RRAg", numero: "872-37.2020.5.09.0002", veiculoPublicacao: "DEJT" });
    expect(julgados[0]!.url).toContain("numeroTst=0000872&digitoTst=37&anoTst=2020");
    expect(julgados[0]!.ementa.length).toBeGreaterThan(50);
  });

  it("separa o número CNJ nos campos da API", () => {
    expect(numeracaoUnica("699-77.2011.5.04.0451")).toEqual({ numero: 699, digito: 77, ano: 2011, orgao: 5, tribunal: 4, vara: 451 });
    expect(numeracaoUnica("00006997720115040451")).toEqual({ numero: 699, digito: 77, ano: 2011, orgao: 5, tribunal: 4, vara: 451 });
    expect(numeracaoUnica("123")).toBeUndefined();
  });
});

describe("STF, SCON e e-SAJ (formatos reconstruídos)", () => {
  it("lê a resposta da API do STF", () => {
    expect(lerRespostaStf(stf, 1)).toEqual([expect.objectContaining({
      tribunal: "STF", classe: "RE", numero: "1234567", uf: "SP", relator: "Fulano de Tal", dataJulgamento: "2024-05-10",
      url: "https://jurisprudencia.stf.jus.br/pages/search/sjur123456/false",
    })]);
    expect(() => lerRespostaStf({ erro: "bloqueado" }, 1)).toThrow("formato inesperado");
  });

  it("lê a página de resultados do SCON", () => {
    expect(lerResultadosScon(scon, 1)).toEqual([expect.objectContaining({
      tribunal: "STJ", classe: "REsp", numero: "2172032", uf: "SP", relator: "Moura Ribeiro", orgaoJulgador: "Terceira Turma",
      dataJulgamento: "2026-03-10", dataPublicacao: "2026-03-13", veiculoPublicacao: "DJEN",
      url: "https://processo.stj.jus.br/processo/pesquisa/?tipoPesquisa=tipoPesquisaNumeroRegistro&termo=202400111849",
    })]);
  });

  it("lê a página de resultados do e-SAJ", () => {
    const [j] = lerResultadosEsaj(esaj, "TJSP", 1);
    expect(j).toMatchObject({
      tribunal: "TJSP", classe: "Apelação Cível", numero: "1001234-56.2023.8.26.0100", relator: "Maria de Souza",
      orgaoJulgador: "10ª Câmara de Direito Privado", dataJulgamento: "2025-03-10",
      url: "https://esaj.tjsp.jus.br/cjsg/getArquivo.do?cdAcordao=19876543&cdForo=0",
    });
    expect(j.ementa).toBe("APELAÇÃO. NEGATIVAÇÃO INDEVIDA. Dano moral configurado. Recurso provido.");
    expect(citacao(j)).toBe(
      "TJSP, Apelação Cível 1001234-56.2023.8.26.0100, Rel. Des. Maria de Souza, 10ª Câmara de Direito Privado, j. 10/03/2025, DJe 11/03/2025",
    );
  });
});
