// Values for a template's fields, from the case and the firm's settings.

import type { Campo } from "./modelo.js";
import type { Caso } from "../types.js";

/** A date the way petitions close: "24 de setembro de 2026", in Brasília time. */
export function dataPorExtenso(quando: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Sao_Paulo",
  }).format(quando);
}

/** The fields filled from a case (when there is one), the firm's city and today's date. */
export function montarCampos(
  caso: Caso | null,
  cidade: string | undefined,
  quando: Date,
): Partial<Record<Campo, string>> {
  return {
    cliente: caso?.cliente.nome ?? "",
    processo: caso?.numeroCnj ?? "",
    tribunal: caso?.tribunal ?? "",
    orgao_julgador: caso?.orgaoJulgador ?? "",
    cidade: cidade ?? "",
    data: dataPorExtenso(quando),
  };
}
