// Procedural deadlines: when the notice counts as made, when counting starts, and the day it ends.
// Every step is written to `memoria` so a lawyer can check the result before filing.

import {
  Calendario,
  dataDoNumero,
  ehData,
  formatarData,
  noRecesso,
  numeroDoDia,
  somarDias,
  type DataCivil,
} from "./calendario.js";
import type { CalculoPrazo, FormaIntimacao, RegraPrazo, RitoPrazo as Rito } from "./types.js";

export type { CalculoPrazo, FormaIntimacao, RegraPrazo, RitoPrazo as Rito } from "./types.js";

const FORMAS: FormaIntimacao[] = ["dje", "portal", "portal_tacita", "outra"];
const RITOS: Rito[] = ["cpc", "clt", "jec", "cpp"];
export const MAX_DIAS_PRAZO = 365;

const NOME_RITO: Record<Rito, string> = {
  cpc: "dias úteis (CPC, art. 219)",
  clt: "dias úteis (CLT, art. 775)",
  jec: "dias úteis (Lei 9.099/95, art. 12-A)",
  cpp: "dias corridos (CPP, art. 798)",
};

/** Checks a rule from outside (the agent or the page) and returns a clean copy. */
export function validarRegra(regra: unknown): RegraPrazo {
  if (!regra || typeof regra !== "object") throw new Error("Informe a regra do prazo.");
  const r = regra as Record<string, unknown>;
  if (!FORMAS.includes(r.forma as FormaIntimacao)) {
    throw new Error(`Forma de intimação inválida. Use uma de: ${FORMAS.join(", ")}.`);
  }
  if (!ehData(r.data)) throw new Error("Data da intimação inválida. Use AAAA-MM-DD.");
  if (!Number.isInteger(r.dias) || (r.dias as number) < 1 || (r.dias as number) > MAX_DIAS_PRAZO) {
    throw new Error(`O prazo deve ter de 1 a ${MAX_DIAS_PRAZO} dias.`);
  }
  if (!RITOS.includes(r.rito as Rito)) throw new Error(`Rito inválido. Use um de: ${RITOS.join(", ")}.`);
  for (const campo of ["dobro", "reuPreso"]) {
    if (r[campo] !== undefined && typeof r[campo] !== "boolean") throw new Error(`"${campo}" deve ser true ou false.`);
  }
  return {
    forma: r.forma as FormaIntimacao,
    data: r.data,
    dias: r.dias as number,
    rito: r.rito as Rito,
    ...(r.dobro ? { dobro: true } : {}),
    ...(r.reuPreso ? { reuPreso: true } : {}),
  };
}

