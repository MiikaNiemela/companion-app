/**
 * The one place that knows how a chat turn is written to, and read back from,
 * the Redis history.
 *
 * Every model route used to hand-build its own prefix ("Human: ", "User: ",
 * "### Human: ", bare reply text), so nothing could tell who said what without
 * guessing. Writes now go through `formatEntry`; reads go through `parseEntry`,
 * which stays tolerant of every historical variant because stored entries are
 * never migrated.
 *
 * Pure and dependency-free on purpose: no Redis, no config, no I/O.
 */

/** Who produced a turn. `companion` covers both real and seeded replies. */
export type Speaker = "user" | "companion";

/**
 * One turn of a conversation. `at` is the Redis sorted-set score (a
 * `Date.now()` millisecond stamp) and is only populated by read paths that ask
 * for scores — `formatEntry` ignores it, since the score is stored beside the
 * member rather than inside it.
 */
export type Turn = {
  speaker: Speaker;
  text: string;
  at?: number;
};

/**
 * Labels that mark a user turn. `Human` is what we write; `User` appears in
 * older entries and in some character files' seed chats, so it has to keep
 * parsing forever.
 */
const USER_LABELS = ["Human", "User"] as const;

/**
 * Removes a leading `<label>:` from `text`, case-insensitively.
 *
 * @returns the remainder with surrounding whitespace trimmed, or `null` when
 * the text does not start with that label — the caller uses `null` to decide
 * the label did not match rather than that the turn was empty.
 */
function stripLabel(text: string, label: string): string | null {
  const prefix = `${label}:`;
  if (text.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return null;
  }
  return text.slice(prefix.length).trim();
}

/** Drops the legacy `###` marker some entries and model replies carry. */
function stripMarker(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("###") ? trimmed.slice(3).trim() : trimmed;
}

/**
 * Renders a turn into the single on-the-wire format stored in Redis:
 * `Human: …` for the user, `<CompanionName>: …` for the companion.
 *
 * This is the only writer of that prefix. Keep it in step with `parseEntry`,
 * and note that entries already in Redis are never rewritten, so changing the
 * format here silently splits old and new data into two shapes.
 *
 * @param companionName - the companion's display name, used as its label
 */
export function formatEntry(turn: Turn, companionName: string): string {
  const label = turn.speaker === "user" ? USER_LABELS[0] : companionName;
  return `${label}: ${turn.text.trim()}`;
}

/**
 * Reads a stored entry back into a turn, tolerating every format the four
 * model routes wrote before they shared one: an optional `### ` marker, a
 * `Human:`/`User:` or `<CompanionName>:` label, a label on its own line, and
 * trailing newlines.
 *
 * An entry with no recognisable label is attributed to the companion, because
 * the `chatgpt` and `ollama` routes historically stored replies as bare text.
 * That guess is the reason a real speaker marker is a future item.
 *
 * @param companionName - the name whose label identifies a companion turn
 */
export function parseEntry(raw: string, companionName: string): Turn {
  const body = stripMarker(raw);

  for (const label of USER_LABELS) {
    const text = stripLabel(body, label);
    if (text !== null) {
      return { speaker: "user", text };
    }
  }

  const companionText = stripLabel(body, companionName);
  return {
    speaker: "companion",
    text: companionText !== null ? companionText : body,
  };
}

/**
 * Parses a whole transcript, in stored order.
 *
 * Entries that carry no text after their label are dropped: seeded chats end
 * with a dangling `Human:` in at least one character file, and an empty turn
 * has nothing to render.
 *
 * @param entries - raw sorted-set members, oldest first
 * @param scores - matching timestamps, when the caller read them alongside the
 * members; index-aligned with `entries`
 */
export function parseTranscript(
  entries: string[],
  companionName: string,
  scores?: number[]
): Turn[] {
  return entries
    .map((entry, index) => {
      const turn = parseEntry(entry, companionName);
      const at = scores?.[index];
      return at === undefined ? turn : { ...turn, at };
    })
    .filter((turn) => turn.text.length > 0);
}

/**
 * Splits a block of transcript text — a character file's seed chat — into
 * turns, one per labelled line.
 *
 * Character files are not consistent about separating turns: some put a blank
 * line between them, some only a newline, and one puts the label on its own
 * line above the text. Splitting on a delimiter therefore merged a user turn
 * and the reply to it into a single entry. Splitting on the labels instead is
 * what makes a seeded history renderable turn by turn.
 *
 * Text before the first label is attached to a companion turn, matching
 * `parseEntry`'s fallback.
 */
export function parseTranscriptText(text: string, companionName: string): Turn[] {
  const labels = [...USER_LABELS, companionName];
  const startsTurn = (line: string) => {
    const body = stripMarker(line);
    return labels.some((label) => stripLabel(body, label) !== null);
  };

  const chunks: string[] = [];
  for (const line of text.split("\n")) {
    if (chunks.length === 0 || startsTurn(line)) {
      chunks.push(line);
    } else {
      chunks[chunks.length - 1] += `\n${line}`;
    }
  }

  return parseTranscript(chunks, companionName);
}

/**
 * Strips a self-label a model put on its own reply ("Alex: hi there").
 *
 * Every backend is told not to do this and most obey, but the stored
 * transcript now labels companion turns, which gives them one more reason to
 * imitate it — so each route strips defensively before writing. Text without a
 * label is returned untouched.
 *
 * @param companionName - the label to remove, matched case-insensitively
 */
export function stripSpeakerPrefix(text: string, companionName: string): string {
  const withoutMarker = text.replace(/^\s*(?:###\s*)?/, "");
  const stripped = stripLabel(withoutMarker, companionName);
  return stripped !== null ? stripped : text;
}
