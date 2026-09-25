import { describe, expect, it } from "vitest";
import { extrairCitacoes } from "../src/pesquisa/citacoes.js";
import { citacao, idJulgado, tribunalDoCnj } from "../src/pesquisa/julgado.js";

describe("extrairCitacoes", () => {
  it("encontra acórdãos dos tribunais superiores com relator e data citados", () => {
    const texto =
      "Nesse sentido: STJ, REsp 1.990.285/SP, Rel. Min. Moura Ribeiro, Terceira Turma, j. 27/10/2025, DJEN 30/10/2025. " +
      "Também o AgInt no AREsp nº 2.345.678/RJ (STJ) e o RE 1.234.567 do STF.";
    expect(extrairCitacoes(texto)).toEqual([
      {
        trecho: "REsp 1.990.285/SP", tipo: "acordao", classe: "REsp", numero: "1990285", tribunal: "STJ", uf: "SP",
        relatorCitado: "Moura Ribeiro", dataCitada: "27/10/2025",
      },
      { trecho: "AgInt no AREsp nº 2.345.678/RJ", tipo: "acordao", classe: "AgInt no AREsp", numero: "2345678", tribunal: "STJ", uf: "RJ" },
      { trecho: "RE 1.234.567", tipo: "acordao", classe: "RE", numero: "1234567", tribunal: "STF" },
    ]);
  });

  it("encontra números CNJ de TJs e do TST, com e sem classe", () => {
    const citacoes = extrairCitacoes(
      "(TJSP, Apelação Cível 1001234-56.2023.8.26.0100, Rel. Des. Maria de Souza, j. 10/03/2025) e " +
      "(TST, AIRR-699-77.2011.5.04.0451). Ver ainda 0012345-67.2020.8.19.0001.",
    );
    expect(citacoes).toEqual([
      {
        trecho: "Apelação Cível 1001234-56.2023.8.26.0100", tipo: "acordao", classe: "Apelação Cível",
        numero: "1001234-56.2023.8.26.0100", tribunal: "TJSP", relatorCitado: "Maria de Souza", dataCitada: "10/03/2025",
      },
      { trecho: "AIRR-699-77.2011.5.04.0451", tipo: "acordao", classe: "AIRR", numero: "699-77.2011.5.04.0451", tribunal: "TST" },
      { trecho: "0012345-67.2020.8.19.0001", tipo: "acordao", numero: "0012345-67.2020.8.19.0001", tribunal: "TJRJ" },
    ]);
  });

  it("encontra súmulas e temas", () => {
    expect(extrairCitacoes("Incidem a Súmula 7/STJ, a Súmula Vinculante nº 13, a Súmula 331 do TST e o Tema 1.234 do STJ, além do Tema de Repercussão Geral 69."))
      .toEqual([
        { trecho: "Súmula 7/STJ", tipo: "sumula", numero: "7", tribunal: "STJ" },
        { trecho: "Súmula Vinculante nº 13", tipo: "sumula", numero: "13", tribunal: "STF", vinculante: true },
        { trecho: "Súmula 331 do TST", tipo: "sumula", numero: "331", tribunal: "TST" },
        { trecho: "Tema 1.234 do STJ", tipo: "tema", numero: "1234", tribunal: "STJ" },
        { trecho: "Tema de Repercussão Geral 69", tipo: "tema", numero: "69", tribunal: "STF" },
      ]);
  });

  it("lê números de tema longos sem cortar", () => {
    expect(extrairCitacoes("Tema 99999 do STJ")).toEqual([{ trecho: "Tema 99999 do STJ", tipo: "tema", numero: "99999", tribunal: "STJ" }]);
  });

  it("ignora leis, artigos e siglas de estado soltas", () => {
    expect(extrairCitacoes(
      "Nos termos do art. 186 do CC e da Lei nº 8.078/90, com sede em Campo Grande/MS, conforme o RE 5 e a MS nesta capital.",
    )).toEqual([]);
  });

  it("lê citações em HTML e não repete a mesma decisão", () => {
    expect(extrairCitacoes("<p>Ver <strong>REsp 1.990.285</strong>.</p><p>De novo, REsp 1990285.</p>")).toHaveLength(1);
  });
});

describe("julgado", () => {
  it("formata a citação canônica", () => {
    const j = {
      id: "", tribunal: "STJ", tipo: "acordao" as const, classe: "REsp", numero: "1990285", relator: "Moura Ribeiro",
      orgaoJulgador: "Terceira Turma", dataJulgamento: "2025-10-27", dataPublicacao: "2025-10-30", veiculoPublicacao: "DJEN",
      ementa: "", url: "", fonte: "", capturadoEm: 0,
    };
    expect(citacao(j)).toBe("STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro, Terceira Turma, j. 27/10/2025, DJEN 30/10/2025");
    expect(idJulgado(j)).toBe("STJ:RESP:1990285:2025-10-27");
    expect(citacao({ ...j, tipo: "tema", numero: "1234", tese: "A tese.", situacao: "Trânsito em Julgado" }))
      .toBe('STJ, Tema Repetitivo 1.234, situação: Trânsito em Julgado. Tese firmada: "A tese."');
  });

  it("deduz o tribunal do número CNJ", () => {
    expect(tribunalDoCnj("1001234-56.2023.8.26.0100")).toBe("TJSP");
    expect(tribunalDoCnj("0000699-77.2011.5.00.0451")).toBe("TST");
    expect(tribunalDoCnj("0000699-77.2011.5.04.0451")).toBe("TRT4");
    expect(tribunalDoCnj("0001234-12.2020.8.07.0001")).toBe("TJDFT");
  });
});
