// Call embedding API and insert into the Supabase `documents` table created by
// pgvector.sql. Written against supabase-js directly rather than a LangChain
// vector store, because @langchain/community (which held SupabaseVectorStore)
// has been deprecated and archived upstream.

import dotenv from "dotenv";
import { OpenAIEmbeddings } from "@langchain/openai";
import { createClient } from "@supabase/supabase-js";
import { CharacterTextSplitter } from "@langchain/textsplitters";

import fs from "fs";
import path from "path";

dotenv.config({ path: `.env.local` });

// Must match EMBEDDING_MODEL in src/app/utils/memory.ts. Querying with a
// different model than the index was built with returns meaningless results
// rather than an error.
const EMBEDDING_MODEL = "text-embedding-3-small";

const fileNames = fs.readdirSync("companions");
const splitter = new CharacterTextSplitter({
  separator: " ",
  chunkSize: 200,
  chunkOverlap: 50, //TODO: adjust both chunk size and chunk overlap later
});

const docs = (
  await Promise.all(
    fileNames.map(async (fileName) => {
      if (fileName.endsWith(".txt")) {
        const filePath = path.join("companions", fileName);
        const fileContent = fs.readFileSync(filePath, "utf8");
        const lastSection = fileContent.split("###ENDSEEDCHAT###").slice(-1)[0];
        const splitDocs = await splitter.createDocuments([lastSection]);
        // fileName is what memory.ts filters on, so every row must carry it.
        return splitDocs.map((doc) => ({
          content: doc.pageContent,
          metadata: { fileName },
        }));
      }
    })
  )
)
  .flat()
  .filter((doc) => doc !== undefined);

const auth = {
  detectSessionInUrl: false,
  persistSession: false,
  autoRefreshToken: false,
};

const client = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_PRIVATE_KEY,
  { auth }
);

const embeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
  model: EMBEDDING_MODEL,
});

const vectors = await embeddings.embedDocuments(docs.map((doc) => doc.content));

const { error } = await client.from("documents").insert(
  docs.map((doc, i) => ({
    content: doc.content,
    metadata: doc.metadata,
    embedding: vectors[i],
  }))
);

if (error) {
  throw error;
}

console.log(`Inserted ${docs.length} documents into Supabase.`);
