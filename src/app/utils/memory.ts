import { Redis } from "@upstash/redis";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { PineconeStore } from "@langchain/pinecone";
import { SupabaseClient, createClient } from "@supabase/supabase-js";
import {
  Turn,
  formatEntry,
  parseTranscriptText,
} from "@/app/utils/transcript";

// Must stay in sync with the embedding scripts in src/scripts/. Querying an
// index with a different model than it was built with returns meaningless
// results rather than an error, so this is deliberately explicit instead of
// relying on the library default.
export const EMBEDDING_MODEL = "text-embedding-3-small";

export type CompanionKey = {
  companionName: string;
  modelName: string;
  userId: string;
};

// The subset of a vector-store hit the callers actually use.
export type SimilarDocument = {
  pageContent: string;
};

// Row shape returned by the match_documents function defined in pgvector.sql.
type MatchDocumentsRow = {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
};

class MemoryManager {
  private static instance: MemoryManager;
  private history: Redis;
  private vectorDBClient: Pinecone | SupabaseClient;

  public constructor() {
    this.history = Redis.fromEnv();
    if (process.env.VECTOR_DB === "pinecone") {
      this.vectorDBClient = new Pinecone({
        apiKey: process.env.PINECONE_API_KEY!,
      });
    } else {
      const auth = {
        detectSessionInUrl: false,
        persistSession: false,
        autoRefreshToken: false,
      };
      const url = process.env.SUPABASE_URL!;
      const privateKey = process.env.SUPABASE_PRIVATE_KEY!;
      // Explicit `any` for the Database generic: inferring it makes supabase-js
      // recurse past the TypeScript instantiation depth limit (TS2589).
      this.vectorDBClient = createClient<any>(url, privateKey, { auth });
    }
  }

  private embeddings() {
    return new OpenAIEmbeddings({
      apiKey: process.env.OPENAI_API_KEY,
      model: EMBEDDING_MODEL,
    });
  }

  public async vectorSearch(
    recentChatHistory: string,
    companionFileName: string
  ): Promise<SimilarDocument[] | undefined> {
    try {
      if (this.vectorDBClient instanceof Pinecone) {
        console.log("INFO: using Pinecone for vector search.");
        const pineconeIndex = this.vectorDBClient.Index(
          process.env.PINECONE_INDEX!
        );
        const vectorStore = await PineconeStore.fromExistingIndex(
          this.embeddings(),
          { pineconeIndex }
        );
        return await vectorStore.similaritySearch(recentChatHistory, 3, {
          fileName: companionFileName,
        });
      }

      console.log("INFO: using Supabase for vector search.");
      // Queried through the match_documents function in pgvector.sql. The
      // filter scopes the search to this companion's backstory; without it
      // every companion retrieves every other companion's documents.
      const queryEmbedding = await this.embeddings().embedQuery(
        recentChatHistory
      );
      const { data, error } = await this.vectorDBClient.rpc("match_documents", {
        query_embedding: queryEmbedding,
        match_count: 3,
        filter: { fileName: companionFileName },
      });
      if (error) {
        throw error;
      }
      return ((data ?? []) as MatchDocumentsRow[]).map((row) => ({
        pageContent: row.content,
      }));
    } catch (err) {
      console.log("WARNING: failed to get vector search results.", err);
      return undefined;
    }
  }

  public static async getInstance(): Promise<MemoryManager> {
    if (!MemoryManager.instance) {
      MemoryManager.instance = new MemoryManager();
    }
    return MemoryManager.instance;
  }

  private generateRedisCompanionKey(companionKey: CompanionKey): string {
    return `${companionKey.companionName}-${companionKey.modelName}-${companionKey.userId}`;
  }

  /**
   * Appends a turn to the chat history in the shared entry format.
   *
   * This is what routes should call: it keeps the `Human: `/`<Name>: ` prefix
   * in `transcript.ts` instead of letting each backend invent its own again.
   * The companion label comes from `companionKey.companionName`, which is also
   * part of the Redis key, so the label and the key can never disagree.
   */
  public async writeTurn(turn: Turn, companionKey: CompanionKey) {
    return this.writeToHistory(
      formatEntry(turn, companionKey.companionName),
      companionKey
    );
  }

  /**
   * Raw append, for callers that already hold a formatted entry. Prefer
   * `writeTurn`; anything written here bypasses the shared format and will be
   * guessed at by `parseEntry` on the way back out.
   */
  public async writeToHistory(text: string, companionKey: CompanionKey) {
    if (!companionKey || typeof companionKey.userId == "undefined") {
      console.log("Companion key set incorrectly");
      return "";
    }

    const key = this.generateRedisCompanionKey(companionKey);
    const result = await this.history.zadd(key, {
      score: Date.now(),
      member: text,
    });

    return result;
  }

  public async readLatestHistory(companionKey: CompanionKey): Promise<string> {
    if (!companionKey || typeof companionKey.userId == "undefined") {
      console.log("Companion key set incorrectly");
      return "";
    }

    const key = this.generateRedisCompanionKey(companionKey);
    let result = await this.history.zrange(key, 0, Date.now(), {
      byScore: true,
    });

    result = result.slice(-30).reverse();
    const recentChats = result.reverse().join("\n");
    return recentChats;
  }

  /**
   * Writes a character file's seed chat as the user's first history, once.
   *
   * Seeded turns are normalised through the shared entry format, so a new
   * user's history is uniform even though the character files disagree with
   * each other (`Human:`, `User:`, `### Human:`) and don't reliably put one
   * turn per line or per blank-line-separated block -- hence splitting on the
   * labels rather than on a delimiter.
   *
   * Scores are a plain 0..n counter, far below any `Date.now()` stamp, which
   * is what keeps seeded turns ahead of real ones. Does nothing if the key
   * already exists, so editing a character file never re-seeds existing users.
   */
  public async seedChatHistory(
    seedContent: String,
    companionKey: CompanionKey
  ) {
    const key = this.generateRedisCompanionKey(companionKey);
    if (await this.history.exists(key)) {
      console.log("User already has chat history");
      return;
    }

    const turns = parseTranscriptText(
      String(seedContent),
      companionKey.companionName
    );
    let counter = 0;
    for (const turn of turns) {
      await this.history.zadd(key, {
        score: counter,
        member: formatEntry(turn, companionKey.companionName),
      });
      counter += 1;
    }
  }
}

export default MemoryManager;
