import { ChatOpenAI } from "@langchain/openai";
import dotenv from "dotenv";
import { StreamingTextResponse } from "ai";
import clerk from "@clerk/clerk-sdk-node";
import { NextResponse } from "next/server";
import { currentUser } from "@clerk/nextjs";
import MemoryManager from "@/app/utils/memory";
import { rateLimit } from "@/app/utils/rateLimit";

dotenv.config({ path: `.env.local` });

// gpt-3.5-turbo-16k, which this route used previously, has been retired by
// OpenAI. gpt-4o-mini is the closest current equivalent on price and latency.
const CHAT_MODEL = "gpt-4o-mini";

export async function POST(req: Request) {
  let clerkUserId;
  let user;
  let clerkUserName;
  const { prompt, isText, userId, userName } = await req.json();

  const identifier = req.url + "-" + (userId || "anonymous");
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
  const name = req.headers.get("name");
  const companionFileName = name + ".txt";

  console.log("prompt: ", prompt);
  if (isText) {
    clerkUserId = userId;
    clerkUserName = userName;
  } else {
    user = await currentUser();
    clerkUserId = user?.id;
    clerkUserName = user?.firstName;
  }

  if (!clerkUserId || !!!(await clerk.users.getUser(clerkUserId))) {
    console.log("user not authorized");
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
  const data = await fs.readFile("companions/" + companionFileName, "utf8");

  // Clunky way to break out PREAMBLE and SEEDCHAT from the character file
  const presplit = data.split("###ENDPREAMBLE###");
  const preamble = presplit[0];
  const seedsplit = presplit[1].split("###ENDSEEDCHAT###");
  const seedchat = seedsplit[0];

  const companionKey = {
    companionName: name!,
    modelName: "chatgpt",
    userId: clerkUserId,
  };
  const memoryManager = await MemoryManager.getInstance();

  const records = await memoryManager.readLatestHistory(companionKey);
  if (records.length === 0) {
    await memoryManager.seedChatHistory(seedchat, "\n\n", companionKey);
  }

  await memoryManager.writeToHistory("Human: " + prompt + "\n", companionKey);
  let recentChatHistory = await memoryManager.readLatestHistory(companionKey);

  // query the vector db
  const similarDocs = await memoryManager.vectorSearch(
    recentChatHistory,
    companionFileName
  );

  let relevantHistory = "";
  if (!!similarDocs && similarDocs.length !== 0) {
    relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
  }

  const model = new ChatOpenAI({
    streaming: true,
    model: CHAT_MODEL,
    apiKey: process.env.OPENAI_API_KEY,
  });
  model.verbose = true;

  const replyWithTwilioLimit = isText
    ? "You reply within 1000 characters."
    : "";

  // Built as a plain string rather than a PromptTemplate: every value is
  // already interpolated here, and a PromptTemplate would additionally try to
  // parse any `{`/`}` appearing in a companion's backstory as a variable.
  const chainPrompt = `
    You are ${name} and are currently talking to ${clerkUserName}.

    ${preamble}

  You reply with answers that range from one sentence to one paragraph and with some details. ${replyWithTwilioLimit}

  Below are relevant details about ${name}'s past
  ${relevantHistory}

  Below is a relevant conversation history

  ${recentChatHistory}`;

  // Twilio needs the whole reply as JSON, so there is nothing to stream.
  if (isText) {
    const result = await model.invoke(chainPrompt);
    const text =
      typeof result.content === "string" ? result.content : String(result.content);
    await memoryManager.writeToHistory(text + "\n", companionKey);
    return NextResponse.json(text);
  }

  // Stream tokens to the browser, accumulating them so the finished reply can
  // be appended to the chat history once the stream completes.
  const encoder = new TextEncoder();
  let fullResponse = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of await model.stream(chainPrompt)) {
          const token =
            typeof chunk.content === "string" ? chunk.content : "";
          if (token) {
            fullResponse += token;
            controller.enqueue(encoder.encode(token));
          }
        }
        await memoryManager.writeToHistory(
          fullResponse + "\n",
          companionKey
        );
        controller.close();
      } catch (err) {
        console.log("WARNING: chat completion failed.", err);
        controller.error(err);
      }
    },
  });

  return new StreamingTextResponse(stream);
}
