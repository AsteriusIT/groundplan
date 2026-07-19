import type { UIMessage } from "ai";

import type { StudioSession } from "./use-studio-session";

/**
 * The studio's right-hand region (GP-141): where the generated infrastructure
 * appears. GP-142 renders the parsed snapshot on the shared canvas here; until
 * then the region names what it is waiting for.
 */
export function StudioWorkspace({
  session,
}: Readonly<{
  session: StudioSession;
  messages: UIMessage[];
}>) {
  return (
    <div className="blueprint-grid flex h-full items-center justify-center">
      <p className="text-muted-foreground max-w-sm px-4 text-center text-sm">
        {session.files.length === 0
          ? "The diagram appears here as soon as the first generation lands."
          : `${session.files.length} file(s) generated.`}
      </p>
    </div>
  );
}
