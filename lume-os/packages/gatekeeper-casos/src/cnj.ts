// The CNJ unified case number (Resolução CNJ 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO, where DD are
// ISO 7064 mod 97-10 check digits over the other eighteen digits.

const CNJ_DIGITS = 20;

/**
 * Normalizes a CNJ number, with or without punctuation, to `NNNNNNN-DD.AAAA.J.TR.OOOO`. Throws a
 * TypeError when it does not have twenty digits or its check digits do not match.
 */
export function normalizeCnj(input: string): string {
  if (typeof input !== "string") throw new TypeError("O número CNJ deve ser um texto.");
  const trimmed = input.trim();
  if (!/^[\d.\-\s]+$/.test(trimmed)) {
    throw new TypeError(`Número CNJ inválido: "${input}".`);
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length !== CNJ_DIGITS) {
    throw new TypeError(`Número CNJ inválido: "${input}" deve ter 20 dígitos.`);
  }
  const sequencial = digits.slice(0, 7);
  const dv = digits.slice(7, 9);
  const ano = digits.slice(9, 13);
  const segmento = digits.slice(13, 14);
  const tribunal = digits.slice(14, 16);
  const origem = digits.slice(16, 20);
  if (checkDigits(sequencial + ano + segmento + tribunal + origem) !== dv) {
    throw new TypeError(`Número CNJ inválido: "${input}" tem dígito verificador incorreto.`);
  }
  return `${sequencial}-${dv}.${ano}.${segmento}.${tribunal}.${origem}`;
}

/** The two check digits for the eighteen non-check digits of a CNJ number, in order. */
export function checkDigits(eighteenDigits: string): string {
  const remainder = BigInt(eighteenDigits + "00") % 97n;
  return String(98n - remainder).padStart(2, "0");
}
