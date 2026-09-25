// Courts: their MNI endpoints (first and second instance) and DataJud index names. The MNI list is a
// starting point: courts move and block these endpoints, so admins can correct them on the page and
// the diagnostic checks each one.

import { tribunalDoCnj } from "../../pesquisa/julgado.js";

export type EndpointMni = { tribunal: string; grau: 1 | 2; url: string };

/** Known PJe MNI endpoints. Checked from the Cloudflare network by the admin diagnostic. */
export const ENDPOINTS_MNI_PADRAO: EndpointMni[] = [
  // The WSDL names pje.tjmg.jus.br, which redirects SOAP calls to its login page; the same
  // service answers on the public-consultation host (checked in September 2026).
  { tribunal: "TJMG", grau: 1, url: "https://pje-consulta-publica.tjmg.jus.br/pje/intercomunicacao" },
  { tribunal: "TJMG", grau: 2, url: "https://pje2.tjmg.jus.br/pje/intercomunicacao" },
  { tribunal: "TJBA", grau: 1, url: "https://pje.tjba.jus.br/pje/intercomunicacao" },
  { tribunal: "TJBA", grau: 2, url: "https://pje2g.tjba.jus.br/pje/intercomunicacao" },
  { tribunal: "TJPE", grau: 1, url: "https://pje.tjpe.jus.br/1g/intercomunicacao" },
  { tribunal: "TJPE", grau: 2, url: "https://pje.tjpe.jus.br/2g/intercomunicacao" },
  { tribunal: "TJCE", grau: 1, url: "https://pje.tjce.jus.br/pje1grau/intercomunicacao" },
  { tribunal: "TJCE", grau: 2, url: "https://pje.tjce.jus.br/pje2grau/intercomunicacao" },
  { tribunal: "TJPA", grau: 1, url: "https://pje.tjpa.jus.br/pje/intercomunicacao" },
  { tribunal: "TJPA", grau: 2, url: "https://pje.tjpa.jus.br/pje-2g/intercomunicacao" },
  { tribunal: "TJRN", grau: 1, url: "https://pje1g.tjrn.jus.br/pje/intercomunicacao" },
  { tribunal: "TJRN", grau: 2, url: "https://pje2g.tjrn.jus.br/pje/intercomunicacao" },
  { tribunal: "TJPB", grau: 1, url: "https://pje.tjpb.jus.br/pje/intercomunicacao" },
  { tribunal: "TJPB", grau: 2, url: "https://pje.tjpb.jus.br/pje2g/intercomunicacao" },
  { tribunal: "TJMA", grau: 1, url: "https://pje.tjma.jus.br/pje/intercomunicacao" },
  { tribunal: "TJMA", grau: 2, url: "https://pje2.tjma.jus.br/pje2g/intercomunicacao" },
  { tribunal: "TJPI", grau: 1, url: "https://pje.tjpi.jus.br/1g/intercomunicacao" },
  { tribunal: "TJDFT", grau: 1, url: "https://pje.tjdft.jus.br/pje/intercomunicacao" },
  { tribunal: "TJDFT", grau: 2, url: "https://pje2i.tjdft.jus.br/pje/intercomunicacao" },
  { tribunal: "TJES", grau: 1, url: "https://pje.tjes.jus.br/pje/intercomunicacao" },
  { tribunal: "TJMT", grau: 1, url: "https://pje.tjmt.jus.br/pje/intercomunicacao" },
  { tribunal: "TJGO", grau: 1, url: "https://pje.tjgo.jus.br/pje/intercomunicacao" },
  { tribunal: "TJRJ", grau: 1, url: "https://tjrj.pje.jus.br/1g/intercomunicacao" },
  { tribunal: "TRF1", grau: 1, url: "https://pje1g.trf1.jus.br/pje/intercomunicacao" },
  { tribunal: "TRF1", grau: 2, url: "https://pje2g.trf1.jus.br/pje/intercomunicacao" },
  { tribunal: "TRF3", grau: 1, url: "https://pje1g.trf3.jus.br/pje/intercomunicacao" },
  { tribunal: "TRF3", grau: 2, url: "https://pje2g.trf3.jus.br/pje/intercomunicacao" },
  { tribunal: "TRF5", grau: 1, url: "https://pje.jfpe.jus.br/pje/intercomunicacao" },
  { tribunal: "TRF6", grau: 1, url: "https://pje1g.trf6.jus.br/pje/intercomunicacao" },
];

/** The court a CNJ number belongs to ("TJMG", "TRT3", "TRF1", …). */
export function tribunalDoProcesso(numero: string): string | undefined {
  return tribunalDoCnj(numero);
}

/** DataJud's index for a court: "TJMG" -> "api_publica_tjmg", "TRT3" -> "api_publica_trt3". */
export function indiceDataJud(tribunal: string): string {
  return `api_publica_${tribunal.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
}

/** Normalizes what a user types as a court: "trt-3" -> "TRT3". */
export function normalizarTribunal(tribunal: string): string {
  return tribunal.toUpperCase().replace(/[\s-]/g, "");
}
