# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run dev            # local dev server on :3000
npm run build          # next build
npm run lint           # next lint (eslint-config-next)

npm run generate-embeddings-pinecone    # index companions/*.txt into Pinecone
npm run generate-embeddings-supabase    # same, into Supabase pgvector

npm run export-to-character [COMPANION_NAME] [MODEL_NAME] [USER_ID]  # dump chat history + Character.ai config
```

There is no test suite and no test framework in this repo.

Secrets live in `.env.local` (see [.env.local.example](.env.local.example)); the scripts and API routes each call `dotenv.config({ path: '.env.local' })` themselves. `VECTOR_DB` must be exactly `pinecone` to use Pinecone — any other value, including unset, falls back to Supabase. Supabase requires running [pgvector.sql](pgvector.sql) once in the Supabase SQL editor.

Pinecone needs only `PINECONE_API_KEY` and `PINECONE_INDEX`. There is no `PINECONE_ENVIRONMENT`: the client uses the global control plane at `api.pinecone.io`, and the old per-region `controller.<env>.pinecone.io` endpoints are gone.

Deployment targets fly.io via the generated [Dockerfile](Dockerfile) (`fly launch`, `fly scale memory 512`, `fly deploy --ha=false`, `cat .env.local | fly secrets import`).

## Architecture

Next.js 13 App Router. Three moving parts: character files on disk, one API route per LLM backend, and a shared memory layer.

### Companion definition (`companions/`)

`companions.json` is the registry. Each entry: `name`, `title`, `imageUrl` (file in `public/`), `llm`, `phone`, plus optional `telegramLink`.

**`llm` is the API route name.** The client calls `/api/${example.llm}` ([QAModal.tsx](src/components/QAModal.tsx#L34)), and [text/route.ts](src/app/api/text/route.ts#L75) fetches the same path server-side. Adding a model backend means adding `src/app/api/<name>/route.ts` and setting `llm: "<name>"` — nothing else dispatches.

Each companion also has `companions/<Name>.txt`, split by two literal markers:

- **preamble** (before `###ENDPREAMBLE###`) — injected into *every* prompt, keep it short
- **seedchat** (before `###ENDSEEDCHAT###`) — written into Redis as the initial chat history the first time a user talks to that companion
- **backstory** (everything after) — the *only* part that gets embedded into the vector DB ([indexPinecone.mjs](src/scripts/indexPinecone.mjs#L26)), retrieved by similarity against recent chat

Editing the backstory section requires re-running the embeddings script. Editing the preamble/seedchat does not, but existing users' Redis history is never re-seeded.

Character files and `companions.json` are read with `fs` at request time relative to the process CWD (see [config.ts](src/app/utils/config.ts#L9), [actions.ts](src/components/actions.ts#L11), and each model route). They must ship alongside the build, not be bundled.

### Memory (`src/app/utils/memory.ts`)

`MemoryManager` is a singleton over two stores:

- **Chat history**: Upstash Redis sorted set keyed `${companionName}-${modelName}-${userId}`, scored by timestamp; reads return the last 30 entries. The key includes the model, so switching a companion's `llm` starts a fresh history. History is never expired or cleared — deletion is manual in the Upstash console.
- **Vector search**: Pinecone (via `@langchain/pinecone`) or Supabase, chosen by `VECTOR_DB` at construction and again in `vectorSearch`. Top-3 similarity against the recent chat text, filtered by `fileName` metadata on **both** paths so companions don't retrieve each other's backstories. The Supabase path calls the `match_documents` function from [pgvector.sql](pgvector.sql) directly through `.rpc()` rather than a LangChain vector store, because `@langchain/community` (which held `SupabaseVectorStore`) was deprecated and archived upstream. Failures are caught and logged, returning `undefined` — the route then prompts with an empty `relevantHistory` rather than erroring.
- **Embedding model**: `EMBEDDING_MODEL` in [memory.ts](src/app/utils/memory.ts) is pinned and must match the literal in both `src/scripts/index*.mjs`. Querying an index with a different model than it was built with returns meaningless results *silently* — no error. Changing it means re-running the embedding script.

### Model routes (`src/app/api/*/route.ts`)

All follow the same shape: rate limit → resolve Clerk user → read+split the character file → seed history if empty → append `Human: ...` → read recent history → vector search → build prompt → call model → append the reply to history → return.

- The companion name arrives in the **`name` HTTP header**, not the body.
- `isText: true` in the body means the request came from Twilio: the caller supplies `userId`/`userName` instead of `currentUser()`, and the route returns JSON instead of a stream.
- `chatgpt` uses `ChatOpenAI` from `@langchain/openai` and genuinely streams, via `model.stream()` wrapped in a `ReadableStream` that accumulates tokens so the finished reply can be appended to history once the stream closes. `llama3-8b` and `llama3-70b` call the `replicate` SDK directly (no LangChain wrapper) against the public `meta/meta-llama-3-*-instruct` models: persona + retrieved backstory go in `system_prompt`, the transcript is the `prompt`, and the array-of-tokens output is joined and emitted as a single chunk — so they are not incremental, and Replicate cold starts can take minutes. The folder name is the dispatch key, not a live model version: it must match the `llm` field in `companions.json` and the `modelName` in the route (which is part of the Redis history key), so renaming a route resets that companion's history.
- Prompts are built as plain template strings, deliberately **not** `PromptTemplate`: every value is already interpolated, and `PromptTemplate` would try to parse any `{`/`}` in a companion's backstory as a variable.
- `ollama` calls a **locally-hosted** model through Ollama's HTTP API (`OLLAMA_BASE_URL` + `OLLAMA_MODEL`, both required — no fallback) — no API key, the model runs on the developer's machine. The shipped `Ruffy` companion uses the uncensored, instruction-tuned `dolphin-mistral` model to demonstrate running a less-filtered open model locally. (Vicuna-lineage models like `wizard-vicuna-uncensored` have weak `system`-role support, so they follow a system-prompt persona unreliably; Dolphin honors it.) It streams like `chatgpt`, reading Ollama's newline-delimited JSON (`/api/chat`, one `message.content` delta per line) and re-emitting the deltas as a token stream. Returns a 502 with a helpful message if `ollama serve` isn't running or the model isn't pulled.

### Multimodal responses

[ChatBlock.tsx](src/components/ChatBlock.tsx) is the display contract: `responseToChatBlocks` accepts a plain string, a JSON string, an object, or an array, and renders `{text, mimeType, url}` blocks as text/audio/video/image. New backends returning richer output should emit that shape.

### Auth and rate limiting

Clerk `authMiddleware` gates all pages; [middleware.ts](src/middleware.ts#L7) marks `/api(.*)` public (noted in-code as a production TODO), so **each API route re-verifies the Clerk user itself** — don't drop that check when adding a route. The Twilio path instead looks the user up by verified phone number, so texting only works for users who verified a phone in Clerk.

`rateLimit(identifier)` ([rateLimit.ts](src/app/utils/rateLimit.ts)) is an Upstash sliding window of 10 requests / 10s, keyed on request URL + user id.

## Known rough edges (documented in README, don't treat as bugs to fix silently)

- The UI shows only the current exchange; history is not rendered.
- Backend errors frequently fail silently, especially when deployed.
