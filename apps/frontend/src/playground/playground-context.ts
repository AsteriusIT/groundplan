/**
 * The Playground document, shared by the two views (GP-244). The layout owns
 * it; Editor and Build Editor read it. A view rendered outside the layout is a
 * programming error, not a state to design for — hence the throw.
 */
import { createContext, useContext } from "react";

import type { PlaygroundDocument } from "./use-playground-document";

export const PlaygroundContext = createContext<PlaygroundDocument | null>(null);

export function usePlayground(): PlaygroundDocument {
  const value = useContext(PlaygroundContext);
  if (!value) {
    throw new Error("usePlayground must be used inside the Playground layout");
  }
  return value;
}
