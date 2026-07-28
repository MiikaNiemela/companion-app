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
| `llama3-8b`, `llama3-70b` | `### Human: …\n` | `### <Name>: …` |
| seeded turns (from character file) | `Human: …` | `<Name>: …` |

Nothing can render this reliably without a normalisation step, and the divergence exists only because the conversation pipeline is copy-pasted per model route with no shared write path. **Unifying the entry format is therefore the first work item, not a detail of the read path.**

## Sequencing

Four phases, in order. Each is independently shippable.

- [ ] **Phase 0** — Framework upgrade
- [ ] **Phase 1** — Unified chat-entry storage
- [ ] **Phase 2** — Server-side read path
- [ ] **Phase 3** — History UI

---

### Phase 0 — Framework upgrade (do first)

Rationale: any API-surface change is cheaper to make once, on the target version. The codebase is small, so upgrading now means less code to migrate than after the feature lands. Next.js 13 → current major, with the dependency chain it drags along.

- [ ] Next.js 13.5 → current major; React 18 → the version it requires
- [ ] `@clerk/nextjs` 4.x → current. Clerk v4 does not support post-14 Next.js, and `authMiddleware` is superseded by `clerkMiddleware` + `createRouteMatcher` — [middleware.ts](../src/middleware.ts) must be rewritten. Treat this as the highest-risk item: it is the app's only page-level gate.
- [ ] `ai` (Vercel AI SDK) 2.x → current. The React hooks moved to a separate `@ai-sdk/react` package and `StreamingTextResponse` was removed in favour of the newer stream-response helpers — affects [QAModal.tsx](../src/components/QAModal.tsx) and every model route.
- [ ] Async request APIs: `headers()`, `cookies()`, `params`, `searchParams` became async — all model routes read the companion name from a header.
- [ ] `experimental.serverActions` in [next.config.js](../next.config.js) is no longer experimental; drop the flag.
- [ ] Re-run `next lint` (config may need migrating to flat ESLint) and a full manual pass: sign-in, gallery, one chat per backend.

Confirm each item against the official migration guides during the work rather than trusting this list — it is a scope sketch, not a verified changelog. Every version-specific claim here needs checking.

**Exit criterion:** the app behaves exactly as before on the new stack. No feature work in this phase.

---

### Phase 1 — Unified chat-entry storage

Fix the cause, not the symptom: one write path, one format, shared by every model route.

- [ ] Define the entry format in one place — `src/app/utils/transcript.ts`:
  - `type Turn = { speaker: "user" | "companion"; text: string; at?: number }`
  - `formatEntry(turn, companionName): string` — the single writer of the on-the-wire prefix
  - `parseEntry(raw, companionName): Turn` — tolerant reader: strips an optional `### `, maps `Human:` → user, `<Name>:` → companion, no prefix → companion, trims trailing newline
  - `parseTranscript(entries, companionName): Turn[]`
  - Pure and dependency-free — the one part of this feature that is trivially testable.
- [ ] Route the writes through it: `MemoryManager.writeToHistory` gains a turn-aware wrapper (or the routes call `formatEntry`). Every route stops hand-building `"Human: " + prompt` and `"### " + name + ": "`.
- [ ] **Do not change what the model sees.** The prompt is still built from the joined string; if a route's model needs `###` markers, that stays a prompt-assembly concern, not a storage concern. Verify each backend still answers in character after the change.
- [ ] Existing Redis data keeps the old formats. `parseEntry` must handle all three variants above indefinitely — there is no migration and no way to run one without a user-data script.

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
