// What the Intimações page shows, shared by the store and the page (no Workers imports).

/** A credential as the page sees it: never the password. */
export type CredencialVisivel = {
  tribunal: string;
  cpf: string;
  criadaEm: number;
  verificadaEm?: number;
  verificacao?: string;
};

/** An OAB registration: number and state. */
export type Oab = { numero: string; uf: string };
/** One use of a lawyer's credential. */
export type RegistroAuditoria = { tribunal: string; operacao: string; resultado: string; quando: number };
/** When tracking last ran and what failed. */
export type EstadoSincronia = { ultima?: number; erros: { fonte: string; erro: string; quando: number }[] };
/** A lawyer's tracking preferences. */
export type PreferenciasProcessos = { resumoAgente: boolean };
/** One source checked by the admin diagnostic. */
export type ItemDiagnostico = { fonte: string; status: "ok" | "falhou"; detalhe: string; ms: number };

/** A Cofre document saved from an opened notice. */
export type DocumentoSalvo = { id: string; nome: string };
