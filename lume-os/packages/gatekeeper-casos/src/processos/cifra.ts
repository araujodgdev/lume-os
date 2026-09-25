// Lawyers' PJe passwords at rest: AES-256-GCM with a key from the Worker secret
// LUME_CHAVE_CREDENCIAIS, a random IV per record, and the owner and court as associated data, so a
// ciphertext moved to another user or court fails to open.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function deBase64(texto: string): Uint8Array {
  return Uint8Array.from(atob(texto), (c) => c.charCodeAt(0));
}

/** The key from the secret (32 bytes, base64). Throws a clear message when it is missing. */
export async function chaveCredenciais(segredo: string | undefined): Promise<CryptoKey> {
  if (!segredo) throw new Error("O servidor ainda não tem a chave de credenciais (LUME_CHAVE_CREDENCIAIS). Refaça o deploy.");
  const bruto = deBase64(segredo);
  if (bruto.length !== 32) throw new Error("LUME_CHAVE_CREDENCIAIS deve ter 32 bytes em base64.");
  return crypto.subtle.importKey("raw", bruto, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function contexto(usuario: string, tribunal: string): Uint8Array {
  return encoder.encode(`lume/pje/${usuario}/${tribunal}`);
}

export async function cifrar(chave: CryptoKey, texto: string, usuario: string, tribunal: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: contexto(usuario, tribunal) },
    chave,
    encoder.encode(texto),
  ));
  return `${base64(iv)}.${base64(cifrado)}`;
}

export async function decifrar(chave: CryptoKey, registro: string, usuario: string, tribunal: string): Promise<string> {
  const [iv, dados] = registro.split(".");
  if (!iv || !dados) throw new Error("Credencial corrompida.");
  const aberto = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: deBase64(iv), additionalData: contexto(usuario, tribunal) },
    chave,
    deBase64(dados),
  );
  return decoder.decode(aberto);
}
