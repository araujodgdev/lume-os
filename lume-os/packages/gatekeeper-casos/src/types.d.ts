// Casos is the law firm's case registry. Every lawyer in the firm sees the same cases, so read a
// case before drafting anything about it: its `resumo` holds the facts, strategy and key points the
// team has recorded.
//
// `create()` and `update()` propose changes that a lawyer reviews. Later reads already reflect a
// proposal, so keep working without waiting for it; a proposal the lawyer rejects disappears.
//
// Each case can hold documents (petitions, contracts, decisions, scanned records) whose text the firm
// has already extracted, OCR included. Search them with `buscarDocumentos()` and read them with
// `lerDocumento()` before relying on what they say.
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

/** Where a document's text stands. */
export type StatusDocumento =
  /** Still being read (OCR can take minutes for long scans). */
  | "processando"
  /** Its text can be read and searched. */
  | "pronto"
  /** It holds no readable text, e.g. a scan while OCR is unavailable. */
  | "sem_texto"
  /** Reading it failed. */
  | "erro";

/** A document stored in a case. */
export interface DocumentoInfo {
  /** Pass to `lerDocumento()`. */
  id: string;
  casoId: string;
  /** File name, e.g. "peticao-inicial.pdf". */
  nome: string;
  /** MIME type of the original file. */
  tipo: string;
  /** Size of the original file, in bytes. */
  tamanho: number;
  status: StatusDocumento;
  /** Page count, for PDFs. */
  paginas?: number;
  /** A caveat about the text, e.g. pages OCR could not transcribe. */
  aviso?: string;
  /** Upload time, epoch milliseconds. */
  criadoEm: number;
}

/** A window of a document's text. Scanned pages are marked "--- Página N ---". */
export interface TrechoDocumento {
  documentoId: string;
  texto: string;
  /** Character offset of `texto` within the whole text. */
  inicio: number;
  /** Length of the whole text, in characters. */
  total: number;
  /** True when this window reaches the end of the text. */
  fim: boolean;
}

/** A search hit: the best passage of one document. Matched words are wrapped in «». */
export interface ResultadoBusca {
  documentoId: string;
  casoId: string;
  nome: string;
  trecho: string;
}

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

  /** The documents of a case, newest first. */
  listDocumentos(casoId: string): Promise<DocumentoInfo[]>;

  /**
   * Reads a document's text, `limite` characters from `inicio` (defaults 0 and 40,000; at most
   * 100,000). Call again from `inicio + texto.length` until `fim` to read a long document. Returns
   * null when no document has this id.
   */
  lerDocumento(
    documentoId: string,
    janela?: { inicio?: number; limite?: number },
  ): Promise<TrechoDocumento | null>;

  /**
   * Full-text search over the documents, ignoring accents and case; every word must appear. Returns
   * up to 20 documents, best match first, optionally limited to one case.
   */
  buscarDocumentos(consulta: string, filtro?: { casoId?: string }): Promise<ResultadoBusca[]>;
}
