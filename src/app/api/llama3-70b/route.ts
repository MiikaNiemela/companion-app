import dotenv from "dotenv";
import { createTextStreamResponse } from "ai";
import Replicate from "replicate";
import MemoryManager from "@/app/utils/memory";
import { clerkClient, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { rateLimit } from "@/app/utils/rateLimit";

dotenv.config({ path: `.env.local` });

// Public, Meta-maintained instruct model on Replicate -- nothing to host. The
// owner/model form (no version) always resolves to the latest published
// version of an official model. 70B for noticeably stronger replies than 8B.
const REPLICATE_MODEL = "meta/meta-llama-3-70b-instruct" as const;

export async function POST(request: Request) {
  const { prompt, isText, userId, userName } = await request.json();
  let clerkUserId;
  let user;
  let clerkUserName;

  const identifier = request.url + "-" + (userId || "anonymous");
  const { success } = await rateLimit(identifier);
  if (!success) {
    console.log("INFO: rate limit exceeded");
    return new NextResponse(
      JSON.stringify({ Message: "Hi, the companions can't talk this fast." }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  // XXX Companion name passed here. Can use as a key to get backstory, chat history etc.
  const name = request.headers.get("name");
  const companion_file_name = name + ".txt";

  if (isText) {
    clerkUserId = userId;
    clerkUserName = userName;
  } else {
    user = await currentUser();
    clerkUserId = user?.id;
    clerkUserName = user?.firstName;
  }

  // getUser rejects for an unknown id, so map that to the 401 below.
  const clerkUser = clerkUserId
    ? await (await clerkClient()).users.getUser(clerkUserId).catch(() => null)
    : null;
  if (!clerkUser) {
    return new NextResponse(
      JSON.stringify({ Message: "User not authorized" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }

  // Load character "PREAMBLE" from character file. These are the core personality
  // characteristics that are used in every prompt. Additional background is
  // only included if it matches a similarity comparioson with the current
  // discussion. The PREAMBLE should include a seed conversation whose format will
  // vary by the model using it.
  const fs = require("fs").promises;
  const data = await fs.readFile("companions/" + companion_file_name, "utf8");

  // Clunky way to break out PREAMBLE and SEEDCHAT from the character file
  const presplit = data.split("###ENDPREAMBLE###");
  const preamble = presplit[0];
  const seedsplit = presplit[1].split("###ENDSEEDCHAT###");
  const seedchat = seedsplit[0];

  const companionKey = {
    companionName: name!,
    userId: clerkUserId!,
    modelName: "llama3-70b",
  };
  const memoryManager = await MemoryManager.getInstance();

  const records = await memoryManager.readLatestHistory(companionKey);
  if (records.length === 0) {
    await memoryManager.seedChatHistory(seedchat, "\n\n", companionKey);
  }
  await memoryManager.writeToHistory("User: " + prompt + "\n", companionKey);

  // Query Pinecone

  let recentChatHistory = await memoryManager.readLatestHistory(companionKey);

  // Right now the preamble is included in the similarity search, but that
  // shouldn't be an issue

  const similarDocs = await memoryManager.vectorSearch(
    recentChatHistory,
    companion_file_name
  );

  let relevantHistory = "";
  if (!!similarDocs && similarDocs.length !== 0) {
    relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
  }
  // Call Replicate for inference. This model is not streamed, so the whole
  // reply is produced before anything is sent back.
  const replicate = new Replicate({
    auth: process.env.REPLICATE_API_TOKEN,
  });

  const output = await replicate
    .run(REPLICATE_MODEL, {
      input: {
        // Persona and retrieved backstory go in the system prompt; the running
        // transcript is the user turn. Llama 3 applies its own chat template.
        system_prompt: `You are ${name}. ${preamble}

Below are relevant details about ${name}'s past:
${relevantHistory}

Stay in character as ${name}. Reply with no more than three sentences. Do not prefix your reply with your name.`,
        prompt: recentChatHistory,
        max_tokens: 512,
        temperature: 0.75,
      },
    })
    .catch((err) => {
      console.log("WARNING: Replicate inference failed.", err);
      return "";
    });

  // meta-llama-3 instruct returns output as an array of token strings, already
  // clean prose -- no per-line munging needed.
  let response = (Array.isArray(output) ? output.join("") : String(output ?? "")).trim();
  // Defensively drop a leading "Name:" if the model adds one anyway.
  const namePrefix = `${name}:`;
  if (response.toLowerCase().startsWith(namePrefix.toLowerCase())) {
    response = response.slice(namePrefix.length).trim();
  }

  if (response.length > 1) {
    await memoryManager.writeToHistory(name + ": " + response, companionKey);
  }

  // Replicate already returned the whole reply, so this "stream" is a single
  // chunk -- it exists only to match the text-stream response shape the
  // client's completion hook consumes.
  const textStream = new ReadableStream<string>({
    start(controller) {
      controller.enqueue(response);
      controller.close();
    },
  });

  return createTextStreamResponse({ textStream });
}
