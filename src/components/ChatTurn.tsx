import { ChatBlock, responseToChatBlocks } from "@/components/ChatBlock";
import type { Turn } from "@/app/utils/transcript";

type ChatTurnProps = Turn & {
  companionName: string;
  streaming?: boolean;
};

/**
 * Adds speaker attribution and conversation alignment around the existing
 * multimodal renderer. Streaming and stored replies share this component so
 * backend-specific response shapes have one display path.
 */
export default function ChatTurn({
  speaker,
  text,
  companionName,
  streaming = false,
}: ChatTurnProps) {
  const isUser = speaker === "user";
  const blocks = responseToChatBlocks(text);

  return (
    <div
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
    >
      <div
        className={`max-w-[85%] rounded-lg px-4 py-3 shadow-sm sm:max-w-[75%] ${
          isUser
            ? "bg-sky-600 text-white"
            : "bg-slate-700 text-slate-100 ring-1 ring-inset ring-white/10"
        }`}
      >
        <p
          className={`mb-1 text-xs font-medium ${
            isUser ? "text-sky-100" : "text-slate-400"
          }`}
        >
          {isUser ? "You" : companionName}
          {streaming ? (
            <span className="ml-2 animate-pulse" aria-label="Responding">
              ...
            </span>
          ) : null}
        </p>
        {blocks.map((block, index) => (
          <ChatBlock key={index} {...block} />
        ))}
      </div>
    </div>
  );
}