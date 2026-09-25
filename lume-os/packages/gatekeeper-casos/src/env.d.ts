// Bindings and vars the deploy adds on top of wrangler.jsonc. Optional where local development runs
// without them (`pnpm dev-server` has no Workers AI), so the code must handle their absence.
declare namespace Cloudflare {
  interface Env {
    /** Workers AI, used for text-layer conversion and as the AI Gateway channel for OCR. */
    WORKERS_AI?: Ai;
    /** The deployment's AI Gateway name. */
    CF_AI_GATEWAY?: string;
    /** "true" when the gateway can reach Anthropic, which OCR needs. */
    CASOS_OCR?: string;
    /** The Claude model that transcribes scanned documents. */
    CASOS_OCR_MODEL?: string;
    /** Browser Rendering, for court sites that need a real browser (reCAPTCHA, bot protection). */
    BROWSER?: Fetcher;
    /**
     * Key for lawyers' PJe passwords (32 bytes, base64). The deploy generates it once and never
     * replaces it: a new key loses every stored password.
     */
    LUME_CHAVE_CREDENCIAIS?: string;
    /** Overrides the CNJ's public DataJud API key when the CNJ rotates it. */
    DATAJUD_API_KEY?: string;
  }
}
