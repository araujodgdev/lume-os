// Agenda is the firm's calendar: procedural deadlines, hearings, tasks and meetings, linked to the
// cases in CASOS. Every lawyer in the firm sees the same calendar.
//
// Never count a procedural deadline yourself. `calcularPrazo()` applies the counting rules
// (working or calendar days, the 20/12-20/01 recess, national holidays and the local holidays and
// suspensions the firm registered) and returns `memoria`, the step-by-step calculation. Show the
// lawyer the due date together with `memoria` and ask them to check it before filing.
//
// `criar()`, `alterar()`, `concluir()`, `cancelar()` and `proporFeriado()` propose changes that a
// lawyer reviews. Later reads already reflect a proposal, so keep working without waiting for it.
//
// Dates are "AAAA-MM-DD" strings and times "HH:MM", both in Brasília time.

/** How the notice reached the firm. It decides the day the notice counts as made. */
export type FormaIntimacao =
  /** Published in the electronic gazette (DJe/DJEN): `data` is the day it was made available. */
  | "dje"
  /** Opened in the court's electronic portal (PJe, e-SAJ, Eproc…): `data` is the day it was opened. */
  | "portal"
  /** Sent to the portal and never opened: `data` is the day it was sent (tacit notice 10 days later). */
  | "portal_tacita"
  /** Any other notice (mail, court officer, filing of the receipt): `data` is the day it counts from. */
  | "outra";

/** The procedure whose counting rules apply. */
export type RitoPrazo =
  /** Civil procedure, working days (CPC art. 219). */
  | "cpc"
  /** Labor courts, working days (CLT art. 775). */
  | "clt"
  /** Small claims courts, working days. */
  | "jec"
  /** Criminal procedure, calendar days (CPP art. 798). */
  | "cpp";

/** What a deadline is counted from. */
export interface RegraPrazo {
  forma: FormaIntimacao;
  /** See `FormaIntimacao` for which day this is. */
  data: string;
  /** Length as the law or the judge set it, before doubling. From 1 to 365. */
  dias: number;
  rito: RitoPrazo;
  /**
   * Doubled deadline: public treasury (CPC art. 183), prosecutors (art. 180), public defenders
   * (art. 186), co-parties with different lawyers in paper records (art. 229).
   */
  dobro?: boolean;
  /** Criminal cases with a defendant in custody keep running through the recess. */
  reuPreso?: boolean;
}

/** Where a deadline runs, which decides the local holidays that apply. */
export interface LocalPrazo {
  /** Court acronym, e.g. "TJSP" or "TRT-2". Defaults to the case's court. */
  tribunal?: string;
  /** District, e.g. "Campinas". Local holidays registered for a district apply only with it. */
  comarca?: string;
  /** Takes the court from this case when `tribunal` is absent. */
  casoId?: string;
}

/** A counted deadline. */
export interface CalculoPrazo {
  /** Last day to act. */
  vencimento: string;
  /** The day the notice counts as made. */
  intimacao: string;
  /** First day counted. */
  inicioContagem: string;
  /** Days counted, after doubling. */
  dias: number;
  /** Each step of the calculation, in Portuguese. Show it to the lawyer. */
  memoria: string[];
}

export type TipoCompromisso = "prazo" | "audiencia" | "tarefa" | "reuniao";

export type StatusCompromisso = "pendente" | "cumprido" | "cancelado";

/** An entry in the firm's calendar. */
export interface Compromisso {
  /** Stable identifier; pass it to `alterar()`, `concluir()` and `cancelar()`. */
  id: string;
  tipo: TipoCompromisso;
  /** E.g. "Contestação" or "Audiência de instrução". */
  titulo: string;
  /** Details, in Markdown. May be empty. */
  descricao: string;
  casoId?: string;
  /** The day: a deadline's due date, a hearing's or meeting's date, a task's due date. */
  data: string;
  /** Start time, "HH:MM", for hearings and meetings. */
  hora?: string;
  /** Length in minutes, for hearings and meetings. */
  duracaoMinutos?: number;
  /** Address or room. */
  local?: string;
  /** Video call link. */
  link?: string;
  /** Usernames of the lawyers responsible. Empty: the case's responsible lawyers. */
  responsaveis: string[];
  status: StatusCompromisso;
  tribunal?: string;
  comarca?: string;
  /** For deadlines counted by the Agenda: the rule and the calculation behind `data`. */
  prazo?: { regra: RegraPrazo; calculo: CalculoPrazo };
  /** Creation time, epoch milliseconds. */
  criadoEm: number;
  /** Last change, epoch milliseconds. */
  atualizadoEm: number;
}

