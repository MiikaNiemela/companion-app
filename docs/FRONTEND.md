---
title: Frontend
description: Browser application structure, rendering model, and interface conventions
ms.date: 2026-07-28
ms.topic: reference
---

The browser-side application: what it is built with, how it is organised, and the patterns it follows. Server-side API routes, model backends, and the memory layer are out of scope. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Concern | Choice | Version |
| --- | --- | --- |
| Framework | Next.js, App Router | 14.2 |
| UI library | React | 18.3 |
| Language | TypeScript, `strict: true` | 5.9 |
| Styling | Tailwind CSS + `@tailwindcss/forms`, PostCSS + Autoprefixer | 3.3 |
| Headless components | `@headlessui/react` (Dialog, Transition) | 1.7 |
| Auth UI | `@clerk/nextjs` | 6.39 |
| Streaming chat | Vercel AI SDK 5, `useCompletion` from `@ai-sdk/react` | 5.0 / 4.0 |
| Tooltips | `react-tooltip` | 5.30 |
| Fonts | `next/font/google`, Inter, `latin` subset, self-hosted at build | N/A |
| Lint | ESLint / `eslint-config-next` | 8.42 / 14.2 |

No component library, no CSS-in-JS, no state-management library, no client-side router beyond the App Router, no test framework.

## Structure

```
src/app/
  layout.tsx                  root layout — ClerkProvider, Inter font, globals.css
  page.tsx                    the only content page: hero + companion gallery
  globals.css                 Tailwind directives + CSS custom properties
  sign-in/[[...sign-in]]/     Clerk <SignIn /> catch-all
  sign-up/[[...sign-up]]/     Clerk <SignUp /> catch-all
src/components/
  Navbar.tsx                  server component — auth state, sign-in link / UserButton
  Examples.tsx                client component — companion gallery, owns modal state
  QAModal.tsx                 client component — history state and streaming lifecycle
  ChatHistory.tsx             scrollable transcript and guarded bottom-follow
  ChatTurn.tsx                speaker attribution and turn alignment
  ChatBlock.tsx               multimodal renderer (text / image / audio / video)
  actions.ts                  "use server" — reads companions and typed history
  InputCard.tsx               not imported anywhere
  TextToImgModal.tsx          not imported anywhere
```

The whole UI is one route. Everything the user does happens on `/`, in a modal.

## Rendering model

Server components are the default; the client boundary is drawn as narrowly as the interaction requires.

- [layout.tsx](../src/app/layout.tsx) and [page.tsx](../src/app/page.tsx) are server components. Page metadata (`title`, `description`) is exported statically from the layout.
- [Navbar.tsx](../src/components/Navbar.tsx) is a server component and awaits Clerk's `auth()`, rendering either a `<UserButton />` or a sign-in link. No auth state is fetched in the browser.
- [Examples.tsx](../src/components/Examples.tsx), [QAModal.tsx](../src/components/QAModal.tsx), and [ChatHistory.tsx](../src/components/ChatHistory.tsx) are `"use client"` because they own browser interaction, effects, refs, or streaming state.
- [actions.ts](../src/components/actions.ts) exports two Server Actions. `getCompanions()` returns the registry as a JSON string; `getHistory()` authenticates with Clerk, resolves the model from the server-side registry, and returns typed `Turn[]` data.

## Patterns

### Data loading

The gallery calls `getCompanions()` from an effect on mount and stores the parsed result locally. When the dialog opens or the companion name changes, `QAModal` calls `getHistory()`. History loading has visible loading, empty, and error states; stale action results are ignored after close or companion change.

### State

State remains local. `Examples` owns the selected companion and modal visibility. `QAModal` owns the typed transcript, input, completion, and request state. `ChatHistory` keeps scroll-follow state in refs so token updates do not trigger unrelated renders. There is no context, external store, or URL state.

### Chat request lifecycle

`QAModal` uses `useCompletion`, configured per companion:

```ts
useCompletion({ api: "/api/" + example.llm, headers: { name: example.name } })
```

The endpoint is derived from the companion's `llm` field and the companion name travels in a custom HTTP header, not the body. Submitting appends an optimistic user turn and clears the input. Tokens render as a trailing companion turn; `onFinish` commits the final reply exactly once. Closing aborts the client stream and prevents a canceled callback from repopulating cleared state.

### Conversation rendering

`ChatHistory` renders stored and in-flight turns in one scroll container. It follows the bottom while the reader remains near the latest turn; scrolling upward disables follow until the reader returns near the bottom. `ChatTurn` adds the `You` or companion label and alignment, then delegates each `{text, mimeType, url}` block to `ChatBlock`.

`responseToChatBlocks` accepts a plain string, JSON string, object, or array and returns normalized block data. This remains the backend display contract for text, audio, video, image, and link responses.

### Loading and disabled states

The input is disabled while history loads or a response is in flight. History has explicit loading, empty, and failure states, and completion failures appear next to the input. An always-enabled close button keeps the dialog dismissible while other controls are disabled.

### Modals

Headless UI `Dialog` and `Transition.Root` provide focus management and enter/leave animation. The dialog has an explicit close button and also supports backdrop dismissal. Closing aborts streaming and clears input, completion, transcript, and history errors.

### Styling

Utility classes remain inline in JSX. The fixed-height dialog uses a flex column: the transcript grows and scrolls while the input stays pinned below it. User turns use sky blue and right alignment; companion turns use slate and left alignment. Turn widths remain bounded on mobile and desktop.

### Images

Gallery images use `next/image` with `width={0} height={0} sizes="100vw"` and a Tailwind size class. Remote hosts must be allowlisted in [next.config.js](../next.config.js); companion avatars are local files under `public/`. Multimodal response images remain dynamic `<img>` elements because their URLs arrive in model output.

### Imports

The `@/*` path alias maps to `./src/*` in [tsconfig.json](../tsconfig.json).

## Auth in the UI

`ClerkProvider` wraps the app in the root layout. Sign-in and sign-up are Clerk's prebuilt `<SignIn />` / `<SignUp />` components mounted on optional catch-all routes, so Clerk owns those flows entirely. Middleware redirects unauthenticated page visits there; the navbar shows Clerk's `<UserButton afterSignOutUrl="/" />` once signed in. Phone verification — which enables the SMS feature — is done through Clerk's own account-management UI, which the gallery points at via a tooltip.

## Present but inert

Documented because the code is in the tree, not because it works:

- `InputCard.tsx` (a "paste a blog link" form) and `TextToImgModal.tsx` are never imported. The latter posts to `/api/txt2img`, which does not exist in this repo, and calls `dotenv.config()` at module scope in a client file.
- `react-github-btn` and `ts-md5` are dependencies with no import anywhere; the navbar's GitHub star button is a hand-written `<iframe>` instead.
