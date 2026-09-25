import { DownloadSimple, FileText, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { dividirParaPje, nomeParaPje, ziparPartes } from "./pje";
import {
  contarPartes,
  EXTENSOES_ACEITAS,
  type DocumentoCofre,
  type JanelaTexto,
  type UploadIniciado,
} from "../src/cofre/tipos";

/** The part of the Casos page capability this section uses. */
export type DocumentosClient = {
  documentos(casoId: string): Promise<DocumentoCofre[]>;
  iniciarUpload(casoId: string, arquivo: { nome: string; tamanho: number }): Promise<UploadIniciado>;
  enviarParte(uploadId: string, numero: number, bytes: Uint8Array): Promise<void>;
  concluirUpload(uploadId: string): Promise<DocumentoCofre>;
  cancelarUpload(uploadId: string): Promise<void>;
  textoDocumento(id: string, inicio?: number): Promise<JanelaTexto | null>;
  baixarParte(id: string, numero: number): Promise<Uint8Array>;
  excluirDocumento(id: string): Promise<void>;
};

/** How often the list refreshes while a document is still being read. */
export const INTERVALO_ATUALIZACAO_MS = 5_000;

type Envio = { nome: string; enviadas: number; partes: number; erro?: string };

/**
 * Uploads one file in the chunks the vault expects. Reads each chunk from the File as it goes, so a
 * 50 MB PDF never sits in memory twice.
 */
export async function enviarArquivo(
  api: DocumentosClient,
  casoId: string,
  arquivo: File,
  progresso: (enviadas: number, partes: number) => void,
): Promise<DocumentoCofre> {
  const { uploadId, partes, tamanhoParte } = await api.iniciarUpload(casoId, {
    nome: arquivo.name,
    tamanho: arquivo.size,
  });
  try {
    for (let n = 1; n <= partes; n++) {
      const bytes = new Uint8Array(
        await arquivo.slice((n - 1) * tamanhoParte, n * tamanhoParte).arrayBuffer(),
      );
      await api.enviarParte(uploadId, n, bytes);
      progresso(n, partes);
    }
    return await api.concluirUpload(uploadId);
  } catch (error) {
    await api.cancelarUpload(uploadId).catch(() => {});
    throw error;
  }
}

/** Saves bytes as a file through a temporary link (the frame allows downloads, not navigation). */
export function salvarArquivo(bytes: Uint8Array | Uint8Array[], nome: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob((Array.isArray(bytes) ? bytes : [bytes]) as BlobPart[], { type: tipo }));
  const link = document.createElement("a");
  link.href = url;
  link.download = nome;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function Documentos({
  api,
  casoId,
  limitePjeMb = 5,
}: {
  api: DocumentosClient;
  casoId: string;
  /** The firm's PJe per-file limit, for "Baixar para o PJe". */
  limitePjeMb?: number;
}) {
  const [documentos, setDocumentos] = useState<DocumentoCofre[]>([]);
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [erro, setErro] = useState<string>();
  const [aberto, setAberto] = useState<{ doc: DocumentoCofre; texto: JanelaTexto | null } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const carregar = useCallback(async () => {
    try {
      setDocumentos(await api.documentos(casoId));
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }, [api, casoId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const lendo = documentos.some((doc) => doc.status === "processando" || doc.status === "ocr");
  useEffect(() => {
    if (!lendo) return;
    const timer = window.setInterval(() => void carregar(), INTERVALO_ATUALIZACAO_MS);
    return () => window.clearInterval(timer);
  }, [lendo, carregar]);

  async function enviar(arquivos: FileList | null) {
    if (!arquivos?.length) return;
    setErro(undefined);
    const lista = [...arquivos];
    setEnvios(lista.map((arquivo) => ({
      nome: arquivo.name, enviadas: 0, partes: contarPartes(arquivo.size),
    })));
    for (const [i, arquivo] of lista.entries()) {
      const atualizar = (mudanca: Partial<Envio>) =>
        setEnvios((atual) => atual.map((envio, j) => (j === i ? { ...envio, ...mudanca } : envio)));
      try {
        await enviarArquivo(api, casoId, arquivo, (enviadas, partes) => atualizar({ enviadas, partes }));
      } catch (caught) {
        atualizar({ erro: messageOf(caught) });
      }
    }
    setEnvios((atual) => atual.filter((envio) => envio.erro));
    if (input.current) input.current.value = "";
    await carregar();
  }

  const [aviso, setAviso] = useState<string>();
  const [preparando, setPreparando] = useState<string>();

  async function bytesDe(doc: DocumentoCofre): Promise<Uint8Array> {
    const partes: Uint8Array[] = [];
    for (let n = 1; n <= contarPartes(doc.tamanho); n++) partes.push(await api.baixarParte(doc.id, n));
    const bytes = new Uint8Array(doc.tamanho);
    let offset = 0;
    for (const parte of partes) {
      bytes.set(parte, offset);
      offset += parte.byteLength;
    }
    return bytes;
  }

  async function baixar(doc: DocumentoCofre) {
    try {
      salvarArquivo(await bytesDe(doc), doc.nome, doc.mime);
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }

  /** Splits a PDF under the firm's PJe limit and saves the parts as a .zip (or the PDF if it fits). */
  async function baixarParaPje(doc: DocumentoCofre) {
    setErro(undefined);
    setAviso(undefined);
    setPreparando(doc.id);
    try {
      const { partes, avisos } = await dividirParaPje(await bytesDe(doc), limitePjeMb * 1024 * 1024, doc.nome);
      if (partes.length === 1) {
        salvarArquivo(partes[0].bytes, partes[0].nome, "application/pdf");
      } else {
        salvarArquivo(ziparPartes(partes), `${nomeParaPje(doc.nome)}_pje.zip`, "application/zip");
      }
      const limite = limitePjeMb.toLocaleString("pt-BR");
      setAviso([
        partes.length === 1
          ? `"${doc.nome}" já cabe no limite de ${limite} MB do PJe.`
          : `"${doc.nome}" foi dividido em ${partes.length} partes de até ${limite} MB.`,
        ...avisos,
      ].join(" "));
    } catch (caught) {
      setErro(messageOf(caught));
    } finally {
      setPreparando(undefined);
    }
  }

  async function excluir(doc: DocumentoCofre) {
    if (!window.confirm(`Excluir "${doc.nome}"? Não dá para desfazer.`)) return;
    try {
      await api.excluirDocumento(doc.id);
      await carregar();
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }

  async function verTexto(doc: DocumentoCofre) {
    try {
      setAberto({ doc, texto: await api.textoDocumento(doc.id) });
    } catch (caught) {
      setErro(messageOf(caught));
    }
  }

  return (
    <section aria-label="Documentos" className="flex flex-col gap-3 sm:col-span-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">
          Documentos
        </span>
        <button
          type="button"
          onClick={() => input.current?.click()}
          className="press inline-flex items-center gap-2 border border-kumo-line px-3 py-1.5 text-sm hover:bg-kumo-tint"
        >
          <UploadSimple size={14} /> Enviar documentos
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Arquivos para enviar"
          accept={EXTENSOES_ACEITAS.join(",")}
          onChange={(event) => void enviar(event.target.files)}
        />
      </div>

      {erro && <p role="alert" className="text-sm text-kumo-danger">{erro}</p>}
      {aviso && !erro && <p className="text-sm text-kumo-subtle">{aviso}</p>}

      {envios.map((envio) => (
        <p key={envio.nome} className={`text-sm ${envio.erro ? "text-kumo-danger" : "text-kumo-subtle"}`}>
          {envio.erro
            ? `Não foi possível enviar "${envio.nome}": ${envio.erro}`
            : `Enviando "${envio.nome}"… ${Math.round((envio.enviadas / envio.partes) * 100)}%`}
        </p>
      ))}

      {documentos.length === 0 && envios.length === 0 ? (
        <p className="border border-dashed border-kumo-line px-4 py-6 text-center text-sm text-kumo-subtle">
          Nenhum documento. Envie PDFs (inclusive digitalizados), DOCX, planilhas ou fotos de documentos.
        </p>
      ) : (
        <ul className="flex flex-col border-t border-kumo-line">
          {documentos.map((doc) => (
            <li key={doc.id} className="flex items-center gap-3 border-b border-kumo-line px-1 py-3">
              <FileText size={16} className="shrink-0 text-kumo-subtle" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{doc.nome}</p>
                <p className={`text-xs ${doc.status === "erro" ? "text-kumo-danger" : "text-kumo-subtle"}`}>
                  {[formatTamanho(doc.tamanho), doc.paginas ? `${doc.paginas} pág.` : null, statusLabel(doc)]
                    .filter(Boolean).join(" · ")}
                </p>
                {doc.aviso && <p className="text-xs text-kumo-subtle">{doc.aviso}</p>}
              </div>
              {doc.status === "pronto" && (
                <button type="button" onClick={() => void verTexto(doc)} className="text-sm text-kumo-link">
                  Ver texto
                </button>
              )}
              {doc.tipo === "pdf" && doc.status !== "enviando" && (
                <button
                  type="button"
                  onClick={() => void baixarParaPje(doc)}
                  disabled={preparando === doc.id}
                  className="text-sm text-kumo-link disabled:opacity-50"
                >
                  {preparando === doc.id ? "Preparando…" : "Baixar para o PJe"}
                </button>
              )}
              <IconButton label={`Baixar ${doc.nome}`} onClick={() => void baixar(doc)}>
                <DownloadSimple size={14} />
              </IconButton>
              <IconButton label={`Excluir ${doc.nome}`} onClick={() => void excluir(doc)}>
                <Trash size={14} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      {aberto && (
        <div role="dialog" aria-label={`Texto de ${aberto.doc.nome}`} className="border border-kumo-line bg-kumo-elevated">
          <div className="flex items-center justify-between border-b border-kumo-line px-3 py-2">
            <span className="truncate text-sm">{aberto.doc.nome}</span>
            <IconButton label="Fechar texto" onClick={() => setAberto(null)}>
              <X size={14} />
            </IconButton>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap p-3 font-sans text-sm">
            {aberto.texto?.texto || "Sem texto."}
          </pre>
          {aberto.texto && !aberto.texto.fim && (
            <p className="px-3 pb-2 text-xs text-kumo-subtle">
              Mostrando {aberto.texto.texto.length.toLocaleString("pt-BR")} de{" "}
              {aberto.texto.total.toLocaleString("pt-BR")} caracteres.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
    >
      {children}
    </button>
  );
}

export function statusLabel(doc: DocumentoCofre): string {
  switch (doc.status) {
    case "enviando":
      return "Enviando";
    case "processando":
      return "Lendo…";
    case "ocr":
      return doc.paginas
        ? `Lendo com OCR: ${doc.paginasLidas ?? 0} de ${doc.paginas} páginas`
        : "Lendo com OCR…";
    case "pronto":
      return "Pronto";
    case "sem_texto":
      return "Sem texto";
    case "erro":
      return `Erro: ${doc.erro ?? "falha na leitura"}`;
  }
}

function formatTamanho(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
