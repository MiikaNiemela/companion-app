# Plan — conversation history view

Working document. Goal: a scrollable view of the past conversation with a companion, backed by a unified chat-entry format and a shared storage abstraction.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) (concerns chapter), [FRONTEND.md](FRONTEND.md).

## Starting position

- History lives in a Redis sorted set keyed `${companion}-${model}-${userId}`, scored by timestamp ([memory.ts:114-147](../src/app/utils/memory.ts#L114-L147)).
- The only reader, `readLatestHistory`, joins the last 30 entries into a single string for prompting. Nothing exposes history to the browser.
- [ChatBlock.tsx](../src/components/ChatBlock.tsx) renders **one** block (text / image / audio / video). It has no notion of speaker, turn, or sequence, and is the right leaf renderer to keep.

**Blocking finding — entries are not written in one format.** Each model route invents its own:

| Route | User turn | Companion turn |
| --- | --- | --- |
| `chatgpt`, `ollama` | `Human: …\n` | bare reply text, no prefix |
| `llama3-8b` | `### Human: …\n` | `### <Name>: …` |
| `llama3-70b` | `User: …\n` | `<Name>: …` |
| seeded turns (from character file) | `Human: …`, `User: …` or `### Human:` on its own line, and turns not reliably one entry each | `<Name>: …` |

Nothing can render this reliably without a normalisation step, and the divergence exists only because the conversation pipeline is copy-pasted per model route with no shared write path. **Unifying the entry format is therefore the first work item, not a detail of the read path.**

## Sequencing

Four phases, in order. Each is independently shippable.

- [x] **Phase 0** — Framework upgrade
- [x] **Phase 1** — Unified chat-entry storage
- [ ] **Phase 2** — Server-side read path
- [ ] **Phase 3** — History UI

---

### Phase 0 — Framework upgrade (do first)

Rationale: any API-surface change is cheaper to make once, on the target version. The codebase is small, so upgrading now means less code to migrate than after the feature lands.

**Version policy:** core runtimes are pinned by major and taken to their latest release within it — **Node 24.x** and **React 18.x** (18.3.x). The React 18 pin sets the framework ceiling: the Next.js App Router requires React 19 from v15 onward, so the target is the **latest Next 14** (14.2.x), not the current major. Moving past it is a separate, future React 19 upgrade.

Target versions:

| Package | Current | Target |
| --- | --- | --- |
| Node (Dockerfile `NODE_VERSION`) | 18.8.0 | 24.x (latest LTS patch) |
| `react`, `react-dom` | 18.2.0 | 18.3.x (latest 18) |
| `next` | ^13.5.11 | 14.2.x (latest 14; must be ≥ 14.2.25 for Clerk v6's peer range) |
| `eslint-config-next` | ^13.5.11 | 14.2.x (match `next`) |
| `@clerk/nextjs` | ^4.21.9-snapshot | 6.x (latest) |
| `@clerk/clerk-sdk-node` | ^4.10.12 | **remove** — deprecated; replaced by `clerkClient` from `@clerk/nextjs/server` |
| `ai` (Vercel AI SDK) | ^2.1.3 | 5.x (latest) |
| `@ai-sdk/react` | — | add (2.x, ships with AI SDK 5; supports React ^18) |
| `@types/node` | 20.2.5 | 24.x |
| `@types/react`, `@types/react-dom` | 18.2.x | latest 18 |

- [x] Node 18.8.0 → 24.x: bump the Dockerfile `NODE_VERSION` ARG and `@types/node`; add an `engines` field so the local/dev version can't silently drift from the image.
- [x] Package update:  Next.js 13.5 → 14.2.x; React 18.2.0 → 18.3.x. Stays within both pinned majors; App Router APIs are stable across 13 → 14.
- [x] Package update: `@clerk/nextjs` 4.x → 6.x. 
- [x] Rewrite: `authMiddleware` is superseded by `clerkMiddleware` + `createRouteMatcher` - [middleware.ts](../src/middleware.ts) must be rewritten. Treat this as the highest-risk item: it is the app's only page-level gate. Also removes `@clerk/clerk-sdk-node` (imported by [text/route.ts](../src/app/api/text/route.ts) and all four model routes for the phone-number lookup) in favour of `clerkClient` from `@clerk/nextjs/server`.
- [x] Package update: `ai` 2.x → 5.x. 
- [x] Rewrite: The React hooks moved to the separate `@ai-sdk/react` package and `StreamingTextResponse` was removed in favour of the newer stream-response helpers — affects [QAModal.tsx](../src/components/QAModal.tsx) and every model route.
- [x] `experimental.serverActions` in [next.config.js](../next.config.js) is stable in Next 14; drop the flag.
- [x] Re-run `next lint` and a full manual pass: sign-in, gallery, one chat per backend. (`eslint-config-next` 14 still uses `.eslintrc` — the flat-config migration only becomes forced at Next 15 / ESLint 9, i.e. not in this phase.)

Not in this phase, because it is a Next 15 change and the target is 14: the async request APIs (`headers()`, `cookies()`, `params`, `searchParams` becoming async). It moves to the future React 19 / Next 15+ item below.

Confirm each item against the official migration guides during the work rather than trusting this list — it is a scope sketch, not a verified changelog. Every version-specific claim here needs checking, and "latest within the major" means latest at execution time, not the patch numbers current when this was written.

**Exit criterion:** the app behaves exactly as before on the new stack. No feature work in this phase.

---

### Phase 1 — Unified chat-entry storage

Fix the cause, not the symptom: one write path, one format, shared by every model route.

- [x] Define the entry format in one place — [transcript.ts](../src/app/utils/transcript.ts):
  - `type Turn = { speaker: "user" | "companion"; text: string; at?: number }`
  - `formatEntry(turn, companionName): string` — the single writer of the on-the-wire prefix. Canonical format is `Human: …` / `<Name>: …`, no trailing newline.
  - `parseEntry(raw, companionName): Turn` — tolerant reader: strips an optional `### `, maps `Human:`/`User:` → user, `<Name>:` → companion, no prefix → companion, tolerates a label on its own line, trims trailing newline
  - `parseTranscript(entries, companionName, scores?): Turn[]` — drops entries that are empty after their label, and carries the sorted-set score into `Turn.at` when the caller read scores (Phase 2 needs that).
  - `parseTranscriptText(text, companionName): Turn[]` — splits a character file's seed chat into turns *by label* rather than by delimiter; see the seeding note below.
  - `stripSpeakerPrefix(text, companionName)` — replaces the three hand-rolled copies of "drop a leading `Name:`" that had accumulated in the routes.
  - Pure and dependency-free — the one part of this feature that is trivially testable.
- [x] Route the writes through it: `MemoryManager.writeTurn(turn, companionKey)` formats and appends; `writeToHistory` stays as the raw append. Every route stops hand-building `"Human: " + prompt`, `"### " + name + ": "`, `"User: "`.
- [x] **Do not change what the model sees.** The prompt is still built from the joined string, and no route re-adds `###` markers: `meta-llama-3-*-instruct` applies its own chat template and `llama3-70b` was already prompting without them. Verified live against all four backends (`chatgpt`/Alex, `ollama`/Ruffy, `llama3-8b`/Rosie, `llama3-70b`/Evelyn) — each answered in character, and the joined transcript is character-identical to the old one apart from the labels themselves.
- [x] Existing Redis data keeps the old formats. `parseEntry` handles every variant above indefinitely — there is no migration and no way to run one without a user-data script.
- [x] Seeding normalises too, so a *new* user's history is canonical from the first turn. `seedChatHistory` lost its `delimiter` parameter: splitting on `"\n\n"` merged a user turn and the reply to it into one entry for three of the five character files, which would have rendered as one lopsided turn in Phase 3.

`chatgpt` gained the "do not begin your reply with your own name" instruction the other routes already carried, because labelling companion turns in the stored transcript gives the model one more reason to imitate the label. Every route also strips such a label defensively before storing — which `ollama`'s local model needed on the first live run.

**Note on scope:** this phase touches all four model routes because the pipeline is duplicated four times. Extracting the whole pipeline into a shared module is the correct fix and is explicitly **out of scope** — see future items.

---

### Phase 2 — Server-side read path

- [ ] `MemoryManager.readHistoryEntries(companionKey, limit)` — returns `string[]`, optionally with scores (`zrange({ withScores: true })`) so turns can carry timestamps. Leave `readLatestHistory` untouched so prompting behaviour cannot regress.
- [ ] `getHistory(companionName)` server action in [actions.ts](../src/components/actions.ts):
  - resolve the user with Clerk `currentUser()`
  - resolve `modelName` from `companions.json` via `ConfigManager` — **never accept it from the client**, it is half the Redis key
  - read → `parseTranscript` → return a typed `Turn[]` (not the raw-JSON-string pattern the existing action uses)
- [ ] **Server Action, not an API route.** Server actions post to a page route, which middleware protects; a new `/api/history` would land on the public API surface and need hand-rolled auth like every other route.

**Decision — seeded turns:** shown as ordinary history for now. The data carries no marker distinguishing seeded from real turns, and inventing one retroactively is not possible. Adding a real message marker to newly written entries, and using it in the history view, is a future item.

---

### Phase 3 — History UI

- [ ] `ChatTurn.tsx` — wraps `ChatBlock` with speaker attribution and alignment. `ChatBlock` itself is unchanged; this is the missing layer between "one block" and "a conversation".
- [ ] `ChatHistory.tsx` — `flex flex-col` list inside a `max-h-… overflow-y-auto` container; auto-scroll to bottom via a bottom-anchor ref + effect on turn count, with a "user has scrolled up" guard so streaming does not yank them back. Explicit loading, empty, and error states — do not copy the gallery's silent-catch pattern.
- [ ] `QAModal.tsx` rewiring:
  - load history in an effect keyed on `open` + `example.name`
  - hold `turns` in state; append an optimistic user turn on submit
  - render the in-flight completion as a trailing companion turn (the `responseToChatBlocks` call moves into `ChatTurn`)
  - commit the finished reply to `turns` on the completion hook's finish callback
  - reset on close, alongside the existing `stop()`
  - layout flips: scrollable history above, input pinned below
- [ ] Manual verification: empty history; a long history that scrolls; a companion whose stored history uses the old `###` format; close and reopen mid-stream.

---

## Future development items

Recorded here so the decisions are visible; none are in scope for this work.

- **Message markers in stored entries.** Entries carry no structured metadata — no speaker field, no seeded/real flag, no id. Adding a marker to newly written entries would let the history view distinguish seeded turns and drop the prefix-sniffing parser.
- **History depth and paging.** The 30-entry cap is a prompting constraint that the read path currently inherits. A configurable limit and "load older" (feasible via `zrange` byScore with an offset) belong to a later iteration.
- **Sorted-set semantics corrupt the transcript.** History is a Redis *sorted set*, so two identical entries collapse into one member and the repeat merely re-scores the original — silently moving that turn to the end of the conversation. Invisible while prompting, obvious once rendered. The whole store/retrieve design (list vs. set, entry schema, retention, deletion) wants rewriting; not now.
- **Shared conversation pipeline.** The four model routes are near-identical ~250-line copies. Phase 1 unifies only the write format; auth, rate limiting, memory access, prompt assembly, and error handling remain duplicated per route.
- **History lifecycle.** No expiry, no cap, no delete or export path — see the concerns chapter in [ARCHITECTURE.md](ARCHITECTURE.md).
- **React 19 / Next 15+ upgrade.** Phase 0 deliberately stops at Next 14.2 because React is pinned to major 18 and the App Router requires React 19 from Next 15 onward. Lifting the pin unlocks the current Next major and brings the async request APIs (`headers()`, `cookies()`, `params`, `searchParams`), the forced ESLint flat-config migration, and a re-check of the Clerk and AI SDK peer ranges.
