# Casos

The law firm's case registry, built for Lume rather than taken from upstream. Each case records the client, the parties, the CNJ case number, the court, the area of law, the status, the responsible lawyers and a Markdown summary. Every lawyer of a deployment sees and edits the same cases. Because each firm runs its own deployment, the firm is the access boundary.

## What it provides

Like the Scheduler, Casos is an auto-provisioned gatekeeper whose account declares two things:

- **A management page** (`providesUi`) at `/gatekeepers/casos`, listed as "Casos" in the sidebar. Lawyers create, edit and delete cases there, and **Trabalhar neste caso** opens Home with a prompt that points the agent at the case.
- **An agent singleton** (`singleton`), bound as `CASOS` and typed by `CasosSession` in `src/types.d.ts`. The agent's catalog lists the firm's open cases (most recent 200) so it can find the one a lawyer means.

The agent reads through `list`, `get` and `findByNumero`, and each read is recorded as an observation. It writes only by proposing: `create` and `update` submit an action that a lawyer approves, rejects or later reverts in the workspace's activity queue. Until a lawyer decides, the proposing workspace reads the registry with its pending proposals applied, and nobody else sees them.

## Cofre: documents per case

Each case holds documents: PDFs (scans included), DOCX, spreadsheets, ODF, CSV, text and photos of documents, up to 50 MB each. The Casos page uploads and downloads them, shows the text read from each one, and searches their content. The agent reads them through `listDocumentos`, `lerDocumento` and `buscarDocumentos`, each recorded as an observation.

- **Storage.** Files live in the `COFRE` R2 bucket. `DocumentVault`, one SQLite Durable Object per sharing domain, keeps their metadata, the multipart state of uploads in progress, the OCR queue and an FTS5 index (`unicode61 remove_diacritics 2`, so "indebito" finds "indébito").
- **Transfer.** The page's sandboxed iframe has no network access, and its RPC crosses the Workshop's WebSocket as base64 under a 32M-character cap. Files therefore move as 5 MiB chunks: upload into an R2 multipart upload, download reassembled into a Blob. Uploads left unfinished for an hour are aborted.
- **Reading.** The vault's alarm reads one document, or one OCR batch, per run, and reschedules itself. That keeps each run short and resumes after restarts.
  - Text files are read directly.
  - Office and ODF files go through Workers AI `toMarkdown()`, which is free.
  - A PDF goes through `toMarkdown()` first. If it yields under 200 characters per page, it is a scan: `pdf-lib` cuts it into 10-page batches, and Claude transcribes one batch per run through the AI Gateway (`src/cofre/claude.ts`), writing `--- Página N ---` markers. A batch whose text overflows the output budget is halved and retried; pages the model declines are marked in the text and flagged on the document.
  - Photos are transcribed by Claude, since `toMarkdown()` only describes images.
  - A failed step is retried twice with backoff before the document is marked `erro`.
- **OCR availability.** The deploy sets `CASOS_OCR=true` only when the gateway is in the deployment's own account and lists the `anthropic` provider, and the gateway must hold an Anthropic key. Without it, scans are stored and downloadable but marked `sem_texto`. Under `pnpm dev-server` there is no Workers AI, so only text files are read.

## Layout

| File | Role |
| --- | --- |
| `src/types.d.ts` | The agent-facing API. `src/types.txt` is a symlink to it, served by `getTypeScriptTypes()`. |
| `src/cnj.ts` | CNJ number normalization and ISO 7064 mod 97-10 check digits. |
| `src/caso.ts` | Validation of every input, change application, filters and sorting. Pure, so it is shared by the session, the page and the tests. |
| `src/registry.ts` | `CaseRegistry`, one SQLite Durable Object per sharing domain, holding the firm's cases. |
| `src/cofre/tipos.ts` | Accepted formats, signatures, chunk sizes, index passages and the FTS query builder. Pure, and shared with the page. |
| `src/cofre/vault.ts` | `DocumentVault`: uploads, the reading pipeline, full-text search and deletion. |
| `src/cofre/extrator.ts` | What the vault needs from outside: `toMarkdown()`, `pdf-lib` and Claude OCR, behind one interface the tests replace. |
| `src/cofre/claude.ts` | Claude OCR over the AI Gateway binding. |
| `src/casos.ts` | Vendor, account, verifier, the page's `CasosManagementApi`, and `CasosGatekeeper`: the per-workspace facet that stores proposals, applies approved ones and simulates pending ones. |
| `app/` | The page, a single-file React app bundled into `src/generated/app.txt` by `build-app.mjs`. |

## Deployment

The starter's `scripts/deploy.ts` deploys it as `workers.casos` and binds it as `GATEKEEPER_CASOS` on the router and the Workshop. It also gives the Worker the `COFRE` bucket (`resources.cofreBucket`, provisioned when `null`), the `WORKERS_AI` binding, and the OCR vars (`CF_AI_GATEWAY`, `CASOS_OCR`, `CASOS_OCR_MODEL` from `casos.ocrModel`). The Workshop binding carries `props.sharingDomain`, the same boundary as Context data (`context.sharingDomain`, or the public origin). Without props, as under `pnpm dev-server`, every account shares the `default` registry.

New accounts follow the admin's mode for auto-provisioned gatekeepers, which defaults to **optional**: each lawyer adds Casos from the Connectors page. Set Casos to **enabled** under `/admin` → Conectores to give it to everyone.

## Tests

```sh
pnpm --filter @gadgets/gatekeeper-casos test:run
```

`__tests__/` runs in workerd. `CofreTestHooks` installs a fake extractor, so the reading pipeline is tested without Workers AI or Claude; `__tests__/claude.test.ts` checks the exact request the OCR sends to the gateway. `CasosTestParent` in `__tests__/worker.ts` hosts the facet through `ctx.facets`, as the Overseer does, and records what it reports to the approval queue. `app/*.test.tsx` runs the page in jsdom.
