import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useChat } from "@ai-sdk/react";
import { MessageSquareText, Sparkles, Waypoints, X } from "lucide-react";

import {
  Conversation,
  ConversationContent,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import { PromptInput } from "@/components/ai-elements/prompt-input";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAiStatus } from "@/lib/use-ai-status";
import { cn } from "@/lib/utils";
import {
  filesOfMessage,
  studioChatTransport,
  textOfMessage,
} from "@/studio/chat";
import { useStudioSession } from "@/studio/use-studio-session";
import { StudioWorkspace } from "@/studio/studio-workspace";

/** The empty state's example prompts (GP-141) — clicking one submits it. */
const SUGGESTIONS = [
  "Create a resource group with a vnet and two subnets",
  "A Linux VM behind a load balancer, locked down by an NSG",
  "A web app with a storage account and a Key Vault",
  "An AKS cluster with its own vnet and a container registry",
];

/**
 * AI mode (GP-141): a route, not a modal — back/refresh behave sanely — but
 * rendered as a full-screen rounded surface over its own backdrop, entered
 * from the sidebar's mode switch. Opens on a centered chat; once a session
 * exists the chat docks left and the canvas region (GP-142) takes the rest.
 */
export function StudioPage() {
  const navigate = useNavigate();
  const ai = useAiStatus();
  const session = useStudioSession();
  const [confirmExit, setConfirmExit] = useState(false);
  // Mobile shows one pane at a time: the chat, or the graph (GP-141).
  const [mobilePane, setMobilePane] = useState<"chat" | "graph">("chat");

  // The transport reads the *current* files at send time (never a stale copy).
  const transport = useMemo(
    () => studioChatTransport(session.filesRef),
    [session.filesRef],
  );

  const { messages, sendMessage, stop, status, error, clearError } = useChat({
    transport,
    onFinish: ({ message }) => {
      const files = filesOfMessage(message);
      if (files) session.commitTurn(files);
    },
  });

  const streaming = status === "submitted" || status === "streaming";
  const docked = messages.length > 0;
  const hasWork = session.hasWork || messages.length > 0;

  function requestExit() {
    if (hasWork) setConfirmExit(true);
    else navigate("/dashboard");
  }

  // Esc asks to leave (with the same confirm) — the mode switch in reverse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (hasWork) setConfirmExit(true);
        else navigate("/dashboard");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hasWork, navigate]);

  // A session is memory only; closing the tab deserves the browser's warning.
  useEffect(() => {
    if (!hasWork) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasWork]);

  function submit(text: string) {
    clearError();
    void sendMessage({ text });
  }

  // No AI surface when the layer is off — the page only says why it is empty
  // (reachable by URL; the sidebar never links here with AI disabled).
  if (ai && !ai.enabled) {
    return (
      <div className="bg-background fixed inset-0 z-40 grid place-items-center p-4">
        <div className="bg-card max-w-sm rounded-lg border border-border p-6 text-center">
          <p className="font-display text-lg font-semibold">AI studio is off</p>
          <p className="text-muted-foreground mt-2 text-sm">
            This deployment has no AI configured (see Settings → AI), so there
            is no studio to open.
          </p>
          <Button className="mt-4" onClick={() => navigate("/dashboard")}>
            Back to dashboard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-ink/20 fixed inset-0 z-40 p-2 md:p-4">
      <div className="bg-background flex h-full flex-col overflow-hidden rounded-xl border border-border shadow-xl">
        <header className="bg-card flex items-center justify-between border-b border-border px-4 py-2.5">
          <p className="flex items-center gap-2 font-display text-sm font-semibold">
            <Sparkles className="text-primary size-4" />
            AI Infrastructure Studio
            <span className="text-muted-foreground font-mono text-[10px] tracking-[0.12em] uppercase">
              Azure
            </span>
          </p>
          <div className="flex items-center gap-1.5">
            {/* Mobile: one pane at a time once a session exists. */}
            {docked && (
              <div className="flex md:hidden">
                <Button
                  variant={mobilePane === "chat" ? "secondary" : "ghost"}
                  size="sm"
                  aria-label="Show chat"
                  onClick={() => setMobilePane("chat")}
                >
                  <MessageSquareText className="size-4" />
                </Button>
                <Button
                  variant={mobilePane === "graph" ? "secondary" : "ghost"}
                  size="sm"
                  aria-label="View graph"
                  onClick={() => setMobilePane("graph")}
                >
                  <Waypoints className="size-4" />
                </Button>
              </div>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Exit AI studio"
              title="Exit AI studio (Esc)"
              onClick={requestExit}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        {docked ? (
          <div className="flex min-h-0 flex-1">
            {/* The docked chat: fixed-width rail on desktop, full width on
                mobile when the chat pane is selected. */}
            <section
              aria-label="Studio chat"
              className={cn(
                "border-border flex min-h-0 w-full flex-col border-r md:w-[380px] md:shrink-0",
                mobilePane !== "chat" && "hidden md:flex",
              )}
            >
              <ChatColumn
                messages={messages}
                streaming={streaming}
                waiting={status === "submitted"}
                error={error}
                onSubmit={submit}
                onStop={stop}
              />
            </section>
            <section
              aria-label="Studio diagram"
              className={cn(
                "min-h-0 flex-1",
                mobilePane !== "graph" && "hidden md:block",
              )}
            >
              <StudioWorkspace session={session} messages={messages} />
            </section>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            <div className="w-full max-w-xl">
              <h1 className="font-display text-center text-2xl font-semibold">
                What should we build?
              </h1>
              <p className="text-muted-foreground mt-2 text-center text-sm">
                Describe Azure infrastructure in plain language. The studio
                writes the Terraform and draws it live — nothing is deployed,
                nothing is stored.
              </p>
              <PromptInput
                className="mt-6"
                onSubmit={submit}
                streaming={streaming}
                onStop={stop}
              />
              <Suggestions className="mt-4">
                {SUGGESTIONS.map((s) => (
                  <Suggestion key={s} suggestion={s} onClick={submit} />
                ))}
              </Suggestions>
            </div>
          </div>
        )}
      </div>

      {/* Leaving loses the session (in-memory only, GP-141) — say so once. */}
      <Dialog open={confirmExit} onOpenChange={setConfirmExit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display">Leave AI studio?</DialogTitle>
            <DialogDescription>
              Your session lives in this tab only — the conversation and the
              generated files will be lost. Download the project first if you
              want to keep it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmExit(false)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              onClick={() => navigate("/dashboard")}
            >
              Leave
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ChatColumn({
  messages,
  streaming,
  waiting,
  error,
  onSubmit,
  onStop,
}: Readonly<{
  messages: ReturnType<typeof useChat>["messages"];
  streaming: boolean;
  /** Submitted but nothing streamed yet — the shimmer's moment. */
  waiting: boolean;
  error: Error | undefined;
  onSubmit: (text: string) => void;
  onStop: () => void;
}>) {
  return (
    <>
      <Conversation>
        <ConversationContent>
          {messages.map((message) => {
            const text = textOfMessage(message);
            if (message.role !== "user" && message.role !== "assistant") {
              return null;
            }
            if (!text && !waiting) return null;
            return (
              <Message key={message.id} from={message.role}>
                <MessageContent from={message.role}>
                  {text ? (
                    <span className="whitespace-pre-wrap">{text}</span>
                  ) : (
                    <Shimmer className="w-40" />
                  )}
                </MessageContent>
              </Message>
            );
          })}
          {waiting && (
            <Message from="assistant">
              <MessageContent from="assistant">
                <Shimmer className="w-40" />
              </MessageContent>
            </Message>
          )}
          {error && (
            <div
              role="alert"
              className="bg-delete-soft text-delete rounded-lg border border-delete/30 px-3.5 py-2.5 text-sm"
            >
              {error.message || "The generation failed. Try again."}
            </div>
          )}
        </ConversationContent>
      </Conversation>
      <div className="border-border border-t p-3">
        <PromptInput onSubmit={onSubmit} streaming={streaming} onStop={onStop} />
      </div>
    </>
  );
}
