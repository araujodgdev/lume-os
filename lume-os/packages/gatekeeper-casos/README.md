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

## Pieces in the firm's template

When a lawyer asks for a piece "em Word", the agent calls `CASOS.gerarPeca({ casoId, titulo, html })` with the HTML of a Documentos file (its `getDocument()` blocks, joined). The Casos Worker builds a `.docx` and proposes saving it to the case's Cofre. The action (`casos.peca`) is auto-approvable, since it only adds a document the lawyer asked for, and reverting it deletes the document. Until a lawyer decides, the file waits in R2 under `pendentes/` and shows in the agent's `listDocumentos()` as pending.

- **Template.** An admin uploads the firm's letterhead as a `.docx` in the Casos page ("Modelo do escritório e PJe"); until then a built-in forensic template is used (Times New Roman 12, 1.5 spacing, 3/2 cm margins, 2.5 cm first-line indent). The piece goes where the template says `{{conteudo}}`, or at the end of the body. `{{cliente}}`, `{{processo}}`, `{{tribunal}}`, `{{orgao_julgador}}`, `{{cidade}}` and `{{data}}` (in full, Brasília time) are filled from the case and the firm's settings, in the body, headers and footers.
- **Editing, not regenerating.** `src/pecas/modelo.ts` edits the template's XML inside its ZIP (`fflate`), so its styles, headers, footers, page setup and letterhead images survive untouched. Word often splits a placeholder across runs; filling handles that, keeping the formatting of the run where the field starts. Numbering definitions and images are added next to the template's own, in schema order.
- **Conversion.** `src/pecas/ooxml.ts` turns the Documentos HTML (`htmlparser2`) into paragraphs: headings use the template's own "heading 1-3" styles, found by name so localized ids like `Ttulo1` work, and fall back to bold text; bold, italic, underline, strike, real Word lists (restarting per list), quotes as ABNT long-citation blocks, images from data URLs, alignment, and tables as tab-separated rows. Fonts, sizes and colors typed in the editor are dropped on purpose: typography is the template's.

## PJe

Each PDF in the Cofre has **Baixar para o PJe**. In the browser, `app/pje.ts` splits it with `pdf-lib` into parts under the firm's limit (5 MB by default; admins change it next to the template) and saves them as `nome_parte_01.pdf`, `nome_parte_02.pdf`… in a `.zip`, with PJe-safe names. Page sizes are estimated one page at a time and every part is checked for real, so parts never exceed the limit; a page that alone is larger is flagged. A PDF already under the limit downloads as is.

## Agenda

The same Worker serves a second vendor, `AgendaVendor`: the firm's calendar of procedural deadlines, hearings, tasks and meetings, linked to cases. It is auto-provisioned like Casos, with its own page at `/gatekeepers/agenda` and its own agent singleton, bound as `AGENDA` and typed by `AgendaSession` in `src/agenda/types.d.ts`. It shares the Casos Worker because entries point at cases: they take the case's court for the calendar and the case's responsible lawyers when they name none. The page is the same bundle, told apart by `<html data-app="agenda">`.

- **Counting.** `src/agenda/prazos.ts` turns a rule (how the notice arrived, its date, the length, the procedure, doubling, defendant in custody) into a due date plus `memoria`, the steps in Portuguese, which the page and approvals show with "confira antes de protocolar".
  - When the notice counts as made: gazette (DJe) publication is the working day after it is made available; a portal notice counts when opened or, unopened, 10 calendar days after it was sent; any other notice counts on the date given.
  - How days are counted: CPC, CLT and small-claims deadlines count working days from the next working day. CPP deadlines count calendar days from the next working day, and one that ends on a closed day moves to the next working day.
  - The recess: from 20/12 to 20/01 counting is suspended, except in criminal cases with a defendant in custody.
