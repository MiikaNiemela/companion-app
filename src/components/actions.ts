"use server";

import ConfigManager from "@/app/utils/config";
import MemoryManager, { type CompanionKey } from "@/app/utils/memory";
import { parseTranscript } from "@/app/utils/transcript";
import { currentUser } from "@clerk/nextjs/server";
// server action to allow configuration of LLM from .env.local

export async function getCompanions() {
  const COMPFILE = "./companions/companions.json";
  // console.log("Loading companion descriptions from "+COMPFILE);
  var fs = require('fs');
  const data = fs.readFileSync(COMPFILE);
  console.log(String(data));
  // run a parse here to force a server side error if the JSON is improperly formatted
  // It's much more difficult to debug client side
  JSON.parse(String(data));
  return String(data);
}

/**
 * Loads the signed-in user's recent turns for a companion.
 * The model name is resolved from the server-side registry because it forms
 * part of the Redis key and must not be selected by the browser.
 */
export async function getHistory(companionName: string) {
  const user = await currentUser();
  if (!user) {
    throw new Error("You must be signed in to load chat history.");
  }

  const companion = ConfigManager.getInstance().getConfig("name", companionName);
  if (!companion?.llm) {
    throw new Error(`Unknown companion: ${companionName}`);
  }

  const companionKey: CompanionKey = {
    companionName,
    modelName: companion.llm,
    userId: user.id,
  };
  const memoryManager = await MemoryManager.getInstance();
  const historyStrings = await memoryManager.readHistoryEntries(companionKey, 30);
  return parseTranscript(historyStrings, companionName);
}