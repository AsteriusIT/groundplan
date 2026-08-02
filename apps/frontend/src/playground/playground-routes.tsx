/**
 * The Playground mode's routes (GP-244), declared in one place so the app and
 * the tests agree on what the mode contains.
 *
 * Mounted at `/playground/*`, so the paths below are relative to it. An unknown
 * Playground route lands in the Editor rather than at the app's global
 * catch-all: somebody with a mistyped `/playground/…` link meant the Playground.
 */
import { Navigate, Route, Routes } from "react-router-dom";

import { PlaygroundBuildView } from "./build-view";
import { PlaygroundEditorView } from "./editor-view";
import { PlaygroundLayout } from "./playground-layout";

export function PlaygroundRoutes() {
  return (
    <Routes>
      <Route element={<PlaygroundLayout />}>
        <Route index element={<Navigate to="/playground/editor" replace />} />
        <Route path="editor" element={<PlaygroundEditorView />} />
        <Route path="build" element={<PlaygroundBuildView />} />
        <Route
          path="*"
          element={<Navigate to="/playground/editor" replace />}
        />
      </Route>
    </Routes>
  );
}
