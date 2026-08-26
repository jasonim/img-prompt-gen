# Project Agent Rules

## Scope

This repository contains a local-only Chrome MV3 image-prompt library. Keep the product focused on capture, organization, review, compilation, and retrieval. Do not add accounts, cloud sync, payments, collaboration, random prompt generation, or remote LLM calls without a separate approved plan.

## Directory ownership

- `extension/`: Chrome MV3 code and side-panel UI.
- `server/`: loopback-only Node.js service, data validation, pairing, storage, and compilation.
- `data/captures.jsonl`: raw capture source of truth. Preserve the exact user-selected text.
- `data/terms.json`, `data/recipes.json`, `data/prompts.json`: editable source-of-truth collections.
- `data/runtime/library.json`: generated output. Never edit it by hand.
- `data/.secrets/`, `data/.txn/`, and `data/.revision.lock`: private/transactional state. Never commit, export, or log their contents.
- `tests/fixtures/` and OS temporary directories: test data only. Tests must not mutate `data/`.

## Data and privacy boundaries

- Store only text the user explicitly selected or entered, timestamps, source type, review state, and traceability IDs.
- Do not store page URLs, page titles, HTML, cookies, account information, browsing history, or clipboard history.
- Do not trim, summarize, or rewrite raw capture text. Trimming is allowed only to decide whether input is blank.
- Keep the service bound to `127.0.0.1`; reject `0.0.0.0`.
- Never log prompt/capture bodies, bearer tokens, approval hashes, or pairing secrets in request/application logs. Printing the one-time pairing secret only from the explicit startup/reset command is allowed because that is how the local user completes pairing.
- Render all user text with `textContent`/DOM nodes. Do not use `innerHTML`.

## Review and runtime rules

- Machine validation and human review are separate facts.
- `pending` and `needs_revision` are valid source states but never enter runtime.
- Human approval must be explicit and bound to the canonical content hash.
- Any published-field edit invalidates approval. Term edits also downgrade dependent approved recipes.
- Recipes may not publish with missing or unpublished term references.
- Every cross-file read/write uses the revision lock and committed `data/CURRENT` revision.

## Testing

- Follow TDD: establish an intentional RED before production logic, then make the same test GREEN.
- `npm run verify` is the automated completion gate.
- Maintain at least 80% line/function/branch coverage for executable project code where Node coverage can instrument it.
- Keep tests isolated in temporary directories and random ports.
- Automated tests do not count as Chrome manual acceptance.

## Completion standard

Report separately: automated tests, machine validation, service health/library readback, and Chrome manual verification. Never claim browser acceptance unless the extension was actually loaded and exercised in Chrome.
