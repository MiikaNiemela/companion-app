import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// This requires user to sign in to see any page or call any API route

// TODO - the public route list should only contain /api/text for production
// The sign-in/sign-up pages must be listed too: authMiddleware exempted them
// implicitly, but auth.protect() would redirect-loop on them if protected.
const isPublicRoute = createRouteMatcher([
  "/api(.*)",
  "/sign-in(.*)",
  "/sign-up(.*)",
]);

// clerkMiddleware protects nothing by default — the inverse of the old
// authMiddleware — so every non-public route opts into protection here.
export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
