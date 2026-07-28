# Frontend

The browser-side application: what it is built with, how it is organised, and the patterns it follows. Server-side API routes, model backends, and the memory layer are out of scope — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Concern | Choice | Version |
| --- | --- | --- |
| Framework | Next.js, App Router | 13.5 |
| UI library | React | 18.2 |
| Language | TypeScript, `strict: true` | 5.1 |
| Styling | Tailwind CSS + `@tailwindcss/forms`, PostCSS + Autoprefixer | 3.3 |
| Headless components | `@headlessui/react` (Dialog, Transition) | 1.7 |
| Auth UI | `@clerk/nextjs` | 4.21 |
| Streaming chat | Vercel `ai` — `useCompletion` from `ai/react` | 2.1 |
| Tooltips | `react-tooltip` | 5.16 |
| Fonts | `next/font/google` — Inter, `latin` subset, self-hosted at build | — |
| Lint | `next lint` / `eslint-config-next` | 8.42 |

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
  QAModal.tsx                 client component — chat dialog, streaming completion
  ChatBlock.tsx               multimodal renderer (text / image / audio / video)
  actions.ts                  "use server" — reads companions.json off disk
  InputCard.tsx               not imported anywhere
  TextToImgModal.tsx          not imported anywhere
```

The whole UI is one route. Everything the user does happens on `/`, in a modal.

## Rendering model

Server components are the default; the client boundary is drawn as narrowly as the interaction requires.

- [layout.tsx](../src/app/layout.tsx) and [page.tsx](../src/app/page.tsx) are server components. Page metadata (`title`, `description`) is exported statically from the layout.
- [Navbar.tsx](../src/components/Navbar.tsx) is a server component and reads the session synchronously via Clerk's `auth()`, rendering either a `<UserButton />` or a sign-in link. No auth state is fetched in the browser.
- [Examples.tsx](../src/components/Examples.tsx) and [QAModal.tsx](../src/components/QAModal.tsx) are `"use client"` — they need `useState`/`useEffect` and a streaming fetch.
- Server Actions are enabled (`experimental.serverActions` in [next.config.js](../next.config.js)) and used once: `getCompanions()` in [actions.ts](../src/components/actions.ts) reads the companion registry from disk and returns it to the client as a raw JSON **string**, which the client parses.

## Patterns

**Data loading.** The gallery is a client component that calls the server action from a `useEffect` on mount and stores the result in `useState`, initialised with a single blank placeholder entry. Errors are caught and logged to the console; there is no error or empty state in the UI.

**State.** All state is local `useState` in the two client components — no context, store, or URL state. `Examples` owns both the modal's open flag and the selected companion, and passes them down to `QAModal` as props (`open`, `setOpen`, `example`). Selecting a card sets both at once.

**Chat.** `QAModal` delegates the request lifecycle entirely to `useCompletion`, configured per companion:

```ts
useCompletion({ api: "/api/" + example.llm, headers: { name: example.name } })
```

The endpoint is derived from the companion's `llm` field and the companion name travels in a custom HTTP header, not the body. The hook supplies `input`, `handleInputChange`, `handleSubmit`, `isLoading`, `completion`, `stop`, and the setters used to reset on close. Tokens arrive as a growing `completion` string.

**Rendering replies.** A `useEffect` watching `completion` re-runs [`responseToChatBlocks`](../src/components/ChatBlock.tsx) on every token and stores the resulting elements in state. That function accepts a string, a JSON string, an object, or an array, and renders `{text, mimeType, url}` blocks as text, audio, video, image, or link — the display contract any backend can target. Only the current exchange is shown; there is no transcript view.

**Loading and disabled states.** Driven by `isLoading` combined with whether any blocks exist yet: the input is disabled and an inline spinner SVG is shown while a request is in flight with nothing streamed back.

**Modals.** Headless UI `Dialog` + `Transition.Root` with Tailwind classes for enter/leave animation. Closing calls `stop()` and clears both the input and the completion.

**Styling.** Utility classes inline in JSX throughout — no `@apply`, no component classes, no design tokens beyond Tailwind's defaults. The only custom theme extension is two background gradients in [tailwind.config.js](../tailwind.config.js). [globals.css](../src/app/globals.css) defines foreground/background CSS variables with a `prefers-color-scheme: dark` block, but the app hard-codes dark slate/gray utilities, so the light values are never visible. Conditional classes are built with string concatenation, plus a local `classNames` helper in the navbar.

**Images.** `next/image` with `width={0} height={0} sizes="100vw"` and a Tailwind size class — the pattern for letting CSS drive dimensions. Remote hosts must be allowlisted in `next.config.js` (`avatars.githubusercontent.com`, `replicate.delivery`, `tjzk.replicate.delivery`, `a16z.com`); companion avatars themselves are local files under `public/`.

**Imports.** Path alias `@/*` → `./src/*` from [tsconfig.json](../tsconfig.json).

## Auth in the UI

`ClerkProvider` wraps the app in the root layout. Sign-in and sign-up are Clerk's prebuilt `<SignIn />` / `<SignUp />` components mounted on optional catch-all routes, so Clerk owns those flows entirely. Middleware redirects unauthenticated page visits there; the navbar shows Clerk's `<UserButton afterSignOutUrl="/" />` once signed in. Phone verification — which enables the SMS feature — is done through Clerk's own account-management UI, which the gallery points at via a tooltip.

## Present but inert

Documented because the code is in the tree, not because it works:

- `InputCard.tsx` (a "paste a blog link" form) and `TextToImgModal.tsx` are never imported. The latter posts to `/api/txt2img`, which does not exist in this repo, and calls `dotenv.config()` at module scope in a client file.
- `react-github-btn` and `ts-md5` are dependencies with no import anywhere; the navbar's GitHub star button is a hand-written `<iframe>` instead.
- `QAModal.tsx` declares a module-level `var last_name = ""` that is never read, and constructs a dummy `example` object when none is passed so the completion hook can initialise.
