import { describe, expect, it } from "vitest";
import {
  Calendario,
  diasSemExpediente,
  ehData,
  feriadosNacionais,
  hojeEmBrasilia,
  pascoa,
  type Feriado,
} from "../src/agenda/calendario.js";
import { calcularPrazo, validarRegra, type RegraPrazo } from "../src/agenda/prazos.js";

const nacional = new Calendario([]);

function vence(regra: RegraPrazo, calendario = nacional): string {
  return calcularPrazo(regra, calendario).vencimento;
}

describe("calendário", () => {
  it("calcula a Páscoa", () => {
    expect([2024, 2025, 2026, 2027, 2028, 2029, 2030].map(pascoa)).toEqual([
      "2024-03-31", "2025-04-20", "2026-04-05", "2027-03-28", "2028-04-16", "2029-04-01", "2030-04-21",
    ]);
  });

  it("inclui os feriados móveis e a Consciência Negra a partir de 2024", () => {
    const datas = feriadosNacionais(2026).map((f) => f.data);
    expect(datas).toEqual(expect.arrayContaining(["2026-02-16", "2026-02-17", "2026-04-03", "2026-06-04", "2026-11-20"]));
    expect(feriadosNacionais(2023).map((f) => f.data)).not.toContain("2023-11-20");
  });

  it("aplica feriados do escritório só no tribunal e na comarca certos", () => {
    const feriados: Feriado[] = [
      { id: "1", data: "2026-03-09", descricao: "Aniversário de Campinas", tribunal: "TJSP", comarca: "Campinas" },
      { id: "2", data: "2026-03-10", ate: "2026-03-11", descricao: "Indisponibilidade do sistema", tribunal: "tjsp" },
    ];
    expect(new Calendario(feriados, { tribunal: "TJSP", comarca: "campinas" }).ehDiaUtil("2026-03-09")).toBe(false);
    expect(new Calendario(feriados, { tribunal: "TJSP", comarca: "Santos" }).ehDiaUtil("2026-03-09")).toBe(true);
    expect(new Calendario(feriados, { tribunal: "TJSP" }).ehDiaUtil("2026-03-11")).toBe(false);
    expect(new Calendario(feriados, { tribunal: "TJRJ" }).ehDiaUtil("2026-03-11")).toBe(true);
    // Without a comarca, a comarca-only holiday does not apply: the deadline stays earlier.
    expect(new Calendario(feriados, { tribunal: "TJSP" }).ehDiaUtil("2026-03-09")).toBe(true);
  });

  it("lista os dias sem expediente de um período", () => {
    const dias = diasSemExpediente(
      [{ id: "1", data: "2026-02-18", descricao: "Cinzas", tribunal: "TJSP" }],
      "2026-02-01",
      "2026-02-28",
      { tribunal: "TJSP" },
    );
    expect(dias.map((d) => [d.data, d.origem])).toEqual([
      ["2026-02-16", "nacional"],
      ["2026-02-17", "nacional"],
      ["2026-02-18", "escritorio"],
    ]);
  });

  it("valida datas e calcula hoje em Brasília", () => {
    expect(ehData("2026-02-29")).toBe(false);
    expect(ehData("2028-02-29")).toBe(true);
    expect(hojeEmBrasilia(new Date("2026-03-10T02:00:00Z"))).toBe("2026-03-09");
  });
});

