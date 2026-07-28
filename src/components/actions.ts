"use server";

import ConfigManager from "@/app/utils/config";
import MemoryManager, { type CompanionKey } from "@/app/utils/memory";
import { parseTranscript } from "@/app/utils/transcript";
import { currentUser } from "@clerk/nextjs/server";
// server action to allow configuration of LLM from .env.local

import dotenv from "dotenv";
import { parse } from "path";


export async function getCompanions() {
  const COMPFILE = "./companions/companions.json";
  var companions = [];
  // console.log("Loading companion descriptions from "+COMPFILE);
  var fs = require('fs');
  const data = fs.readFileSync(COMPFILE);
  console.log(String(data));
  // run a parse here to force a server side error if the JSON is improperly formatted
  // It's much more difficult to debug client side
  var js = JSON.parse(String(data));
  return String(data);
}

export async function getHistory(companionName: string) {
  const user = await currentUser();
  const modelName = ConfigManager.getInstance().getConfig("llm", companionName);
  const companionKey: CompanionKey = { companionName, modelName, userId: user?.id as string,}
  const memoryManager = await MemoryManager.getInstance();
  const historyStrings = await memoryManager.readHistoryEntries(companionKey, 30)
  return parseTranscript(historyStrings, companionName)
}