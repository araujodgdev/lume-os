// Civil dates and the days courts work. Dates are "AAAA-MM-DD" strings with no time zone: a
// deadline falls on a day, not an instant. "Today" is always the day in Brasília.

/** A civil date, "AAAA-MM-DD". */
export type DataCivil = string;

/** A day or range without court business the firm registered: a local holiday or a suspension. */
export type Feriado = {
  id: string;
  data: DataCivil;
  /** Last day of a range, inclusive. Absent for a single day. */
  ate?: DataCivil;
  descricao: string;
  /** Court acronym it applies to, e.g. "TJSP". Absent: every court. */
  tribunal?: string;
  /** District it applies to, e.g. "Campinas". Absent: the whole court. */
  comarca?: string;
};

/** Where a deadline runs, which decides the local holidays that apply. */
export type Local = { tribunal?: string; comarca?: string };

/** A day without court business, with its reason. */
export type DiaSemExpediente = {
  data: DataCivil;
  descricao: string;
  origem: "nacional" | "escritorio";
  tribunal?: string;
  comarca?: string;
};

const DATA = /^(\d{4})-(\d{2})-(\d{2})$/;
const DIA_MS = 86_400_000;

/** Whether `data` is a real "AAAA-MM-DD" date. */
export function ehData(data: unknown): data is DataCivil {
  if (typeof data !== "string") return false;
  const m = DATA.exec(data);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/** Days since 1970-01-01. */
export function numeroDoDia(data: DataCivil): number {
  const m = DATA.exec(data);
  if (!m) throw new Error(`Data inválida: ${data}. Use AAAA-MM-DD.`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / DIA_MS;
}

export function dataDoNumero(numero: number): DataCivil {
  return new Date(numero * DIA_MS).toISOString().slice(0, 10);
}

export function somarDias(data: DataCivil, dias: number): DataCivil {
  return dataDoNumero(numeroDoDia(data) + dias);
}

/** 0 = Sunday … 6 = Saturday. */
export function diaDaSemana(data: DataCivil): number {
  return new Date(numeroDoDia(data) * DIA_MS).getUTCDay();
}

/** "05/03/2026". */
export function formatarData(data: DataCivil): string {
  const [a, m, d] = data.split("-");
  return `${d}/${m}/${a}`;
}

const DIAS_DA_SEMANA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/** "sex., 05/03/2026" style label: "sexta, 05/03/2026". */
export function formatarDataComDia(data: DataCivil): string {
  return `${DIAS_DA_SEMANA[diaDaSemana(data)]}, ${formatarData(data)}`;
}

/** Today in Brasília. */
export function hojeEmBrasilia(agora: Date = new Date()): DataCivil {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
}

/** Easter Sunday (Meeus/Jones/Butcher, Gregorian calendar). */
export function pascoa(ano: number): DataCivil {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/** National holidays and the movable days courts close, for one year. */
export function feriadosNacionais(ano: number): DiaSemExpediente[] {
  const fixos: [string, string][] = [
    ["01-01", "Confraternização Universal"],
    ["04-21", "Tiradentes"],
    ["05-01", "Dia do Trabalho"],
    ["09-07", "Independência do Brasil"],
    ["10-12", "Nossa Senhora Aparecida"],
    ["11-02", "Finados"],
    ["11-15", "Proclamação da República"],
    ...(ano >= 2024 ? [["11-20", "Dia Nacional de Zumbi e da Consciência Negra"] as [string, string]] : []),
    ["12-25", "Natal"],
  ];
  const p = pascoa(ano);
  const moveis: [DataCivil, string][] = [
    [somarDias(p, -48), "Carnaval (segunda-feira)"],
    [somarDias(p, -47), "Carnaval (terça-feira)"],
    [somarDias(p, -2), "Sexta-feira Santa"],
    [somarDias(p, 60), "Corpus Christi"],
  ];
  return [
    ...fixos.map(([md, descricao]) => ({ data: `${ano}-${md}`, descricao, origem: "nacional" as const })),
    ...moveis.map(([data, descricao]) => ({ data, descricao, origem: "nacional" as const })),
  ].toSorted((x, y) => x.data.localeCompare(y.data));
}

/** Uppercase, no spaces or dashes: "trt-2" and "TRT2" match. */
export function normalizarTribunal(tribunal: string | undefined): string {
  return (tribunal ?? "").toUpperCase().replace(/[\s-]/g, "");
}

/** Lowercase, no accents or extra spaces: "São Paulo" and "sao  paulo" match. */
export function normalizarComarca(comarca: string | undefined): string {
  return (comarca ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether a registered day applies where a deadline runs. When in doubt it does not apply: a day
 * that is not skipped makes the deadline earlier, never later.
 */
export function feriadoAplica(feriado: Pick<Feriado, "tribunal" | "comarca">, local: Local): boolean {
  if (feriado.tribunal && normalizarTribunal(feriado.tribunal) !== normalizarTribunal(local.tribunal)) {
    return false;
  }
  if (feriado.comarca && normalizarComarca(feriado.comarca) !== normalizarComarca(local.comarca)) {
    return false;
  }
  return true;
}

/** The recess of CPC art. 220: 20 December to 20 January, inclusive. */
export function noRecesso(data: DataCivil): boolean {
  const md = data.slice(5);
  return md >= "12-20" || md <= "01-20";
}

/** The days courts work, for one place. */
export class Calendario {
  readonly #nacionais = new Map<number, Map<DataCivil, string>>();
  readonly #escritorio = new Map<DataCivil, string>();

  constructor(feriados: Feriado[], readonly local: Local = {}) {
    for (const feriado of feriados) {
      if (!feriadoAplica(feriado, local)) continue;
      const fim = feriado.ate ?? feriado.data;
      for (let n = numeroDoDia(feriado.data); n <= numeroDoDia(fim); n++) {
        const data = dataDoNumero(n);
        if (!this.#escritorio.has(data)) this.#escritorio.set(data, feriado.descricao);
      }
    }
  }

  /** Why courts do not work on `data`, or null on a working day. */
  motivoSemExpediente(data: DataCivil): string | null {
    const semana = diaDaSemana(data);
    if (semana === 6) return "sábado";
    if (semana === 0) return "domingo";
    const nacional = this.#nacionaisDe(Number(data.slice(0, 4))).get(data);
    if (nacional) return nacional;
    return this.#escritorio.get(data) ?? null;
  }

  ehDiaUtil(data: DataCivil): boolean {
    return this.motivoSemExpediente(data) === null;
  }

  /** The first working day after `data`. */
  proximoDiaUtil(data: DataCivil): DataCivil {
    let d = somarDias(data, 1);
    while (!this.ehDiaUtil(d)) d = somarDias(d, 1);
    return d;
  }

  /** `data` itself when courts work on it, else the next working day. */
  diaUtilAPartirDe(data: DataCivil): DataCivil {
    return this.ehDiaUtil(data) ? data : this.proximoDiaUtil(data);
  }

  /** Adds `dias` working days to `data` (0 returns `data`). */
  somarDiasUteis(data: DataCivil, dias: number): DataCivil {
    let d = data;
    for (let i = 0; i < dias; i++) d = this.proximoDiaUtil(d);
    return d;
  }

  #nacionaisDe(ano: number): Map<DataCivil, string> {
    let mapa = this.#nacionais.get(ano);
    if (!mapa) {
      mapa = new Map(feriadosNacionais(ano).map((f) => [f.data, f.descricao]));
      this.#nacionais.set(ano, mapa);
    }
    return mapa;
  }
}

/** Every day without court business between `de` and `ate`, national and registered. */
export function diasSemExpediente(
  feriados: Feriado[],
  de: DataCivil,
  ate: DataCivil,
  local?: Local,
): DiaSemExpediente[] {
  const inicio = numeroDoDia(de);
  const fim = numeroDoDia(ate);
  const dias: DiaSemExpediente[] = [];
  for (let ano = Number(de.slice(0, 4)); ano <= Number(ate.slice(0, 4)); ano++) {
    for (const f of feriadosNacionais(ano)) {
      const n = numeroDoDia(f.data);
      if (n >= inicio && n <= fim) dias.push(f);
    }
  }
  for (const f of feriados) {
    if (local && !feriadoAplica(f, local)) continue;
    const primeiro = Math.max(numeroDoDia(f.data), inicio);
    const ultimo = Math.min(numeroDoDia(f.ate ?? f.data), fim);
    for (let n = primeiro; n <= ultimo; n++) {
      dias.push({
        data: dataDoNumero(n),
        descricao: f.descricao,
        origem: "escritorio",
        ...(f.tribunal ? { tribunal: f.tribunal } : {}),
        ...(f.comarca ? { comarca: f.comarca } : {}),
      });
    }
  }
  return dias.toSorted((x, y) => x.data.localeCompare(y.data));
}