describe("prazos", () => {
  it("conta dias úteis a partir da publicação no DJe, pulando o Carnaval", () => {
    const r = calcularPrazo({ forma: "dje", data: "2026-02-12", dias: 15, rito: "cpc" }, nacional);
    expect(r.intimacao).toBe("2026-02-13");
    expect(r.inicioContagem).toBe("2026-02-18");
    expect(r.vencimento).toBe("2026-03-10");
    expect(r.memoria.join("\n")).toContain("16/02/2026 (Carnaval (segunda-feira))");
  });

  it("suspende no recesso de 20/12 a 20/01", () => {
    const r = calcularPrazo({ forma: "outra", data: "2026-12-10", dias: 15, rito: "cpc" }, nacional);
    expect(r.vencimento).toBe("2027-02-02");
    expect(r.memoria.join("\n")).toContain("CPC, art. 220");
    expect(vence({ forma: "outra", data: "2026-12-10", dias: 15, rito: "clt" })).toBe("2027-02-02");
  });

  it("conta em dobro", () => {
    const r = calcularPrazo({ forma: "outra", data: "2026-03-02", dias: 15, rito: "cpc", dobro: true }, nacional);
    expect(r.dias).toBe(30);
    // 30 working days from 03/03/2026, skipping Good Friday (03/04).
    expect(r.vencimento).toBe("2026-04-14");
  });

  it("aplica a ciência tácita do portal", () => {
    expect(vence({ forma: "portal_tacita", data: "2026-03-02", dias: 5, rito: "cpc" })).toBe("2026-03-19");
    const r = calcularPrazo({ forma: "portal_tacita", data: "2026-03-04", dias: 5, rito: "cpc" }, nacional);
    expect(r.intimacao).toBe("2026-03-16");
    expect(r.memoria[0]).toContain("sábado");
  });

  it("leva a consulta em dia sem expediente para o dia útil seguinte", () => {
    const r = calcularPrazo({ forma: "portal", data: "2026-03-07", dias: 5, rito: "cpc" }, nacional);
    expect(r.intimacao).toBe("2026-03-09");
    expect(r.vencimento).toBe("2026-03-16");
  });

  it("conta o prazo penal em dias corridos", () => {
    // Notice on Friday: counting starts on Monday (STF Súmula 310).
    expect(vence({ forma: "outra", data: "2026-03-06", dias: 5, rito: "cpp" })).toBe("2026-03-13");
    // Ends on Sunday: moves to Monday.
    const r = calcularPrazo({ forma: "outra", data: "2026-03-03", dias: 5, rito: "cpp" }, nacional);
    expect(r.vencimento).toBe("2026-03-09");
    expect(r.memoria.join("\n")).toContain("CPP, art. 798, § 3º");
  });

  it("suspende o prazo penal no recesso, salvo réu preso", () => {
    expect(vence({ forma: "outra", data: "2026-12-15", dias: 10, rito: "cpp" })).toBe("2027-01-26");
    const preso = calcularPrazo({ forma: "outra", data: "2026-12-15", dias: 10, rito: "cpp", reuPreso: true }, nacional);
    expect(preso.vencimento).toBe("2026-12-28");
    expect(preso.memoria.join("\n")).toContain("Réu preso");
  });

  it("respeita os feriados do escritório", () => {
    const feriados: Feriado[] = [{ id: "1", data: "2026-03-09", descricao: "Suspensão", tribunal: "TJSP" }];
    const regra: RegraPrazo = { forma: "dje", data: "2026-02-12", dias: 15, rito: "cpc" };
    expect(vence(regra, new Calendario(feriados, { tribunal: "TJSP" }))).toBe("2026-03-11");
    expect(vence(regra, new Calendario(feriados, { tribunal: "TJRJ" }))).toBe("2026-03-10");
  });

  it("valida a regra", () => {
    expect(() => validarRegra({ forma: "dje", data: "2026-02-30", dias: 5, rito: "cpc" })).toThrow("Data");
    expect(() => validarRegra({ forma: "fax", data: "2026-02-10", dias: 5, rito: "cpc" })).toThrow("Forma");
    expect(() => validarRegra({ forma: "dje", data: "2026-02-10", dias: 0, rito: "cpc" })).toThrow("1 a 365");
    expect(validarRegra({ forma: "dje", data: "2026-02-10", dias: 5, rito: "cpc", dobro: false, extra: 1 }))
      .toEqual({ forma: "dje", data: "2026-02-10", dias: 5, rito: "cpc" });
  });
});