/** Counts a deadline on `calendario`. */
export function calcularPrazo(regra: RegraPrazo, calendario: Calendario): CalculoPrazo {
  const memoria: string[] = [];
  const f = formatarData;
  const motivo = (d: DataCivil) => diaOuFeriado(calendario.motivoSemExpediente(d) ?? "");

  // 1. The day the notice counts as made.
  let intimacao: DataCivil;
  switch (regra.forma) {
    case "dje":
      intimacao = calendario.proximoDiaUtil(regra.data);
      memoria.push(
        `Disponibilizada no DJe em ${f(regra.data)}; considera-se publicada em ${f(intimacao)}, ` +
          "o primeiro dia útil seguinte (Lei 11.419/2006, art. 4º, § 3º).",
      );
      break;
    case "portal":
      intimacao = calendario.diaUtilAPartirDe(regra.data);
      memoria.push(
        intimacao === regra.data
          ? `Intimação consultada no portal em ${f(regra.data)}.`
          : `Intimação consultada no portal em ${f(regra.data)}, ${motivo(regra.data)}; ` +
            `considera-se feita em ${f(intimacao)}, o primeiro dia útil seguinte (Lei 11.419/2006, art. 5º, § 2º).`,
      );
      break;
    case "portal_tacita": {
      const decimo = somarDias(regra.data, 10);
      intimacao = calendario.diaUtilAPartirDe(decimo);
      memoria.push(
        `Intimação enviada ao portal em ${f(regra.data)} e não consultada: a ciência tácita ocorre ` +
          `10 dias corridos depois, em ${f(decimo)} (Lei 11.419/2006, art. 5º, § 3º)` +
          (intimacao === decimo ? "." : `; como é ${motivo(decimo)}, passa para ${f(intimacao)}.`),
      );
      break;
    }
    default:
      intimacao = regra.data;
      memoria.push(`Intimação considerada feita em ${f(regra.data)}.`);
  }

  const dias = regra.dobro ? regra.dias * 2 : regra.dias;
  const suspendeNoRecesso = !(regra.rito === "cpp" && regra.reuPreso);
  const suspenso = (d: DataCivil) => suspendeNoRecesso && noRecesso(d);
  memoria.push(
    `Prazo de ${regra.dias} ${regra.dias === 1 ? "dia" : "dias"}` +
      (regra.dobro ? `, em dobro: ${dias} dias` : "") +
      `, em ${NOME_RITO[regra.rito]}.`,
  );

  // 2. Counting.
  let inicioContagem: DataCivil;
  let vencimento: DataCivil;
  const pulados: string[] = [];
  let tocouRecesso = false;

  if (regra.rito === "cpp") {
    // Starts on the first working day after the notice (CPP art. 798 § 1º; STF Súmula 310).
    inicioContagem = calendario.proximoDiaUtil(intimacao);
    while (suspenso(inicioContagem) || !calendario.ehDiaUtil(inicioContagem)) {
      tocouRecesso ||= suspenso(inicioContagem);
      inicioContagem = somarDias(inicioContagem, 1);
    }
    let d = inicioContagem;
    let contados = 1;
    while (contados < dias) {
      d = somarDias(d, 1);
      if (suspenso(d)) {
        tocouRecesso = true;
        continue;
      }
      contados++;
    }
    vencimento = d;
    if (!calendario.ehDiaUtil(vencimento) || suspenso(vencimento)) {
      const original = vencimento;
      while (!calendario.ehDiaUtil(vencimento) || suspenso(vencimento)) {
        tocouRecesso ||= suspenso(vencimento);
        vencimento = somarDias(vencimento, 1);
      }
      memoria.push(
        `A contagem termina em ${f(original)}, dia sem expediente; o vencimento passa para ` +
          `${f(vencimento)}, o primeiro dia útil seguinte (CPP, art. 798, § 3º).`,
      );
    }
  } else {
    let d = intimacao;
    let contados = 0;
    inicioContagem = "";
    while (contados < dias) {
      d = somarDias(d, 1);
      if (suspenso(d)) {
        tocouRecesso = true;
        continue;
      }
      const fechado = calendario.motivoSemExpediente(d);
      if (fechado) {
        if (fechado !== "sábado" && fechado !== "domingo") pulados.push(`${f(d)} (${fechado})`);
        continue;
      }
      if (!inicioContagem) inicioContagem = d;
      contados++;
    }
    vencimento = d;
  }

  memoria.push(`A contagem começa em ${f(inicioContagem)}, excluído o dia da intimação (${
    regra.rito === "cpp" ? "CPP, art. 798, § 1º" : "CPC, art. 224, § 3º"
  }).`);
  if (pulados.length) memoria.push(`Dias sem expediente não contados: ${pulados.join(", ")}.`);
  if (tocouRecesso) {
    memoria.push(
      regra.rito === "cpp"
        ? "O prazo fica suspenso de 20/12 a 20/01 (CPP, art. 798-A)."
        : `O prazo fica suspenso de 20/12 a 20/01 (${regra.rito === "clt" ? "CLT, art. 775-A" : "CPC, art. 220"}).`,
    );
  } else if (regra.rito === "cpp" && regra.reuPreso && cruzaRecesso(inicioContagem, vencimento)) {
    memoria.push("Réu preso: o prazo corre durante o recesso (CPP, art. 798-A, I).");
  }
  memoria.push(`Vencimento: ${f(vencimento)}.`);

  return { vencimento, intimacao, inicioContagem, dias, memoria };
}

function diaOuFeriado(motivo: string): string {
  return motivo === "sábado" || motivo === "domingo" ? motivo : `dia sem expediente (${motivo})`;
}

function cruzaRecesso(de: DataCivil, ate: DataCivil): boolean {
  for (let n = numeroDoDia(de); n <= numeroDoDia(ate); n++) {
    if (noRecesso(dataDoNumero(n))) return true;
  }
  return false;
}
