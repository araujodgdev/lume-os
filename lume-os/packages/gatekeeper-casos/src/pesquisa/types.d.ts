// Pesquisa searches Brazilian case law in the courts' own sources and keeps a record of every
// decision it returned, so citations can be checked.
//
// Never cite case law from memory: a decision, súmula or tema that did not come from `buscar()` may
// not exist. Search with `buscar()`, cite with the exact text `citar()` returns, and before
// delivering a piece run `verificar()` on it and fix or flag every citation that is not
// "confirmada". When a source reports "falhou", say so: it means that court could not be searched
// right now, not that it has no precedent.
//
// `salvarNoCaso()` proposes attaching a decision to a case, which a lawyer reviews.

/** Courts Pesquisa can search. */
export type TribunalPesquisa = "STF" | "STJ" | "TST" | "TJSP" | "TJAC" | "TJAL" | "TJAM" | "TJCE" | "TJMS";

/** A decision (or a binding thesis) as a court's own source published it. */
export interface Julgado {
  /** Stable identifier; pass it to `obter()`, `citar()` and `salvarNoCaso()`. */
  id: string;
  tribunal: string;
  /** "acordao" for a judgment; "tema" for a repetitive-appeal thesis (tese firmada). */
  tipo: "acordao" | "tema";
  /** Case class as the court abbreviates it, e.g. "REsp", "AgInt no AREsp", "AIRR", "Apelação Cível". */
  classe: string;
  /** Case number as the court shows it, e.g. "1990285" or "1001234-56.2023.8.26.0100". */
  numero: string;
  /** State of origin, when the court reports it. */
  uf?: string;
  orgaoJulgador?: string;
  relator?: string;
  /** Judgment date, "AAAA-MM-DD". */
  dataJulgamento?: string;
  /** Publication date, "AAAA-MM-DD". */
  dataPublicacao?: string;
  /** Where it was published, e.g. "DJe" or "DJEN". */
  veiculoPublicacao?: string;
  /** The headnote (ementa), verbatim. For a tema, the question and the thesis. */
  ementa: string;
  /** For a tema: the thesis as fixed, verbatim. */
  tese?: string;
  /** For a tema: its status, e.g. "Trânsito em Julgado" or "Afetado". */
  situacao?: string;
  /** The court's own page for it. Always give it to the lawyer. */
  url: string;
  /** Which source returned it. */
  fonte: string;
  /** When Pesquisa read it from the source, epoch milliseconds. */
  capturadoEm: number;
}

/** What to search for. */
export interface PedidoBusca {
  /** Free text: the legal question in the words a headnote would use, e.g. "dano moral negativação indevida". */
  consulta: string;
  /** Courts to search. Default: STF, STJ and TST. */
  tribunais?: TribunalPesquisa[];
  /** Judgments on or after this date, "AAAA-MM-DD". */
  desde?: string;
  /** Judgments on or before this date, "AAAA-MM-DD". */
  ate?: string;
  /** Results per court, 1 to 20. Default 5. */
  limite?: number;
}

/** How each source answered. */
export interface StatusFonte {
  fonte: string;
  tribunais: string[];
  /**
   * "ok": results came back. "sem_resultados": the source answered with nothing. "falhou": the
   * source could not be searched (it is down or blocking) — this says nothing about the case law.
   */
  status: "ok" | "sem_resultados" | "falhou";
  erro?: string;
}

export interface ResultadoPesquisa {
  resultados: Julgado[];
  fontes: StatusFonte[];
}

/** One citation found in a text, checked against the courts' sources. */
export interface CitacaoVerificada {
  /** The citation as written. */
  trecho: string;
  tribunal?: string;
  classe?: string;
  numero?: string;
  tipo: "acordao" | "sumula" | "tema";
  /**
   * "confirmada": the decision exists and what the text says about it matches.
   * "divergente": it exists, but the text gets something wrong (see `observacao`).
   * "nao_encontrada": the court's source answered and has no such decision.
   * "nao_verificavel": the court has no source here or it could not be reached; check by hand.
   */
  status: "confirmada" | "divergente" | "nao_encontrada" | "nao_verificavel";
  /** The matching decision, when one was found. */
  julgado?: Julgado;
  observacao: string;
}

export interface RelatorioCitacoes {
  citacoes: CitacaoVerificada[];
  /** One line, e.g. "5 citações: 3 confirmadas, 1 divergente, 1 não verificável." */
  resumo: string;
}

/** A decision attached to a case. */
export interface JulgadoSalvo {
  casoId: string;
  julgado: Julgado;
  /** Why it matters to the case. */
  nota?: string;
  salvoEm: number;
}

/** Case-law research. */
export interface PesquisaSession {
  /** Searches the courts. Every result can be cited; check `fontes` for courts that failed. */
  buscar(pedido: PedidoBusca): Promise<ResultadoPesquisa>;

  /** A decision previously returned by `buscar()` or `verificar()`, or null. */
  obter(id: string): Promise<Julgado | null>;

  /**
   * The citation to put in a piece, e.g. "STJ, REsp 1.990.285, Rel. Min. Moura Ribeiro, Terceira
   * Turma, j. 27/10/2025, DJEN 30/10/2025". Use it verbatim. Throws for an unknown id.
   */
  citar(id: string): Promise<string>;

  /**
   * Finds every decision, súmula and tema cited in `texto` (plain text or HTML, e.g. a Documento's
   * blocks joined) and checks each against the courts' sources.
   */
  verificar(texto: string): Promise<RelatorioCitacoes>;

  /** Proposes attaching a decision to a case, with a note on why it matters. */
  salvarNoCaso(casoId: string, julgadoId: string, nota?: string): Promise<void>;

  /** Decisions attached to a case, most recent first. */
  salvos(casoId: string): Promise<JulgadoSalvo[]>;
}
