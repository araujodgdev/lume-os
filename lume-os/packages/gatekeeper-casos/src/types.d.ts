// Casos is the law firm's case registry. Every lawyer in the firm sees the same cases, so read a
// case before drafting anything about it: its `resumo` holds the facts, strategy and key points the
// team has recorded.
//
// `create()` and `update()` propose changes that a lawyer reviews. Later reads already reflect a
// proposal, so keep working without waiting for it; a proposal the lawyer rejects disappears.
//
// Case numbers use the CNJ unified format `NNNNNNN-DD.AAAA.J.TR.OOOO`. Methods that take one accept
// it with or without punctuation and reject numbers whose check digits do not match.

/** Where the case stands. */
export type StatusCaso = "ativo" | "suspenso" | "encerrado";

/** Area of law the case belongs to. */
export type AreaCaso =
  | "civel"
  | "trabalhista"
  | "tributario"
  | "familia"
  | "criminal"
  | "consumidor"
  | "empresarial"
  | "previdenciario"
  | "outro";

/** Which side of the case the firm's client is on. */
export type PoloCliente = "ativo" | "passivo";

/** The firm's client in a case. */
export interface ClienteCaso {
  /** Full name or corporate name. */
  nome: string;
  /** CPF or CNPJ, digits only, when known. */
  documento?: string;
}

/** A case as recorded by the firm. */
export interface Caso {
  /** Stable identifier; pass it back to `get()` and `update()`. */
  id: string;
  /** Short name used by the team, e.g. "Silva x Banco Alfa". */
  titulo: string;
  cliente: ClienteCaso;
  poloCliente: PoloCliente;
  /** Opposing parties, in the order the team listed them. */
  parteContraria: string[];
  /** CNJ number, formatted `NNNNNNN-DD.AAAA.J.TR.OOOO`, when the case is already filed. */
  numeroCnj?: string;
  /** Court acronym, e.g. "TJSP" or "TRT-2". */
  tribunal?: string;
  /** Court division or district, e.g. "3ª Vara Cível de Campinas". */
  orgaoJulgador?: string;
  area: AreaCaso;
  status: StatusCaso;
  /** Usernames of the lawyers responsible for the case. */
  responsaveis: string[];
  /** Facts, strategy and key points, in Markdown. May be empty. */
  resumo: string;
  /** Creation time, epoch milliseconds. */
  criadoEm: number;
  /** Last change, epoch milliseconds. */
  atualizadoEm: number;
}

/** A case without its `resumo`, as returned by `list()`. */
export type ResumoCaso = Omit<Caso, "resumo">;

/** Filters for `list()`. Omitted fields do not filter. */
export interface FiltroCasos {
  status?: StatusCaso;
  /** Case-insensitive text matched against title, client, opposing parties and CNJ number. */
  busca?: string;
}

/**
 * Fields for a new case. `titulo`, `cliente.nome`, `poloCliente` and `area` are required; the rest
 * default to empty, `status` to `"ativo"`.
 */
export interface NovoCaso {
  titulo: string;
  cliente: ClienteCaso;
  poloCliente: PoloCliente;
  parteContraria?: string[];
  numeroCnj?: string;
  tribunal?: string;
  orgaoJulgador?: string;
  area: AreaCaso;
  status?: StatusCaso;
  responsaveis?: string[];
  resumo?: string;
}

/**
 * Changes to an existing case. Only the fields present change; set an optional text field to `""`
 * to clear it. Lists replace the previous list entirely.
 */
export type AlteracoesCaso = Partial<Omit<Caso, "id" | "criadoEm" | "atualizadoEm">>;

/** The firm's cases. */
export interface CasosSession {
  /** Cases matching `filtro`, most recently changed first, without their `resumo`. */
  list(filtro?: FiltroCasos): Promise<ResumoCaso[]>;

  /** The complete case, or null when no case has this id. */
  get(id: string): Promise<Caso | null>;

  /**
   * The case with this CNJ number, or null when the firm has none. Throws if the number is not a
   * valid CNJ number.
   */
  findByNumero(numeroCnj: string): Promise<Caso | null>;

  /**
   * Proposes a new case and returns its id. Throws if a required field is missing, the CNJ number
   * is invalid, or another case already has it.
   */
  create(novo: NovoCaso): Promise<string>;

  /**
   * Proposes changes to a case. Throws if the case does not exist, a field is invalid, or the new
   * CNJ number belongs to another case.
   */
  update(id: string, alteracoes: AlteracoesCaso): Promise<void>;
}
