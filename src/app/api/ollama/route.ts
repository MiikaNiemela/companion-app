import dotenv from "dotenv";
import { createTextStreamResponse } from "ai";
import { NextResponse } from "next/server";
import { clerkClient, currentUser } from "@clerk/nextjs/server";
import MemoryManager from "@/app/utils/memory";
import { rateLimit } from "@/app/utils/rateLimit";

dotenv.config({ path: `.env.local` });

// Locally-hosted model served by Ollama (https://ollama.com). Unlike the other
// backends this runs on the developer's own machine, so it needs no API key --
// only a base URL and a model that has been `ollama pull`ed.
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL;
const OLLAMA_MODEL = process.env.OLLAMA_MODEL;

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

  // getUser rejects for an unknown id, so map that to the 401 below.
  const clerkUser = clerkUserId
    ? await (await clerkClient()).users.getUser(clerkUserId).catch(() => null)
    : null;
  if (!clerkUser) {
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
  // discussion.
  const fs = require("fs").promises;
  const data = await fs.readFile("companions/" + companionFileName, "utf8");

  // Clunky way to break out PREAMBLE and SEEDCHAT from the character file
  const presplit = data.split("###ENDPREAMBLE###");
  const preamble = presplit[0];
  const seedsplit = presplit[1].split("###ENDSEEDCHAT###");
  const seedchat = seedsplit[0];

  const companionKey = {
    companionName: name!,
    modelName: "ollama",
    userId: clerkUserId,
  };
  const memoryManager = await MemoryManager.getInstance();

  const records = await memoryManager.readLatestHistory(companionKey);
  if (records.length === 0) {
    await memoryManager.seedChatHistory(seedchat, "\n\n", companionKey);
  }

  await memoryManager.writeToHistory("Human: " + prompt + "\n", companionKey);
  const recentChatHistory = await memoryManager.readLatestHistory(companionKey);

  const similarDocs = await memoryManager.vectorSearch(
    recentChatHistory,
    companionFileName
  );

  let relevantHistory = "";
  if (!!similarDocs && similarDocs.length !== 0) {
    relevantHistory = similarDocs.map((doc) => doc.pageContent).join("\n");
  }

  const replyWithTwilioLimit = isText
    ? "You reply within 1000 characters."
    : "";

  // Persona and retrieved backstory go in the system message; the running
  // transcript is the user message.
  const systemPrompt = `You are ${name} and are currently talking to ${clerkUserName}.

${preamble}

You reply with answers that range from one sentence to one paragraph and with some details. Reply only as ${name}, in the first person, and do not begin your reply with your own name or a "${name}:" label. ${replyWithTwilioLimit}

Below are relevant details about ${name}'s past:
${relevantHistory}`;

  let ollamaResponse: Response;
  try {
    ollamaResponse = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: recentChatHistory },
        ],
        stream: true,
        // Weaker local models (e.g. wizard-vicuna) tend to keep going and
        // hallucinate further turns of the transcript. Stop as soon as the
        // model tries to start a new Human turn, a second turn of its own, or
        // emit the ### markers some character files use.
        options: {
          temperature: 0.75,
          stop: ["\nHuman:", `\n${name}:`, "\n###", "###"],
        },
      }),
    });
  } catch (err) {
    console.log("WARNING: could not reach Ollama.", err);
    return new NextResponse(
      JSON.stringify({
        Message: `Could not reach Ollama at ${OLLAMA_BASE_URL}. Is 'ollama serve' running and '${OLLAMA_MODEL}' pulled?`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!ollamaResponse.ok || !ollamaResponse.body) {
    const detail = await ollamaResponse.text().catch(() => "");
    console.log("WARNING: Ollama returned an error.", ollamaResponse.status, detail);
    return new NextResponse(
      JSON.stringify({ Message: `Ollama error (${ollamaResponse.status}). ${detail}` }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }

  // Ollama streams newline-delimited JSON: one object per line, each with a
  // `message.content` delta and a final `{ done: true }`. Reassemble the deltas,
  // re-emit them as a plain token stream, and append the full reply to history
  // once the stream closes.
  const decoder = new TextDecoder();

  const consume = async (
    onToken: (t: string) => void
  ): Promise<string> => {
    let full = "";
    let buffer = "";
    const reader = ollamaResponse.body!.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Process complete lines; keep any partial line in the buffer.
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line);
          const token: string = json.message?.content ?? "";
          if (token) {
            full += token;
            onToken(token);
          }
        } catch {
          // Ignore non-JSON keep-alive lines.
        }
      }
    }
    return full;
  };

  // Some models open with a "Name:" label even when told not to; drop it.
  const namePrefix = `${name}:`;
  const stripLeadingName = (text: string): string => {
    const t = text.replace(/^\s+/, "");
    return t.slice(0, namePrefix.length).toLowerCase() ===
      namePrefix.toLowerCase()
      ? t.slice(namePrefix.length).replace(/^\s+/, "")
      : text;
  };

  // Twilio needs the whole reply as JSON, so drain the stream fully first.
  if (isText) {
    const full = stripLeadingName(await consume(() => {}));
    await memoryManager.writeToHistory(full + "\n", companionKey);
    return NextResponse.json(full);
  }

  const textStream = new ReadableStream<string>({
    async start(controller) {
      try {
        // Buffer the opening tokens so a leading "Name:" can be stripped once,
        // then stream everything after it as it arrives.
        let head = "";
        let headFlushed = false;
        const full = await consume((token) => {
          if (headFlushed) {
            controller.enqueue(token);
            return;
          }
          head += token;
          if (head.replace(/^\s+/, "").length < namePrefix.length) return;
          headFlushed = true;
          const cleaned = stripLeadingName(head);
          if (cleaned) controller.enqueue(cleaned);
        });
        // Reply shorter than the prefix check never flushed above.
        if (!headFlushed && head) {
          controller.enqueue(stripLeadingName(head));
        }
        await memoryManager.writeToHistory(
          stripLeadingName(full) + "\n",
          companionKey
        );
        controller.close();
      } catch (err) {
        console.log("WARNING: Ollama stream failed.", err);
        controller.error(err);
      }
    },
  });

  return createTextStreamResponse({ textStream });
}
