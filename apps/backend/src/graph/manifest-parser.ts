/**
 * Producer B for Kubernetes (GP-102): the YAML manifests of a repository → the
 * Kubernetes objects they declare. Pure — files in, objects out; the clone is
 * `repo-docs`'s job, exactly as it is for the HCL parser this sits beside.
 *
 * The rule for what we keep is deliberately dumb, and that is a feature: a
 * document is a Kubernetes object if it says `apiVersion`, `kind` and
 * `metadata.name`. Everything else in a manifests repository — `values.yaml`,
 * `Chart.yaml`, a CI workflow, a kustomization — fails that test and is dropped
 * without a special case per filename. We do not need to recognise the world;
 * we need to recognise Kubernetes.
 *
 * **Skipped silently by rule, never silently by count.** A Helm chart's
 * `templates/*.yaml` is Go template source, not YAML, and will not parse — that is
 * expected and is not an error. But the snapshot records how many documents and
 * files were dropped, because "your diagram has three things in it" and "your
 * diagram has three things in it and we threw away forty" are different sentences
 * and the reader is owed the second one. A repository where *nothing* parses is
 * not a diagram at all: `repo-docs` refuses to store one, and the answer for
 * helm/kustomize repositories is to render in CI (GP-103).
 */
import { parseAllDocuments } from "yaml";

import type { K8sObject } from "./k8s-mapper.js";

export type ManifestFile = { path: string; content: string };

export type ManifestParseOptions = {
  /** The manifests directory; "" (the default) is the repository root. */
  rootDir?: string;
};

export type ManifestParseResult = {
  objects: K8sObject[];
  /** Documents that parsed as YAML but are not Kubernetes objects. */
  skippedDocuments: number;
  /** Files that are not YAML at all (a Helm template, most often). */
  skippedFiles: number;
  warnings: string[];
};

/**
 * Kinds that describe *how to build* manifests rather than what to run. They can
 * carry a `metadata.name`, so the shape test alone would let them through — and a
 * `Kustomization` node on the diagram tells a reviewer nothing about the system.
 */
const BUILD_KINDS = new Set(["Kustomization", "Component"]);

/** Thrown when YAML cannot be read at all. */
export class InvalidManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidManifestError";
  }
}

/**
 * Every document in a YAML stream, or nothing.
 *
 * Note this is a *YAML* parse, not the Kubernetes client's `loadAllYaml`: that one
 * deserializes each document into the typed model for its `apiVersion`/`kind`,
 * which is precisely wrong here — a CRD it has never heard of is exactly what we
 * still want to draw, and a manifest is whatever somebody typed.
 */
function readDocuments(text: string): unknown[] {
  const documents = parseAllDocuments(text, { logLevel: "silent" });
  for (const document of documents) {
    const [error] = document.errors;
    if (error) throw new InvalidManifestError(error.message);
  }
  return documents.map((document) => document.toJS() as unknown);
}

/** Does this file hold manifests? (Not "is it under `templates/`" — see the header.) */
export function isManifestPath(filePath: string): boolean {
  return filePath.endsWith(".yaml") || filePath.endsWith(".yml");
}

/** Is this path inside the manifests root? "" means the whole repository. */
function underRoot(filePath: string, rootDir: string): boolean {
  return rootDir === "" || filePath.startsWith(`${rootDir}/`);
}

/** A YAML document is a Kubernetes object when it says what it is and who it is. */
function isK8sObject(doc: unknown): doc is K8sObject {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
  const record = doc as Record<string, unknown>;
  const metadata = record["metadata"];
  const named =
    metadata !== null &&
    typeof metadata === "object" &&
    typeof (metadata as Record<string, unknown>)["name"] === "string" &&
    (metadata as Record<string, unknown>)["name"] !== "";
  return (
    typeof record["apiVersion"] === "string" &&
    typeof record["kind"] === "string" &&
    record["kind"] !== "" &&
    named
  );
}

/**
 * Parse every manifest under the root. Multi-document files (`---` separated) are
 * normal here and each document stands alone: one bad document costs its file, not
 * the repository.
 */
export function parseManifests(
  files: ManifestFile[],
  options: ManifestParseOptions = {},
): ManifestParseResult {
  const rootDir = options.rootDir ?? "";
  const objects: K8sObject[] = [];
  const warnings: string[] = [];
  let skippedDocuments = 0;
  let skippedFiles = 0;

  const inScope = files
    .filter((file) => isManifestPath(file.path) && underRoot(file.path, rootDir))
    .sort((a, b) => a.path.localeCompare(b.path));

  if (inScope.length === 0) {
    warnings.push(
      rootDir
        ? `no .yaml/.yml files found in '${rootDir}'`
        : "no .yaml/.yml files found in this repository",
    );
  }

  for (const file of inScope) {
    let documents: unknown[];
    try {
      // A Helm template is Go source that happens to end in .yaml. It will throw,
      // and that is not an error — it is the reason GP-103 exists.
      documents = readDocuments(file.content);
    } catch {
      skippedFiles += 1;
      warnings.push(`skipped ${file.path}: not valid YAML`);
      continue;
    }

    for (const doc of documents) {
      // An empty document (a trailing `---`) is nothing at all, not a skip.
      if (doc === null || doc === undefined) continue;
      if (!isK8sObject(doc) || BUILD_KINDS.has(doc.kind as string)) {
        skippedDocuments += 1;
        continue;
      }
      objects.push(doc);
    }
  }

  if (skippedDocuments > 0) {
    warnings.push(
      `${skippedDocuments} YAML document(s) were not Kubernetes objects and were skipped`,
    );
  }
  if (skippedFiles > 0) {
    warnings.push(
      `${skippedFiles} file(s) could not be parsed as YAML and were skipped — templated charts are rendered by your CI (see the Kubernetes setup snippet)`,
    );
  }

  return { objects, skippedDocuments, skippedFiles, warnings };
}

/**
 * Parse rendered manifests posted by CI (GP-103): one YAML stream, no repository,
 * no root. A body we cannot read is a hard error here — unlike a repository walk,
 * where a single unreadable file is just a file, a rendered stream *is* the
 * payload, and half of one is not something to store.
 */
export function parseManifestStream(body: string): K8sObject[] {
  let documents: unknown[];
  try {
    documents = readDocuments(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new InvalidManifestError(`rendered manifests are not valid YAML: ${message}`);
  }
  return documents.filter(
    (doc): doc is K8sObject =>
      doc !== null && isK8sObject(doc) && !BUILD_KINDS.has(doc.kind as string),
  );
}