/**
 * A new calendar entry. A deadline takes either `regra` (the Agenda counts `data`) or an explicit
 * `data` (a date the judge set, for instance); explain an explicit date in `descricao`. Other types
 * take `data`. `tribunal` defaults to the case's court.
 */
export interface NovoCompromisso {
  tipo: TipoCompromisso;
  titulo: string;
  descricao?: string;
  casoId?: string;
  data?: string;
  regra?: RegraPrazo;
  hora?: string;
  duracaoMinutos?: number;
  local?: string;
  link?: string;
  responsaveis?: string[];
  tribunal?: string;
  comarca?: string;
}

/**
 * Changes to an entry. Only the fields present change; set an optional text field to `""` to clear
 * it. Passing `regra` recounts the deadline; passing `data` on a counted deadline drops the rule.
 */
export type AlteracoesCompromisso = Partial<Omit<NovoCompromisso, "tipo">> & {
  status?: StatusCompromisso;
};

/** Filters for `listar()`. Omitted fields do not filter. */
export interface FiltroAgenda {
  /** First day, inclusive. */
  de?: string;
  /** Last day, inclusive. */
  ate?: string;
  casoId?: string;
  tipo?: TipoCompromisso;
  /** Defaults to "pendente". */
  status?: StatusCompromisso | "todos";
  /** A username; matches entries assigned to them directly or through the case. */
  responsavel?: string;
}

/** A day without court business. */
export interface DiaSemExpediente {
  data: string;
  descricao: string;
  /** National holidays are built in; the firm registers local holidays and suspensions. */
  origem: "nacional" | "escritorio";
  tribunal?: string;
  comarca?: string;
}

/** A local holiday or suspension to register. Absent `tribunal`: every court. */
export interface NovoFeriado {
  data: string;
  /** Last day of a range, inclusive. */
  ate?: string;
  /** E.g. "Aniversário de Campinas" or "Indisponibilidade do PJe (Portaria 12/2026)". */
  descricao: string;
  tribunal?: string;
  comarca?: string;
}

/** The firm's calendar. */
export interface AgendaSession {
  /** Counts a deadline without saving anything. */
  calcularPrazo(regra: RegraPrazo, local?: LocalPrazo): Promise<CalculoPrazo>;

  /** Entries matching `filtro`, by date and time. Pending entries only, unless `status` says otherwise. */
  listar(filtro?: FiltroAgenda): Promise<Compromisso[]>;

  /** Pending entries due within the next `diasUteis` working days (default 7), overdue ones included. */
  proximos(diasUteis?: number): Promise<Compromisso[]>;

  /** Proposes a new entry and returns its id. Throws if a field is invalid or the case does not exist. */
  criar(novo: NovoCompromisso): Promise<string>;

  /** Proposes changes to an entry. */
  alterar(id: string, alteracoes: AlteracoesCompromisso): Promise<void>;

  /** Proposes marking an entry as done. */
  concluir(id: string): Promise<void>;

  /** Proposes cancelling an entry. */
  cancelar(id: string): Promise<void>;

  /** Days without court business between two dates, national and registered, for a place. */
  feriados(de: string, ate: string, local?: LocalPrazo): Promise<DiaSemExpediente[]>;

  /**
   * Proposes registering a local holiday or suspension. Once approved it recounts every pending
   * deadline it affects. Cite the source (law, ordinance) in `descricao`.
   */
  proporFeriado(feriado: NovoFeriado): Promise<void>;
}
