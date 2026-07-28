"use client";

import { useEffect, useRef } from "react";
import type { Turn } from "@/app/utils/transcript";
import ChatTurn from "@/components/ChatTurn";

type ChatHistoryProps = {
  turns: Turn[];
  companionName: string;
  loading: boolean;
  error: string | null;
  streamingTurn?: Turn;
};

/**
 * Renders the conversation and follows new turns only while the reader remains
 * near the bottom. Once they scroll upward, streaming updates leave their
 * position alone until they return to the latest messages.
 */
export default function ChatHistory({
  turns,
  companionName,
  loading,
  error,
  streamingTurn,
}: ChatHistoryProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const shouldFollowRef = useRef(true);

  useEffect(() => {
    if (loading) {
      shouldFollowRef.current = true;
    }
  }, [loading, companionName]);

  useEffect(() => {
    if (shouldFollowRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [turns.length, streamingTurn?.text]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    shouldFollowRef.current = distanceFromBottom < 64;
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="min-h-0 flex-1 overflow-y-auto px-1 py-4"
      aria-live="polite"
      aria-busy={loading}
    >
      {loading ? (
        <div className="flex h-full min-h-40 items-center justify-center text-sm text-slate-400">
          <span className="mr-3 h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-sky-300" />
          Loading conversation...
        </div>
      ) : error ? (
        <div
          role="alert"
          className="flex h-full min-h-40 items-center justify-center px-6 text-center text-sm text-rose-300"
        >
          {error}
        </div>
      ) : turns.length === 0 && !streamingTurn ? (
        <div className="flex h-full min-h-40 items-center justify-center px-6 text-center text-sm text-slate-400">
          No messages yet. Start the conversation below.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {turns.map((turn, index) => (
            <ChatTurn
              key={`${turn.at ?? "turn"}-${index}`}
              {...turn}
              companionName={companionName}
            />
          ))}
          {streamingTurn ? (
            <ChatTurn
              {...streamingTurn}
              companionName={companionName}
              streaming
            />
          ) : null}
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}