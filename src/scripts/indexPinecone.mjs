// Major ref: https://js.langchain.com/docs/integrations/vectorstores/pinecone
import { Pinecone } from "@pinecone-database/pinecone";
import dotenv from "dotenv";
import { Document } from "@langchain/core/documents";
import { OpenAIEmbeddings } from "@langchain/openai";
import { PineconeStore } from "@langchain/pinecone";
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

const langchainDocs = await Promise.all(
  fileNames.map(async (fileName) => {
    if (fileName.endsWith(".txt")) {
      const filePath = path.join("companions", fileName);
      const fileContent = fs.readFileSync(filePath, "utf8");
      // get the last section in the doc for background info
      const lastSection = fileContent.split("###ENDSEEDCHAT###").slice(-1)[0];
      const splitDocs = await splitter.createDocuments([lastSection]);
      return splitDocs.map((doc) => {
        return new Document({
          metadata: { fileName },
          pageContent: doc.pageContent,
        });
      });
    }
  })
);

// The modern Pinecone client talks to the global control plane at
// api.pinecone.io, so it needs only an API key -- there is no longer a
// PINECONE_ENVIRONMENT to configure.
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX);

await PineconeStore.fromDocuments(
  langchainDocs.flat().filter((doc) => doc !== undefined),
  new OpenAIEmbeddings({
    apiKey: process.env.OPENAI_API_KEY,
    model: EMBEDDING_MODEL,
  }),
  {
    pineconeIndex,
  }
);
