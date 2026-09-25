// Processos follows the firm's cases in the courts: notices (intimações) waiting in the PJe, gazette
// publications for the lawyers' OAB numbers (DJEN), and new docket entries (movimentações).
//
// You can read what arrived, but you can never open a PJe notice: in the PJe, opening a notice's
// content registers that the lawyer was notified and starts the deadline. Only a lawyer does that,
// on the Intimações page. When you summarize, say which notices are still closed and that opening
// them starts the deadline; point to the suggested deadlines in the Agenda and never treat them as
// confirmed.

/** Where a notice came from. */
export type OrigemIntimacao =
  /** Waiting in the PJe for the lawyer (read through the court's MNI web service). */
  | "pje"
  /** Published in the national electronic gazette (DJEN) for one of the firm's OAB numbers. */
  | "djen";

export type StatusIntimacao =
  /** Arrived and nobody acted on it. For "pje", its content is still closed. */
  | "nova"
  /** A lawyer opened it (the PJe registered the notification) or read the publication. */
  | "aberta"
  /** A lawyer dismissed it (not the firm's, duplicate). */
  | "descartada";

/** A notice or publication about a case. */
export interface Intimacao {
  id: string;
  origem: OrigemIntimacao;
  status: StatusIntimacao;
  /** CNJ number, formatted. */
  processo: string;
  /** Court acronym, e.g. "TJMG". */
  tribunal: string;
  /** The firm's case with this CNJ number, when there is one. */
  casoId?: string;
  /** E.g. "Intimação", "Citação", "Edital". */
  tipo?: string;
  /** Court division that issued it. */
  orgao?: string;
  /** Day it was sent to the PJe or made available in the gazette, "AAAA-MM-DD". */
  dataDisponibilizacao: string;
  /** For closed PJe notices: the day the tacit notification happens (10 days after sending). */
  cienciaTacita?: string;
  /** The text: the publication, or the notice's content once a lawyer opened it. Absent while closed. */
  texto?: string;
  /** Deadline in days, when the court or the text states it. */
  prazoDias?: number;
  /** Username of the lawyer whose OAB or PJe account received it. */
  advogado: string;
  /** Id of the deadline suggested in the Agenda, if any. */
  compromissoId?: string;
  /** Official link, when the source gives one. */
  link?: string;
  recebidaEm: number;
}

/** A docket entry of a case. */
export interface Movimentacao {
  processo: string;
  tribunal: string;
  casoId?: string;
  /** "AAAA-MM-DDTHH:MM". */
  dataHora: string;
  /** CNJ national movement code, when there is one. */
  codigo?: number;
  descricao: string;
  /** "datajud" or "pje". */
  fonte: string;
}

export interface FiltroIntimacoes {
  status?: StatusIntimacao | "todas";
  casoId?: string;
  /** Arrived on or after this day, "AAAA-MM-DD". */
  desde?: string;
}

/** The firm's notices and docket entries. */
export interface ProcessosSession {
  /** Notices and publications, newest first. New ones only, unless `status` says otherwise. */
  intimacoes(filtro?: FiltroIntimacoes): Promise<Intimacao[]>;

  /** A case's docket entries (by case id or CNJ number), newest first. */
  movimentacoes(alvo: { casoId?: string; processo?: string }): Promise<Movimentacao[]>;
}
