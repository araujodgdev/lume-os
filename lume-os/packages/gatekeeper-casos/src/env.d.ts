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
  }
}
