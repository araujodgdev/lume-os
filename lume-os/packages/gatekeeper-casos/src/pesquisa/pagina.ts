// Types the Pesquisa page shares with the Worker, kept free of Worker-only imports.

export type EstadoImportacao = {
  arquivosImportados: number;
  arquivosPendentes: number;
  julgadosStj: number;
  temasStj: number;
  ultimoArquivo?: string;
  ultimaImportacao?: number;
  erro?: string;
};

/** One source's health, for the admin diagnostic. */
export type DiagnosticoFonte = {
  fonte: string;
  tribunal: string;
  status: "ok" | "sem_resultados" | "falhou";
  ms: number;
  erro?: string;
  exemplo?: string;
};