- **Calendar.** `src/agenda/calendario.ts` computes national holidays, including Carnival, Good Friday and Corpus Christi from Easter, and Consciência Negra from 2024. The firm registers local holidays and suspensions per court and district. A district-only holiday applies only to entries with that district: when in doubt a day is not skipped, so the due date comes earlier, never later.
- **Recounting.** `AgendaStore`, one SQLite Durable Object per sharing domain, keeps entries and holidays. Registering or removing a holiday recounts every pending counted deadline, and each change is appended to its `memoria`. A deadline is also recounted when a proposal is approved, in case holidays changed meanwhile.
- **Proposals.** `AgendaGatekeeper` works like the Casos facet.
  - Kinds: `agenda.criar` and `agenda.alterar` (which also covers `concluir` and `cancelar`) are auto-approvable. `agenda.feriado` is not, since it moves the whole firm's deadlines.
  - Every kind reverts, and pending proposals are simulated in the proposing workspace.
  - The agent's catalog lists what is due in the next 10 working days.
- **Page.** Lawyers edit directly, without approvals.
  - The list is grouped into overdue, today, the next 7 working days and later, and flags entries nobody would be reminded of.
  - The form recounts the deadline as the lawyer types.
  - Only admins register holidays.
  - The Casos page shows each case's pending entries.
- **Who is viewing.** The Workshop passes the viewer's login in `AppUiContext.username` (a Lume kernel change), which the page uses for "Só os meus". Responsible lawyers are logins, as in Casos.

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
| `src/pecas/ooxml.ts` | Documentos HTML to WordprocessingML paragraphs. |
| `src/pecas/modelo.ts` | Template validation, field filling, body insertion, numbering and images; the built-in forensic template. |
| `src/pecas/campos.ts` | Field values from the case and the firm's settings. |
| `app/pje.ts` | Splitting PDFs under the PJe limit, in the browser. |
| `src/agenda/calendario.ts` | Civil dates, national holidays, local holidays by court and district, working days. Pure, and shared with the page. |
| `src/agenda/prazos.ts` | Deadline counting and its `memoria`. |
| `src/agenda/compromisso.ts` | Validation of entries, changes, filters and holidays; dating an entry from its rule. |
| `src/agenda/store.ts` | `AgendaStore`: entries, holidays and recounting. |
| `src/agenda/agenda.ts` | The Agenda's vendor, account, `AgendaManagementApi` and `AgendaGatekeeper` facet. |
| `src/agenda/types.d.ts` | The agent-facing Agenda API, served through the `types.txt` symlink. |
| `src/casos.ts` | Vendor, account, verifier, the page's `CasosManagementApi`, and `CasosGatekeeper`: the per-workspace facet that stores proposals, applies approved ones and simulates pending ones. |
| `app/` | The page, a single-file React app bundled into `src/generated/app.txt` by `build-app.mjs`. |

## Deployment

The starter's `scripts/deploy.ts` deploys it as `workers.casos` and binds it as `GATEKEEPER_CASOS` on the router and the Workshop, and as `GATEKEEPER_AGENDA` (entrypoint `AgendaVendor`, same props) on the Workshop. It also gives the Worker the `COFRE` bucket (`resources.cofreBucket`, provisioned when `null`), the `WORKERS_AI` binding, and the OCR vars (`CF_AI_GATEWAY`, `CASOS_OCR`, `CASOS_OCR_MODEL` from `casos.ocrModel`). The Workshop binding carries `props.sharingDomain`, the same boundary as Context data (`context.sharingDomain`, or the public origin). Without props, as under `pnpm dev-server`, every account shares the `default` registry.

New accounts follow the admin's mode for auto-provisioned gatekeepers, which defaults to **optional**: each lawyer adds Casos from the Connectors page. Set Casos and Agenda to **enabled** under `/admin` → Conectores to give them to everyone.

## Tests

```sh
pnpm --filter @gadgets/gatekeeper-casos test:run
```

`__tests__/` runs in workerd. `CofreTestHooks` installs a fake extractor, so the reading pipeline is tested without Workers AI or Claude; `__tests__/claude.test.ts` checks the exact request the OCR sends to the gateway. `CasosTestParent` in `__tests__/worker.ts` hosts the facet through `ctx.facets`, as the Overseer does, and records what it reports to the approval queue; `AgendaTestParent` does the same for the Agenda. `__tests__/prazos.test.ts` checks the counting rules against dates worked out by hand. `app/*.test.tsx` runs the page in jsdom.
