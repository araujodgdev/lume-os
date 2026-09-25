// Reading a deadline's length from a notice's text: "no prazo de 15 (quinze) dias", "prazo de cinco
// dias úteis", "em 48 horas". Only what the text states; "prazo legal" is left to the lawyer.

const NUMEROS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, "três": 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, noventa: 90,
};

function numero(texto: string): number | undefined {
  const digitos = /^\d{1,3}$/.exec(texto.trim());
  if (digitos) return Number(digitos[0]);
  const partes = texto.toLowerCase().split(/\s+e\s+/);
  let total = 0;
  for (const p of partes) {
    const n = NUMEROS[p.trim()];
    if (n === undefined) return undefined;
    total += n;
  }
  return total || undefined;
}

/**
 * The deadline length the text states, in days, or undefined. "48 horas" counts as 2 days; the
 * first stated deadline wins.
 */
export function diasDoTexto(texto: string): number | undefined {
  const t = texto.replace(/\s+/g, " ");
  const palavra = "([\\wÀ-ú]+(?: e [\\wÀ-ú]+)?)";
  const padroes = [
    new RegExp(`prazo (?:comum |sucessivo |improrrog[áa]vel )?de ${palavra}(?: \\(([^)]+)\\))? dias`, "i"),
    new RegExp(`(?:em|no prazo de|dentro de) ${palavra}(?: \\(([^)]+)\\))? dias`, "i"),
    new RegExp(`prazo (?:de )?${palavra}(?: \\(([^)]+)\\))? horas|em ${palavra}(?: \\(([^)]+)\\))? horas`, "i"),
  ];
  for (const [i, padrao] of padroes.entries()) {
    const m = padrao.exec(t);
    if (!m) continue;
    const bruto = numero(m[1] ?? "") ?? numero(m[2] ?? "") ?? numero(m[3] ?? "") ?? numero(m[4] ?? "");
    if (bruto === undefined) continue;
    const dias = i === 2 ? Math.max(1, Math.ceil(bruto / 24)) : bruto;
    if (dias >= 1 && dias <= 365) return dias;
  }
  return undefined;
}
