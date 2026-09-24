import { describe, expect, it } from "vitest";
import { checkDigits, normalizeCnj } from "../src/cnj.js";

describe("normalizeCnj", () => {
  it("accepts a real number with or without punctuation", () => {
    expect(normalizeCnj("0710802-55.2018.8.02.0001")).toBe("0710802-55.2018.8.02.0001");
    expect(normalizeCnj(" 07108025520188020001 ")).toBe("0710802-55.2018.8.02.0001");
  });

  it("rejects wrong check digits, lengths and stray characters", () => {
    expect(() => normalizeCnj("0710802-56.2018.8.02.0001")).toThrow(/dígito verificador/);
    expect(() => normalizeCnj("0710802-55.2018.8.02.001")).toThrow(/20 dígitos/);
    expect(() => normalizeCnj("0710802-55.2018.8.02.000a")).toThrow(/inválido/);
  });

  it("computes check digits that round-trip", () => {
    // Sequential number, year, segment, court and origin, without the check digits.
    const digits = "123456720248260100";
    const dv = checkDigits(digits);
    expect(normalizeCnj(`1234567${dv}2024826 0100`)).toBe(`1234567-${dv}.2024.8.26.0100`);
  });
});
