/**
 * The Playground's document (GP-244): the files, the parse, the draft they are
 * saved as, and the composition being built beside them.
 *
 * It lives above both views rather than inside either, because both are ways of
 * looking at one workspace: walking from the Editor to the Build Editor and
 * back must not lose an unsaved file, a rendered diagram or a half-composed
 * resource. The state was already shared when the two were modes of one page
 * (GP-133); making them routes changed the URL, not the document.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import {
  ApiError,
  deletePlaygroundDraft,
  generateBuilderTerraform,
  parsePlayground,
  updatePlaygroundDraft,
} from "@/api/client";
import type {
  IacType,
  PlaygroundDraft,
  PlaygroundFile,
  PlaygroundSnapshot,
} from "@/api/types";
import type { BuilderIssue } from "@groundplan/builder";

import { useBuilderGraph } from "@/builder/use-builder-graph";
import { useCatalog } from "@/builder/use-catalog";
import {
  EXAMPLE_FILES,
  fileIacType,
  isAllowedPath,
  modeFor,
} from "./playground-files";

export type ParseFailure = {
  message: string;
  /** path → message for the files the server named. */
  byFile: Map<string, string>;
};

export type PlaygroundDocument = ReturnType<typeof usePlaygroundDocument>;

export function usePlaygroundDocument() {
  const navigate = useNavigate();
  const [files, setFiles] = useState<PlaygroundFile[]>(EXAMPLE_FILES);
  const [activePath, setActivePath] = useState<string>(
    EXAMPLE_FILES[0]?.path ?? "",
  );
  // Which stack Visualize parses, and one snapshot slot per stack — flipping
  // the switch shows that mode's last render, never a blank canvas.
  const [iacType, setIacType] = useState<IacType>("terraform");
  const [snapshots, setSnapshots] = useState<
    Record<IacType, PlaygroundSnapshot | null>
  >({ terraform: null, kubernetes: null });
  const [parsing, setParsing] = useState(false);
  const [failure, setFailure] = useState<ParseFailure | null>(null);
  // GP-128: per-file content at the last Visualize — the "modified" baseline.
  const [parsedContent, setParsedContent] = useState<Map<
    string,
    string
  > | null>(null);
  // Drafts (GP-126): the loaded draft, the baseline of the last save (for the
  // dirty flag), and what a failed save has to say.
  const [draft, setDraft] = useState<{ id: string; name: string } | null>(null);
  const [savedSerial, setSavedSerial] = useState<string>(() =>
    JSON.stringify(EXAMPLE_FILES),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [deleteDraftOpen, setDeleteDraftOpen] = useState(false);
  // The composition (GP-133) and the catalog it is composed against (GP-238).
  // Owned here, not by the Build Editor, so a trip through the Editor leaves
  // both exactly as they were — including a schema somebody already waited for.
  const catalog = useCatalog();
  const builder = useBuilderGraph(catalog.defs);
  // The generation flow (GP-135): the preview, what the server refused, and
  // the note that says which of the two artefacts is now the truth.
  const [generated, setGenerated] = useState<PlaygroundFile[] | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<BuilderIssue[]>([]);
  const [oneWayNote, setOneWayNote] = useState(false);

  const active = files.find((f) => f.path === activePath) ?? null;
  const snapshot = snapshots[iacType];
  const present: Record<IacType, boolean> = {
    terraform: files.some((f) => fileIacType(f.path) === "terraform"),
    kubernetes: files.some((f) => fileIacType(f.path) === "kubernetes"),
  };
  const dirty = JSON.stringify(files) !== savedSerial;
  // A scratch playground is never "Saved" — it has nowhere to be saved to.
  const unsaved = !draft || dirty;

  // Mode follows the files only when the current side has none: opening a
  // manifests-only draft lands on Kubernetes; adding a manifest to a Terraform
  // playground never yanks the mode.
  useEffect(() => {
    setIacType((current) => modeFor(files, current));
  }, [files]);

  // Leaving with unsaved changes deserves a warning (GP-126).
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const runParse = useCallback(
    async (input: PlaygroundFile[], mode: IacType) => {
      setParsing(true);
      // What this parse saw, per file — the baseline the "modified" marker
      // compares against (GP-128). Recorded whether or not it succeeds: the
      // marker answers "did I change anything since I last looked?".
      setParsedContent(new Map(input.map((f) => [f.path, f.content])));
      try {
        const parsed = await parsePlayground(input, mode);
        setSnapshots((prev) => ({ ...prev, [mode]: parsed }));
        setFailure(null);
      } catch (err) {
        // The last valid render stays on the canvas — only the error changes.
        if (err instanceof ApiError) {
          setFailure({
            message: err.message,
            byFile: new Map(
              (err.fields ?? []).map((f) => [f.field, f.message]),
            ),
          });
        } else {
          setFailure({
            message: "Could not parse the files.",
            byFile: new Map(),
          });
        }
      } finally {
        setParsing(false);
      }
    },
    [],
  );

  const visualize = useCallback(
    () => runParse(files, iacType),
    [runParse, files, iacType],
  );

  /** Switching stacks never re-parses; the failure described the last parse, so it clears. */
  const switchIacType = useCallback((next: IacType) => {
    setIacType(next);
    setFailure(null);
  }, []);

  const saveCurrentDraft = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updatePlaygroundDraft(draft.id, { files });
      setSavedSerial(JSON.stringify(files));
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : "Could not save the draft.",
      );
    } finally {
      setSaving(false);
    }
  }, [draft, files]);

  /** Save, or start the Save as flow when nothing is saved yet (GP-129). */
  const save = useCallback(() => {
    if (files.length === 0) return;
    if (draft) void saveCurrentDraft();
    else setSaveOpen(true);
  }, [files.length, draft, saveCurrentDraft]);

  // Cmd/Ctrl+S saves in place — the browser's save dialog has nothing to offer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  /** Inline title rename → PUT, like renaming from the drafts list. */
  const renameDraft = useCallback(
    async (name: string) => {
      if (!draft || !name || name === draft.name) return;
      try {
        await updatePlaygroundDraft(draft.id, { name });
        setDraft({ ...draft, name });
      } catch (err) {
        setSaveError(
          err instanceof ApiError ? err.message : "Could not rename the draft.",
        );
      }
    },
    [draft],
  );

  /** Delete the open draft; the files stay as an unsaved playground. */
  const confirmDeleteDraft = useCallback(async () => {
    if (!draft) return;
    try {
      await deletePlaygroundDraft(draft.id);
      setDraft(null);
      setDeleteDraftOpen(false);
    } catch (err) {
      setSaveError(
        err instanceof ApiError ? err.message : "Could not delete the draft.",
      );
      setDeleteDraftOpen(false);
    }
  }, [draft]);

  const handleSaved = useCallback((saved: PlaygroundDraft) => {
    setDraft({ id: saved.id, name: saved.name });
    setSavedSerial(JSON.stringify(saved.files));
  }, []);

  /** Restore a draft's files and redraw — an invalid draft still opens. The
   *  mode is derived from what the draft holds before the auto-parse runs. */
  const openDraft = useCallback(
    (opened: PlaygroundDraft) => {
      const mode = modeFor(opened.files, iacType);
      setIacType(mode);
      setFiles(opened.files);
      setActivePath(opened.files[0]?.path ?? "");
      setDraft({ id: opened.id, name: opened.name });
      setSavedSerial(JSON.stringify(opened.files));
      setSaveError(null);
      void runParse(opened.files, mode);
    },
    [iacType, runParse],
  );

  const addFile = useCallback(
    (ext: "tf" | "yaml", folder = "") => {
      const prefix = folder ? `${folder}/` : "";
      let n = 1;
      while (files.some((f) => f.path === `${prefix}untitled-${n}.${ext}`)) {
        n += 1;
      }
      const path = `${prefix}untitled-${n}.${ext}`;
      setFiles((prev) => [...prev, { path, content: "" }]);
      setActivePath(path);
      return path;
    },
    [files],
  );

  const removeFile = useCallback(
    (path: string) => {
      setFiles((prev) => {
        const next = prev.filter((f) => f.path !== path);
        if (path === activePath) setActivePath(next[0]?.path ?? "");
        return next;
      });
    },
    [activePath],
  );

  /** Rename a file. An empty or colliding name is a no-op, not an error dialog. */
  const renameFile = useCallback(
    (oldPath: string, next: string) => {
      const name = next.trim();
      if (!name || name === oldPath || files.some((f) => f.path === name)) {
        return;
      }
      setFiles((prev) =>
        prev.map((f) => (f.path === oldPath ? { ...f, path: name } : f)),
      );
      setActivePath((current) => (current === oldPath ? name : current));
    },
    [files],
  );

  const updateContent = useCallback((path: string, content: string) => {
    setFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, content } : f)),
    );
  }, []);

  const ingestUploads = useCallback(async (list: FileList | File[]) => {
    const accepted = [...list].filter((file) => isAllowedPath(file.name));
    if (accepted.length === 0) return;
    const read = await Promise.all(
      accepted.map(async (file) => ({
        path: file.name,
        content: await file.text(),
      })),
    );
    setFiles((prev) => {
      // Same name replaces; new names append — re-uploading is an update.
      const merged = [...prev];
      for (const incoming of read) {
        const at = merged.findIndex((f) => f.path === incoming.path);
        if (at === -1) merged.push(incoming);
        else merged[at] = incoming;
      }
      return merged;
    });
    const first = read[0];
    if (first) setActivePath(first.path);
  }, []);

  /**
   * Generate (GP-135): the composition → files, previewed before they exist.
   * The button is only offered on a valid composition, so a 422 here is the
   * server disagreeing with the client's copy of the rules — it badges the same
   * nodes rather than becoming a sentence nobody can act on.
   */
  const generate = useCallback(async () => {
    setGenerating(true);
    setGenerateError(null);
    setServerIssues([]);
    try {
      const { files: written } = await generateBuilderTerraform(builder.graph);
      setGenerated(written);
    } catch (err) {
      if (err instanceof ApiError && err.status === 422 && err.fields) {
        setServerIssues(
          err.fields.flatMap((field) =>
            field.nodeId
              ? [
                  {
                    nodeId: field.nodeId,
                    reason: "invalid_value" as const,
                    message: field.message,
                  },
                ]
              : [],
          ),
        );
      }
      setGenerateError(
        err instanceof ApiError ? err.message : "Could not generate Terraform.",
      );
    } finally {
      setGenerating(false);
    }
  }, [builder.graph]);

  /** Paths the generation would overwrite — named before anything is written. */
  const collisions = useMemo(
    () =>
      (generated ?? [])
        .map((file) => file.path)
        .filter((path) => files.some((existing) => existing.path === path)),
    [generated, files],
  );

  /**
   * Confirm: the files land in the playground, the Editor takes over with the
   * first of them open, and the parse runs — so the loop closes on the diagram,
   * which is the whole point of the golden invariant.
   */
  const writeGenerated = useCallback(() => {
    if (!generated) return;
    const merged = [...files];
    for (const file of generated) {
      const at = merged.findIndex((existing) => existing.path === file.path);
      if (at === -1) merged.push(file);
      else merged[at] = file;
    }
    setFiles(merged);
    setActivePath(generated[0]?.path ?? activePath);
    setGenerated(null);
    setIacType("terraform");
    setOneWayNote(true);
    navigate("/playground/editor");
    void runParse(merged, "terraform");
  }, [generated, files, activePath, navigate, runParse]);

  return {
    files,
    setFiles,
    active,
    activePath,
    setActivePath,
    addFile,
    removeFile,
    renameFile,
    updateContent,
    ingestUploads,
    iacType,
    switchIacType,
    present,
    snapshot,
    parsing,
    failure,
    parsedContent,
    visualize,
    runParse,
    draft,
    unsaved,
    saving,
    saveError,
    save,
    saveCurrentDraft,
    renameDraft,
    handleSaved,
    openDraft,
    saveOpen,
    setSaveOpen,
    draftsOpen,
    setDraftsOpen,
    deleteDraftOpen,
    setDeleteDraftOpen,
    confirmDeleteDraft,
    setDraft,
    catalog,
    builder,
    generate,
    generating,
    generated,
    setGenerated,
    generateError,
    serverIssues,
    collisions,
    writeGenerated,
    oneWayNote,
    setOneWayNote,
  };
}
