import { describe, expect, it } from "vitest";
import {
  applyAlteracoes,
  matchesFiltro,
  previousValues,
  validateAlteracoes,
  validateNovoCaso,
} from "../src/caso.js";
import { simulate } from "../src/casos.js";
import type { Caso } from "../src/types.js";

const base = {
  titulo: " Silva x Banco Alfa ",
  cliente: { nome: "João da Silva", documento: "123.456.789-09" },
  poloCliente: "ativo" as const,
  area: "consumidor" as const,
};

function caso(overrides: Partial<Caso> = {}): Caso {
  return {
    ...validateNovoCaso(base),
    id: "c1",
    criadoEm: 1,
    atualizadoEm: 1,
    ...overrides,
  };
}

describe("validateNovoCaso", () => {
  it("trims text, keeps document digits and fills defaults", () => {
    expect(validateNovoCaso({ ...base, numeroCnj: "07108025520188020001" })).toEqual({
      titulo: "Silva x Banco Alfa",
      cliente: { nome: "João da Silva", documento: "12345678909" },
      poloCliente: "ativo",
      parteContraria: [],
      area: "consumidor",
      status: "ativo",
      responsaveis: [],
      resumo: "",
      numeroCnj: "0710802-55.2018.8.02.0001",
    });
  });

  it("names the field that fails", () => {
    expect(() => validateNovoCaso({ ...base, titulo: "  " })).toThrow(/titulo/);
    expect(() => validateNovoCaso({ ...base, area: "espacial" as never })).toThrow(/area/);
    expect(() => validateNovoCaso({ ...base, cliente: { nome: "X", documento: "123" } }))
      .toThrow(/CPF/);
  });
});

describe("validateAlteracoes", () => {
  it("turns an emptied optional field into a clear marker", () => {
    expect(validateAlteracoes({ tribunal: "", status: "suspenso" }))
      .toEqual({ tribunal: null, status: "suspenso" });
  });

  it("rejects an empty change set", () => {
    expect(() => validateAlteracoes({})).toThrow(/Nenhuma alteração/);
  });

  it("applies and reverts through previousValues", () => {
    const original = caso({ tribunal: "TJSP" });
    const alteracoes = validateAlteracoes({ tribunal: "", resumo: "Novo resumo" });
    const changed = applyAlteracoes(original, alteracoes, 5);
    expect(changed.tribunal).toBeUndefined();
    expect(changed.resumo).toBe("Novo resumo");
    const restored = applyAlteracoes(changed, previousValues(original, alteracoes), 6);
    expect(restored).toEqual({ ...original, atualizadoEm: 6 });
  });
});

describe("matchesFiltro", () => {
  it("finds cases ignoring accents and punctuation of the CNJ number", () => {
    const c = caso({ numeroCnj: "0710802-55.2018.8.02.0001", parteContraria: ["Banco Alfa S.A."] });
    expect(matchesFiltro(c, { busca: "joao" })).toBe(true);
    expect(matchesFiltro(c, { busca: "alfa" })).toBe(true);
    expect(matchesFiltro(c, { busca: "07108025520" })).toBe(true);
    expect(matchesFiltro(c, { busca: "beta" })).toBe(false);
    expect(matchesFiltro(c, { status: "encerrado" })).toBe(false);
  });
});

describe("simulate", () => {
  it("lays pending creates and updates over stored cases, newest first", () => {
    const stored = [caso()];
    const view = simulate(stored, [
      { id: 1, kind: "create", casoId: "c2", dados: validateNovoCaso({ ...base, titulo: "Novo" }), submittedAt: 10 },
      { id: 2, kind: "update", casoId: "c1", alteracoes: { status: "suspenso" }, submittedAt: 20 },
      { id: 3, kind: "update", casoId: "sumiu", alteracoes: { status: "encerrado" }, submittedAt: 30 },
    ]);
    expect(view.map((c) => [c.id, c.status, c.atualizadoEm])).toEqual([
      ["c1", "suspenso", 20],
      ["c2", "ativo", 10],
    ]);
  });
});
