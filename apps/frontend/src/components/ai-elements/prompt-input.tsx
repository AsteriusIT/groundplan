import { useRef, useState } from "react";
import type { KeyboardEvent, SyntheticEvent } from "react";
import { ArrowUp, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The chat input (GP-140): a textarea that submits on Enter (Shift+Enter for
 * a newline), with the send affordance flipping to Stop while streaming.
 */
export function PromptInput({
  onSubmit,
  onStop,
  streaming = false,
  disabled = false,
  placeholder = "Describe the infrastructure you want…",
  className,
}: Readonly<{
  onSubmit: (text: string) => void;
  /** Abort the in-flight generation; rendered only while `streaming`. */
  onStop?: () => void;
  streaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}>) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || disabled || streaming) return;
    onSubmit(trimmed);
    setText("");
    textareaRef.current?.focus();
  }

  function handleSubmit(event: SyntheticEvent) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        "bg-card focus-within:ring-ring/40 flex items-end gap-2 rounded-lg border border-border p-2 focus-within:ring-2",
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={2}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Message"
        className="placeholder:text-muted-foreground max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm outline-none"
      />
      {streaming && onStop ? (
        <Button
          type="button"
          size="icon"
          variant="outline"
          aria-label="Stop generating"
          onClick={onStop}
        >
          <Square className="size-4" />
        </Button>
      ) : (
        <Button
          type="submit"
          size="icon"
          aria-label="Send"
          disabled={disabled || text.trim() === ""}
        >
          <ArrowUp className="size-4" />
        </Button>
      )}
    </form>
  );
}
