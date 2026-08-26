# Data contract

All source files share the integer revision in `data/CURRENT`. JSON files store it in their top-level `revision`; `captures.jsonl` stores it in the first metadata line; runtime stores it as `sourceRevision`.

## Capture

`captures.jsonl` is a snapshot JSONL file: one metadata line followed by one current record per capture ID. Initial capture writes append logically; status updates rewrite the snapshot through the WAL transaction. A repeated ID with identical text is idempotent. The same ID with different text is a conflict.

Required capture fields: `recordType`, `id`, exact `text`, `capturedAt`, server-owned `receivedAt`, `sourceType=browser_selection`, `processingStatus`, `processedAt`, `derivedTermIds`, and `derivedRecipeIds`.

## Terms, recipes, prompts

- Term: one independently replaceable visible control. It records both browsing `category` and system `responsibility`.
- Recipe: an ordered set of term IDs plus an immutable full-prompt snapshot derived from a capture/case.
- Prompt: a user-entered prompt intended for direct repeated copying. Derived image-analysis prompts belong in recipes.

Every entity has machine and human review fields. Human approval stores a canonical content hash. Time/review metadata does not participate in that hash; all published content fields do.

## Publication matrix

- Structurally invalid: reject the mutation.
- Machine-valid + human pending: preserve in source, show in workbench, exclude from runtime.
- Needs revision: preserve and isolate.
- Approved + current hash + valid dependencies: include in runtime.
- Approved recipe with unpublished term: reject hand-edited invalid data; API edits downgrade the dependent recipe in the same transaction.

## Limits

- Capture and full Prompt bodies: at most 48 KiB UTF-8.
- HTTP request body: at most 64 KiB.
- Term display name: at most 24 Unicode code points. This UI gate does not define semantic atomicity.
