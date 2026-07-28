"use client";

import {
  FormEvent,
  Fragment,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Dialog, Transition } from "@headlessui/react";
import { useCompletion } from "@ai-sdk/react";
import type { Turn } from "@/app/utils/transcript";
import { getHistory } from "@/components/actions";
import ChatHistory from "@/components/ChatHistory";

type Companion = {
  name: string;
  llm: string;
};

type QAModalProps = {
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  example: Companion;
};

/**
 * Owns the browser conversation lifecycle for the selected companion.
 * Stored turns load through an authenticated server action while new replies
 * stream directly from the companion's configured model route.
 */
export default function QAModal({
  open,
  setOpen,
  example,
}: QAModalProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const shouldCommitCompletionRef = useRef(false);

  const {
    completion,
    input,
    isLoading,
    handleInputChange,
    handleSubmit,
    error: completionError,
    stop,
    setInput,
    setCompletion,
  } = useCompletion({
    api: "/api/" + example.llm,
    headers: { name: example.name },
    // The model routes respond with a plain text stream
    // (createTextStreamResponse); the default "data" protocol would try to
    // parse it as SSE UI-message events and fail.
    streamProtocol: "text",
    onFinish: (_prompt, finishedCompletion) => {
      if (shouldCommitCompletionRef.current && finishedCompletion.trim()) {
        setTurns((currentTurns) => [
          ...currentTurns,
          { speaker: "companion", text: finishedCompletion },
        ]);
      }
      shouldCommitCompletionRef.current = false;
      setCompletion("");
    },
  });

  useEffect(() => {
    if (!open || !example.name) {
      return;
    }

    let active = true;
    setHistoryLoading(true);
    setHistoryError(null);
    setTurns([]);

    getHistory(example.name)
      .then((history) => {
        if (active) {
          setTurns(history);
        }
      })
      .catch((error) => {
        console.error("Failed to load chat history", error);
        if (active) {
          setHistoryError("The conversation could not be loaded. Please close the chat and try again.");
        }
      })
      .finally(() => {
        if (active) {
          setHistoryLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [open, example.name]);

  const submitPrompt = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const prompt = input.trim();
    if (!prompt || isLoading || historyLoading) {
      return;
    }

    setTurns((currentTurns) => [
      ...currentTurns,
      { speaker: "user", text: prompt },
    ]);
    shouldCommitCompletionRef.current = true;
    handleSubmit(event);
    setInput("");
  };

  const handleClose = () => {
    shouldCommitCompletionRef.current = false;
    stop();
    setInput("");
    setCompletion("");
    setTurns([]);
    setHistoryError(null);
    setOpen(false);
  };

  const streamingTurn: Turn | undefined = completion
    ? { speaker: "companion", text: completion }
    : isLoading
      ? { speaker: "companion", text: "" }
      : undefined;

  return (
    <Transition.Root show={open} as={Fragment}>
      <Dialog as="div" className="relative z-10" onClose={handleClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-gray-950 bg-opacity-75 transition-opacity" />
        </Transition.Child>

        <div className="fixed inset-0 z-10 overflow-y-auto">
          <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-6">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
              enterTo="opacity-100 translate-y-0 sm:scale-100"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 translate-y-0 sm:scale-100"
              leaveTo="opacity-0 translate-y-4 sm:translate-y-0 sm:scale-95"
            >
              <Dialog.Panel className="relative flex h-[min(46rem,calc(100dvh-2rem))] w-full max-w-3xl transform flex-col overflow-hidden rounded-lg bg-gray-800 px-4 pb-4 pt-5 text-left shadow-xl ring-1 ring-white/10 transition-all sm:my-8 sm:p-6">
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-3">
                    <div>
                      <Dialog.Title className="text-base font-semibold text-white">
                        {example.name}
                      </Dialog.Title>
                      <p className="mt-1 text-sm text-slate-400">
                        Conversation history
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleClose}
                      className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-xl leading-none text-slate-400 hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                      aria-label="Close conversation"
                    >
                      &times;
                    </button>
                  </div>

                  <ChatHistory
                    turns={turns}
                    companionName={example.name}
                    loading={historyLoading}
                    error={historyError}
                    streamingTurn={streamingTurn}
                  />

                  {completionError ? (
                    <p role="alert" className="mb-2 text-sm text-rose-300">
                      {completionError.message || "The response could not be completed."}
                    </p>
                  ) : null}

                  <form onSubmit={submitPrompt} className="border-t border-white/10 pt-4">
                    <label htmlFor="chat-prompt" className="sr-only">
                      Message {example.name}
                    </label>
                    <input
                      id="chat-prompt"
                      placeholder="How's your day?"
                      className="w-full flex-auto rounded-md border-0 bg-white/5 px-3.5 py-2 text-white shadow-sm ring-1 ring-inset ring-white/10 placeholder:text-slate-500 focus:ring-2 focus:ring-inset focus:ring-sky-400 disabled:cursor-not-allowed disabled:text-slate-500 sm:text-sm sm:leading-6"
                      value={input}
                      onChange={handleInputChange}
                      disabled={isLoading || historyLoading || Boolean(historyError)}
                      autoComplete="off"
                    />
                  </form>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition.Root>
  );
}
