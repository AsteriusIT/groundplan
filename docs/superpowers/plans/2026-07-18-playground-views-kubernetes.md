# Playground Views + Kubernetes Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The playground parses Kubernetes manifests as well as Terraform (a centered logo switch picks the stack), and Terraform snapshots get the Global / Network / IAM lenses.

**Architecture:** `POST /playground/parse` gains an optional `iacType` that branches to the existing repo-docs Kubernetes pipeline (`parseManifests` → `mapK8sObjects`); the shared extension allowlist widens so drafts hold `.yaml` with no schema change. The frontend keeps one snapshot per mode, renders an `IacSwitch` (official logomarks via `IacTypeMark`) centered in the header, and reuses `ViewSwitcher`/`networkProjection`/`IamTable` through a new `"playground"` variant.

**Tech Stack:** Fastify + node:test (backend), React 19 + vitest + Testing Library + vitest-axe (frontend). Spec: `docs/superpowers/specs/2026-07-18-playground-views-kubernetes-design.md`.

## Global Constraints

- Backend tests run via `pnpm --filter @groundplan/backend test` (never bare `node --test` — .env OIDC would 401 every inject). A single file: `pnpm --filter @groundplan/backend exec node --test --import tsx --test-reporter spec src/routes/playground.test.ts` with `NODE_ENV=test` — in practice always prefer the filtered `pnpm test`.
- Frontend tests: `pnpm --filter @groundplan/frontend test` (vitest run). Single file: `pnpm --filter @groundplan/frontend exec vitest run src/pages/playground-page.test.tsx`.
- Relative backend imports use `.js` extensions (ESM NodeNext) even from `.ts` files.
- Never hardcode a colour — semantic Tailwind token utilities only (`design-tokens.test.ts` guards).
- Vendor logos render **unmodified** via `IacTypeMark` (`apps/frontend/ICONS.md` rule).
- One commit per story: `feat(scope): subject (GP-xx)`, body ends with the Claude co-author line. Resolve real GP numbers first (Task 0); after each commit, transition its Jira story to Done (transition id 41).
- Response shape of parse stays `{graph, stats, summaryMd}`; error shape stays `{error, message, fields?}`.

---

### Task 0: Resolve Jira story numbers

**Files:** none (Jira only).

- [ ] **Step 1:** Search Jira for the three stories: `mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql` with JQL `project = GP AND status != Done AND (summary ~ "playground") ORDER BY key` (load the tool schema via ToolSearch first). Expect stories covering: Kubernetes parse in playground, the Terraform/Kubernetes switch, playground views. Likely keys: GP-131..GP-133.
- [ ] **Step 2:** Map each of Tasks 1–3 to a story key and substitute it for `GP-xxx` in that task's commit step. If a task has no matching story, commit **without** a GP suffix and flag it in the final report — do not invent numbers, do not create issues.

---

### Task 1: Backend — `iacType` branch on `POST /playground/parse`, drafts accept `.yaml`

**Files:**
- Modify: `apps/backend/src/routes/playground.ts`
- Test: `apps/backend/src/routes/playground.test.ts`

**Interfaces:**
- Consumes (all existing): `parseManifests(files)` from `../graph/manifest-parser.js` (self-filters to `.yaml/.yml`, returns `{objects, skippedDocuments, skippedFiles, warnings}`); `mapK8sObjects(objects, { unresolved })` from `../graph/k8s-mapper.js`; `type UnresolvedReference` from `../graph/graph.js`; `parseHclRepo` (self-filters to `.tf`).
- Produces: `POST /api/v1/playground/parse` accepting optional body field `iacType: "terraform" | "kubernetes"` (default `"terraform"`); drafts endpoints accepting `.yaml`/`.yml` paths. Task 2's client sends `{files, iacType}`.

- [ ] **Step 1: Write the failing tests** — append to `apps/backend/src/routes/playground.test.ts`:

```ts
/** A deployment + service in one namespace, plus a values.yaml that is YAML
 *  but not Kubernetes — the minimal "real" manifests playground. */
const K8S_FILES = [
  {
    path: "app.yaml",
    content: [
      `apiVersion: apps/v1`,
      `kind: Deployment`,
      `metadata:`,
      `  name: api`,
      `  namespace: prod`,
      `spec:`,
      `  selector:`,
      `    matchLabels:`,
      `      app: api`,
      `---`,
      `apiVersion: v1`,
      `kind: Service`,
      `metadata:`,
      `  name: api`,
      `  namespace: prod`,
      `spec:`,
      `  selector:`,
      `    app: api`,
    ].join("\n"),
  },
  { path: "values.yaml", content: `replicas: 3\nimage: api:latest\n` },
];

test("POST /playground/parse iacType=kubernetes: manifests → graph, stats carry skips", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: K8S_FILES, iacType: "kubernetes" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    const ids = body.graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("prod/Deployment/api"), `namespace-qualified id, got ${ids}`);
    assert.ok(ids.includes("prod/Service/api"));
    // values.yaml parsed as YAML but is not a Kubernetes object — counted, not fatal.
    assert.equal(body.stats.skippedDocuments, 1);
    assert.equal(body.stats.skippedFiles, 0);
    assert.equal(typeof body.summaryMd, "string");
  } finally {
    await app.close();
  }
});

test("POST /playground/parse iacType=kubernetes: .tf files in the set are ignored", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: [...K8S_FILES, ...CROSS_FILE_HCL], iacType: "kubernetes" },
    });
    assert.equal(res.statusCode, 200);
    const ids = res.json().graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(!ids.some((id: string) => id.startsWith("azurerm_")));
  } finally {
    await app.close();
  }
});

test("POST /playground/parse default terraform: .yaml files in the set are ignored", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: [...CROSS_FILE_HCL, ...K8S_FILES] },
    });
    assert.equal(res.statusCode, 200);
    const ids = res.json().graph.nodes.map((n: { id: string }) => n.id);
    assert.ok(!ids.some((id: string) => id.includes("Deployment")));
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: zero files matching the mode is a 422", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const noTf = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: K8S_FILES }, // default terraform
    });
    assert.equal(noTf.statusCode, 422);
    assert.equal(noTf.json().message, "no .tf files to parse");

    const noYaml = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL, iacType: "kubernetes" },
    });
    assert.equal(noYaml.statusCode, 422);
    assert.equal(noYaml.json().message, "no .yaml manifests to parse");
  } finally {
    await app.close();
  }
});

test("POST /playground/parse iacType=kubernetes: unreadable YAML is a 422 naming the file", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: {
        files: [
          // A Helm template: Go source that happens to end in .yaml.
          { path: "tpl.yaml", content: `apiVersion: v1\nkind: {{ .Values.kind }\n  :bad` },
        ],
        iacType: "kubernetes",
      },
    });
    assert.equal(res.statusCode, 422);
    const body = res.json();
    assert.equal(body.message, "YAML parse failed");
    assert.equal(body.fields[0].field, "tpl.yaml");
  } finally {
    await app.close();
  }
});

test("POST /playground/parse iacType=kubernetes: YAML holding no Kubernetes objects is a 422", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: {
        files: [{ path: "values.yaml", content: `replicas: 3\n` }],
        iacType: "kubernetes",
      },
    });
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().message, "no Kubernetes objects found in the .yaml files");
  } finally {
    await app.close();
  }
});

test("POST /playground/parse: an unknown iacType is a 400", async () => {
  const app = await buildApp(env, { pool: poisonedPool() });
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/parse",
      payload: { files: CROSS_FILE_HCL, iacType: "pulumi" },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await app.close();
  }
});
```

Also add a drafts test (find the existing draft-creation test for the pattern — it uses `buildTestApp()` + `authHeader()`; mirror its setup exactly, only the payload differs):

```ts
test("POST /playground/drafts: a draft may hold .yaml manifests", async () => {
  const { app } = await buildTestApp(env);
  try {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/playground/drafts",
      headers: await authHeader(),
      payload: { name: "k8s scratch", files: K8S_FILES },
    });
    assert.equal(res.statusCode, 201);
  } finally {
    await app.close();
  }
});
```

Note: `buildTestApp`'s actual return shape/signature is in `src/test-support.ts` — copy the call form the existing draft tests in this same file use, keeping only the `.yaml` payload as the new element.

- [ ] **Step 2: Run tests, verify the new ones fail**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -30`
Expected: the new tests FAIL — `iacType` is rejected by `additionalProperties: false` (400 where 200/422 expected) and `.yaml` files 422 on the allowlist. Existing tests still pass.

- [ ] **Step 3: Implement the branch in `apps/backend/src/routes/playground.ts`**

Imports (top of file):

```ts
import type { Graph, UnresolvedReference } from "../graph/graph.js";
import { mapK8sObjects } from "../graph/k8s-mapper.js";
import { parseManifests } from "../graph/manifest-parser.js";
```

(`assertValidGraph`, `computeGraphStats`, `parseHclRepo`, `summarize` are already imported. If `Graph` ends up unused, don't import it — `noUnusedLocals` fails the build.)

Widen the allowlist and add the body field:

```ts
const ALLOWED_EXTENSIONS = [".tf", ".tfvars", ".yaml", ".yml"];

export type PlaygroundIacType = "terraform" | "kubernetes";

const parseBodySchema = {
  type: "object",
  required: ["files"],
  additionalProperties: false,
  properties: {
    files: playgroundFilesSchema,
    iacType: { type: "string", enum: ["terraform", "kubernetes"] },
  },
};
```

Update `rejectInvalidFiles`'s per-file message to name all four extensions:

```ts
      message: "only .tf, .tfvars, .yaml and .yml files are allowed",
```

(One existing test asserts the old message — update it to the new one.)

Extract the warning→fields mapping (it is now shared by both branches) as a module-level helper, replacing the inline `skipped` block in the parse handler:

```ts
/** `skipped <path>: <why>` warnings → the 422 `fields` shape, naming each file. */
function skippedFields(warnings: string[]): { field: string; message: string }[] {
  return warnings.flatMap((w) => {
    const match = /^skipped (.+?): (.+)$/.exec(w);
    return match ? [{ field: match[1] ?? "", message: match[2] ?? "" }] : [];
  });
}
```

Rewrite the parse route handler to branch (the terraform path is the existing body verbatim, minus the extracted helper, plus the zero-`.tf` check):

```ts
  app.post(
    "/playground/parse",
    { bodyLimit: PARSE_BODY_LIMIT, schema: { body: parseBodySchema } },
    async (request, reply) => {
      const { files, iacType = "terraform" } = request.body as {
        files: HclFile[];
        iacType?: PlaygroundIacType;
      };
      if (rejectInvalidFiles(files, reply)) return;
      // Both parsers select their own subset of the set (`.tf` / `.yaml`), the
      // way the repo-docs producers do (GP-101) — but a mode with nothing to
      // parse is a 422, never a silently empty diagram.
      return iacType === "kubernetes"
        ? parseKubernetes(files, reply)
        : parseTerraform(files, reply);
    },
  );
```

with the two producers above the plugin:

```ts
function parseTerraform(files: HclFile[], reply: FastifyReply) {
  if (!files.some((f) => f.path.endsWith(".tf"))) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "no .tf files to parse",
    });
  }
  const { graph, warnings, unresolvedReferences } = parseHclRepo(files);

  // A file the scanner had to skip is a parse failure the user must fix —
  // surface it as a 422 naming the file, never as a silently thinner graph.
  const skipped = skippedFields(warnings);
  if (skipped.length > 0) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "HCL parse failed",
      fields: skipped,
    });
  }

  assertValidGraph(graph);
  const stats = {
    ...computeGraphStats(graph),
    warnings,
    ...(unresolvedReferences.length > 0 ? { unresolvedReferences } : {}),
  };
  return { graph, stats, summaryMd: summarize(graph) };
}

/**
 * GP-xxx: the repo-docs Kubernetes pipeline (GP-102), minus the clone and the
 * insert — parse the YAML subset, map the objects, and answer ephemerally.
 */
function parseKubernetes(files: HclFile[], reply: FastifyReply) {
  if (!files.some((f) => f.path.endsWith(".yaml") || f.path.endsWith(".yml"))) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "no .yaml manifests to parse",
    });
  }
  const result = parseManifests(files);

  // In a repository walk an unreadable file is just a file; here the user
  // pasted it, so it is theirs to fix — the HCL branch's exact rule.
  const skipped = skippedFields(result.warnings);
  if (skipped.length > 0) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "YAML parse failed",
      fields: skipped,
    });
  }
  if (result.objects.length === 0) {
    return reply.code(422).send({
      error: "Unprocessable Entity",
      message: "no Kubernetes objects found in the .yaml files",
    });
  }

  const unresolved: UnresolvedReference[] = [];
  const graph = mapK8sObjects(result.objects, { unresolved });
  assertValidGraph(graph);
  const stats = {
    ...computeGraphStats(graph),
    warnings: result.warnings,
    skippedDocuments: result.skippedDocuments,
    skippedFiles: result.skippedFiles,
    ...(unresolved.length > 0 ? { unresolvedReferences: unresolved } : {}),
  };
  return { graph, stats, summaryMd: summarize(graph) };
}
```

Replace `GP-xxx` in the doc comment with the real story key from Task 0. Update the file's and route's doc comments to say the playground now parses either stack.

- [ ] **Step 4: Run the backend suite**

Run: `pnpm --filter @groundplan/backend test 2>&1 | tail -15`
Expected: all pass (including the previously failing new ones). If the k8s happy path fails on node ids, print the actual ids — `mapK8sObjects` namespace-qualifies as `prod/Deployment/api` (see `k8s-mapper.test.ts` for ground truth) — and fix the *test's* expectation only if it contradicts that ground truth.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @groundplan/backend typecheck`
Then:

```bash
git add apps/backend/src/routes/playground.ts apps/backend/src/routes/playground.test.ts
git commit -m "feat(backend): playground parses Kubernetes manifests — iacType branch, drafts hold yaml (GP-xxx)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — client `iacType`, centered switch, Kubernetes mode

**Files:**
- Create: `apps/frontend/src/components/iac-switch.tsx`
- Modify: `apps/frontend/src/api/client.ts` (`parsePlayground`)
- Modify: `apps/frontend/src/pages/playground-page.tsx`
- Test: `apps/frontend/src/api/client.playground.test.ts`, `apps/frontend/src/pages/playground-page.test.tsx`

**Interfaces:**
- Consumes: Task 1's `iacType` body field; existing `IacTypeMark({iacType, className, alt?})` from `@/components/iac-type-mark`; `IAC_TYPES` (`{id, label}[]`) from `@/lib/iac-type`; `type IacType` from `@/api/types`.
- Produces: `parsePlayground(files: PlaygroundFile[], iacType: IacType = "terraform")`; `IacSwitch({value, onChange, present})`; page state Task 3 relies on: `iacType: IacType`, `snapshots: Record<IacType, PlaygroundSnapshot | null>`, module helper `fileIacType(path): IacType`.

- [ ] **Step 1: Write the failing client test** — in `client.playground.test.ts`, update the existing parse-body assertion and add a kubernetes one:

In the existing `parsePlayground POSTs the files…` test, the body assertion becomes:

```ts
  expect(JSON.parse(String(init.body))).toEqual({ files: FILES, iacType: "terraform" });
```

New test beside it (mirror the existing test's fetch-mock setup lines exactly):

```ts
it("parsePlayground sends the chosen iacType", async () => {
  // …same fetch mock arrangement as the test above…
  await parsePlayground(FILES, "kubernetes");
  const [, init] = fetchMock.mock.calls[0]!;
  expect(JSON.parse(String(init!.body))).toEqual({ files: FILES, iacType: "kubernetes" });
});
```

- [ ] **Step 2: Run it, verify failure**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/api/client.playground.test.ts`
Expected: FAIL — body has no `iacType`, and the 2-arg call does not typecheck/exist yet.

- [ ] **Step 3: Implement `parsePlayground`** in `apps/frontend/src/api/client.ts` (add `IacType` to the existing type-import from `./types`):

```ts
/** Parse files into an ephemeral snapshot — nothing is persisted. The server
 *  parses only the subset matching `iacType` and ignores the rest. */
export function parsePlayground(
  files: PlaygroundFile[],
  iacType: IacType = "terraform",
): Promise<PlaygroundSnapshot> {
  return request<PlaygroundSnapshot>("/playground/parse", {
    method: "POST",
    body: { files, iacType },
  });
}
```

Run: `pnpm --filter @groundplan/frontend exec vitest run src/api/client.playground.test.ts` — Expected: PASS.

- [ ] **Step 4: Write the failing page tests** — append to `playground-page.test.tsx` (its `renderPage()` helper and mocks already exist; reuse them):

```ts
const K8S_DRAFT: PlaygroundDraft = {
  id: "d2",
  name: "manifests",
  files: [
    {
      path: "app.yaml",
      content: "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\n",
    },
  ],
  createdAt: "2026-07-18T00:00:00Z",
  updatedAt: "2026-07-18T00:00:00Z",
};

it("renders both switch sides; Kubernetes is disabled without .yaml files", () => {
  renderPage();
  const tf = screen.getByRole("button", { name: "Terraform" });
  const k8s = screen.getByRole("button", { name: "Kubernetes" });
  expect(tf).toHaveAttribute("aria-pressed", "true");
  expect(k8s).toBeDisabled();
  expect(k8s).toHaveAttribute("title", "No .yaml files");
});

it("New manifest enables the Kubernetes side; switching mutes the .tf files", async () => {
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Add or upload files" }));
  fireEvent.click(await screen.findByText("New manifest"));
  const k8s = screen.getByRole("button", { name: "Kubernetes" });
  expect(k8s).toBeEnabled();
  fireEvent.click(k8s);
  expect(k8s).toHaveAttribute("aria-pressed", "true");
  // The .tf example files stay listed, muted as not-in-this-view.
  expect(screen.getByRole("button", { name: "main.tf" })).toHaveAttribute(
    "title",
    "Not in the Kubernetes view",
  );
});

it("Visualize sends the active iacType and keeps one snapshot per mode", async () => {
  parsePlaygroundMock.mockResolvedValue(SNAPSHOT);
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");
  expect(parsePlaygroundMock).toHaveBeenCalledWith(expect.any(Array), "terraform");

  // A fresh manifest file, switch to Kubernetes: that mode has no snapshot yet.
  fireEvent.click(screen.getByRole("button", { name: "Add or upload files" }));
  fireEvent.click(await screen.findByText("New manifest"));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  expect(screen.queryByTestId("canvas")).not.toBeInTheDocument();

  // Flipping back shows Terraform's last render again — nothing was lost.
  fireEvent.click(screen.getByRole("button", { name: "Terraform" }));
  expect(screen.getByTestId("canvas")).toBeInTheDocument();
});

it("opening a manifests-only draft lands in Kubernetes mode and parses it as such", async () => {
  listDraftsMock.mockResolvedValue([
    { id: "d2", name: "manifests", updatedAt: K8S_DRAFT.updatedAt, fileCount: 1 },
  ]);
  getDraftMock.mockResolvedValue(K8S_DRAFT);
  parsePlaygroundMock.mockResolvedValue(SNAPSHOT);
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Draft actions" }));
  fireEvent.click(await screen.findByText("Open draft…"));
  fireEvent.click(await screen.findByText("manifests"));
  await waitFor(() =>
    expect(parsePlaygroundMock).toHaveBeenCalledWith(K8S_DRAFT.files, "kubernetes"),
  );
  expect(screen.getByRole("button", { name: "Kubernetes" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
```

Adjust the open-draft interaction lines to the file's existing open-draft test (same dialog, same queries) — the draft dialog flow is already tested there; copy its exact `fireEvent` sequence and only change the fixture. `SNAPSHOT` is the file's existing snapshot fixture; `PlaygroundDraft` fields must match the existing `DRAFT` fixture's shape.

- [ ] **Step 5: Run them, verify failure**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/pages/playground-page.test.tsx`
Expected: the four new tests FAIL (no switch buttons, no "New manifest" item, 1-arg parse call).

- [ ] **Step 6: Create `apps/frontend/src/components/iac-switch.tsx`**

```tsx
import type { IacType } from "@/api/types";
import { IacTypeMark } from "@/components/iac-type-mark";
import { IAC_TYPES } from "@/lib/iac-type";
import { cn } from "@/lib/utils";

const NO_FILES_HINT: Record<IacType, string> = {
  terraform: "No .tf files",
  kubernetes: "No .yaml files",
};

/**
 * The playground's stack switch: which of the two parsers Visualize runs. Both
 * sides always render — the official logomark (unmodified, ICONS.md) beside its
 * label — and a side with no matching files is disabled rather than hidden:
 * the way to a Kubernetes playground is adding a .yaml file, and a control you
 * can see but not press says exactly that.
 */
export function IacSwitch({
  value,
  onChange,
  present,
}: Readonly<{
  value: IacType;
  onChange: (next: IacType) => void;
  /** Which stacks currently have files. */
  present: Record<IacType, boolean>;
}>) {
  return (
    <fieldset
      aria-label="IaC type"
      className="border-border bg-background flex items-center gap-0.5 rounded-lg border p-0.5"
    >
      {IAC_TYPES.map(({ id, label }) => {
        const disabled = !present[id];
        return (
          <button
            key={id}
            type="button"
            aria-pressed={value === id}
            disabled={disabled}
            title={disabled ? NO_FILES_HINT[id] : undefined}
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-xs transition-colors",
              value === id
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
              disabled && "opacity-50",
            )}
          >
            <IacTypeMark iacType={id} className="size-3.5" />
            {label}
          </button>
        );
      })}
    </fieldset>
  );
}
```

- [ ] **Step 7: Rework `playground-page.tsx` for modes**

Module level — replace the `ALLOWED_EXTENSIONS` constant and add helpers (keep `isAllowedPath`):

```ts
const TF_EXTENSIONS = [".tf", ".tfvars"];
const K8S_EXTENSIONS = [".yaml", ".yml"];
/** Extensions the backend accepts (GP-123, widened for Kubernetes). */
const ALLOWED_EXTENSIONS = [...TF_EXTENSIONS, ...K8S_EXTENSIONS];

/** Which stack a file belongs to, by extension — the whole detection story. */
function fileIacType(path: string): IacType {
  return K8S_EXTENSIONS.some((ext) => path.endsWith(ext))
    ? "kubernetes"
    : "terraform";
}

/** The mode for a file set: the preferred side if it has files, else the other. */
function modeFor(files: PlaygroundFile[], preferred: IacType): IacType {
  const has = (t: IacType) => files.some((f) => fileIacType(f.path) === t);
  if (has(preferred)) return preferred;
  const other: IacType = preferred === "terraform" ? "kubernetes" : "terraform";
  return has(other) ? other : preferred;
}

const NOT_IN_VIEW: Record<IacType, string> = {
  terraform: "Not in the Terraform view",
  kubernetes: "Not in the Kubernetes view",
};
```

State — replace the single `snapshot` slot:

```ts
const [iacType, setIacType] = useState<IacType>("terraform");
const [snapshots, setSnapshots] = useState<
  Record<IacType, PlaygroundSnapshot | null>
>({ terraform: null, kubernetes: null });
const snapshot = snapshots[iacType];
const present: Record<IacType, boolean> = {
  terraform: files.some((f) => fileIacType(f.path) === "terraform"),
  kubernetes: files.some((f) => fileIacType(f.path) === "kubernetes"),
};
```

Auto-select only when the current side has emptied (deleting the last `.tf` of a mixed set hands over; adding a `.yaml` to a Terraform set does not):

```ts
// Mode follows the files only when the current side has none (GP-xxx): opening
// a manifests-only draft lands on Kubernetes; adding a manifest to a Terraform
// playground never yanks the mode.
useEffect(() => {
  setIacType((current) => modeFor(files, current));
}, [files]);
```

`runParse` gains the mode (and per-mode storage):

```ts
const runParse = useCallback(async (input: PlaygroundFile[], mode: IacType) => {
  setParsing(true);
  setParsedContent(new Map(input.map((f) => [f.path, f.content])));
  try {
    const parsed = await parsePlayground(input, mode);
    setSnapshots((prev) => ({ ...prev, [mode]: parsed }));
    setFailure(null);
  } catch (err) {
    if (err instanceof ApiError) {
      setFailure({
        message: err.message,
        byFile: new Map((err.fields ?? []).map((f) => [f.field, f.message])),
      });
    } else {
      setFailure({ message: "Could not parse the files.", byFile: new Map() });
    }
  } finally {
    setParsing(false);
  }
}, []);

const visualize = useCallback(
  () => runParse(files, iacType),
  [runParse, files, iacType],
);

/** Switching stacks never re-parses; the failure describes the last parse, so it clears. */
const switchIacType = useCallback((next: IacType) => {
  setIacType(next);
  setFailure(null);
}, []);
```

`openDraft` derives the mode before its auto-parse:

```ts
function openDraft(opened: PlaygroundDraft) {
  const mode = modeFor(opened.files, iacType);
  setIacType(mode);
  setFiles(opened.files);
  setActivePath(opened.files[0]?.path ?? "");
  setDraft({ id: opened.id, name: opened.name });
  setSavedSerial(JSON.stringify(opened.files));
  setSaveError(null);
  void runParse(opened.files, mode);
}
```

`addFile` takes the extension (and the "+" menu grows a second item):

```ts
function addFile(ext: "tf" | "yaml") {
  let n = 1;
  while (files.some((f) => f.path === `untitled-${n}.${ext}`)) n += 1;
  const path = `untitled-${n}.${ext}`;
  setFiles((prev) => [...prev, { path, content: "" }]);
  setActivePath(path);
}
```

```tsx
<DropdownMenuItem onSelect={() => addFile("tf")}>
  <FilePlus2 className="size-4" />
  New Terraform file
</DropdownMenuItem>
<DropdownMenuItem onSelect={() => addFile("yaml")}>
  <FilePlus2 className="size-4" />
  New manifest
</DropdownMenuItem>
```

Header — the wrapping flex row becomes a 3-zone grid with the switch centered (title zone and action zone keep their existing children; actions zone gains `justify-end`):

```tsx
<div className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-4 gap-y-2">
  <div className="min-w-0">{/* existing eyebrow + title */}</div>
  <IacSwitch value={iacType} onChange={switchIacType} present={present} />
  <div className="flex flex-wrap items-center justify-end gap-2">
    {/* existing status + drafts menu + Visualize */}
  </div>
</div>
```

File rows — mute the out-of-view files (in the row button's `cn(...)`, plus its `title`):

```ts
const inView = fileIacType(file.path) === iacType;
```

```tsx
className={cn(
  "flex h-full min-w-0 flex-1 items-center gap-2 border-l-2 pr-1 pl-3 text-left font-mono text-xs transition-colors",
  file.path === activePath
    ? "border-primary bg-accent text-foreground font-medium"
    : "text-muted-foreground hover:bg-accent/60 border-transparent",
  !inView && "opacity-60",
  fileError && "text-destructive",
)}
title={fileError ?? (inView ? undefined : NOT_IN_VIEW[iacType])}
```

Canvas empty-state — the hint names the active stack's file kind:

```tsx
<p className="text-muted-foreground max-w-sm text-center text-sm">
  Edit the files on the left, then click{" "}
  <span className="text-foreground font-medium">Visualize</span> to draw the
  diagram. Nothing is saved or sent anywhere else.
</p>
```

(unchanged copy; only the aside's no-files hint widens):

```tsx
<p className="text-muted-foreground flex-1 px-4 py-6 text-center text-sm">
  Add or drop <span className="font-mono">.tf</span> or{" "}
  <span className="font-mono">.yaml</span> files to begin.
</p>
```

Imports to add on the page: `IacSwitch`, `type IacType`.

- [ ] **Step 8: Run the page + client tests**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/pages/playground-page.test.tsx src/api/client.playground.test.ts`
Expected: PASS, existing tests included (the aside hint test, if any, may need its copy updated to the new sentence).

- [ ] **Step 9: Full frontend suite + typecheck**

Run: `pnpm --filter @groundplan/frontend test && pnpm --filter @groundplan/frontend typecheck`
Expected: PASS — `design-tokens.test.ts` must stay green (no raw colours were introduced).

- [ ] **Step 10: Commit**

```bash
git add apps/frontend/src/components/iac-switch.tsx apps/frontend/src/api/client.ts apps/frontend/src/api/client.playground.test.ts apps/frontend/src/pages/playground-page.tsx apps/frontend/src/pages/playground-page.test.tsx
git commit -m "feat(frontend): playground Kubernetes mode — centered Terraform/Kubernetes switch, per-mode snapshots (GP-xxx)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — playground views: Global / Network / IAM

**Files:**
- Modify: `apps/frontend/src/components/view-switcher.tsx`
- Modify: `apps/frontend/src/pages/playground-page.tsx`
- Test: `apps/frontend/src/components/view-switcher.test.tsx`, `apps/frontend/src/pages/playground-page.test.tsx`

**Interfaces:**
- Consumes: Task 2's `iacType` / `snapshots` page state; existing `networkProjection(graph)` from `@/lib/graph-layout` (returns `{graph, hiddenCount, containerIds, stacks, chips}`); `IamTable({graph, variant, onViewInPlanImpact})` from `@/components/iam-table`; `useGraphView(allowed)`, `ViewSwitcher`, `viewsFor` from `@/components/view-switcher`; `GraphCanvas` props `containerIds`/`stacks`/`chips`/`focusNodeId` (see `docs-page.tsx` for the exact call shape).
- Produces: `viewsFor("playground", kubernetes)` → `["infra","network","iam"]` / `["infra"]`; `ViewSwitcherVariant` includes `"playground"` with infra label `"Global"`.

- [ ] **Step 1: Write the failing `viewsFor` tests** — append to `view-switcher.test.tsx` (match its existing test style):

```ts
it("playground offers Global/Network/IAM for Terraform, diagram only for Kubernetes", () => {
  expect(viewsFor("playground", false)).toEqual(["infra", "network", "iam"]);
  expect(viewsFor("playground", true)).toEqual(["infra"]);
});
```

- [ ] **Step 2: Run it, verify failure**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/components/view-switcher.test.tsx`
Expected: FAIL — `"playground"` is not a `ViewSwitcherVariant` (type error).

- [ ] **Step 3: Extend `view-switcher.tsx`**

```ts
export type ViewSwitcherVariant = "plan" | "docs" | "playground";

const INFRA_LABEL: Record<ViewSwitcherVariant, string> = {
  plan: "Plan impact",
  docs: "Global",
  playground: "Global",
};
```

```ts
export function viewsFor(
  variant: ViewSwitcherVariant,
  kubernetes: boolean,
): GraphView[] {
  if (kubernetes) return ["infra"];
  switch (variant) {
    case "docs":
      return ["infra", "adapted", "c4", "network", "iam"];
    // The playground has no annotation layer, so adapted/c4 would fold over
    // nothing — it gets the docs page's remaining lenses.
    case "playground":
      return ["infra", "network", "iam"];
    default:
      return ["infra", "network", "iam"];
  }
}
```

Extend the `viewsFor` doc comment with one sentence about the playground variant. Run the test again — Expected: PASS.

- [ ] **Step 4: Write the failing page tests** — append to `playground-page.test.tsx`. First extend the existing `SNAPSHOT` fixture graph with a role-assignment node so the IAM view has a row (add to its `nodes` array, matching the fixture's node shape):

```ts
{
  id: "azurerm_role_assignment.ops",
  name: "ops",
  type: "azurerm_role_assignment",
  provider: "azurerm",
  module_path: [],
  change: null,
  privileged: true,
  role_assignment: {
    principal: "ops-team",
    role: "Owner",
    scope: "subscription",
  },
},
```

```ts
it("a Terraform snapshot offers Global/Network/IAM; IAM renders the table", async () => {
  parsePlaygroundMock.mockResolvedValue(SNAPSHOT);
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");

  fireEvent.click(screen.getByRole("button", { name: "IAM" }));
  expect(screen.getByText("ops-team")).toBeInTheDocument();
  expect(screen.getByText("Owner")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Network" }));
  expect(screen.getByTestId("canvas")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Global" }));
  expect(screen.getByTestId("canvas")).toBeInTheDocument();
});

it("a Kubernetes snapshot gets the diagram and nothing else", async () => {
  parsePlaygroundMock.mockResolvedValue(SNAPSHOT);
  renderPage();
  fireEvent.click(screen.getByRole("button", { name: "Add or upload files" }));
  fireEvent.click(await screen.findByText("New manifest"));
  fireEvent.click(screen.getByRole("button", { name: "Kubernetes" }));
  fireEvent.click(screen.getByRole("button", { name: /visualize/i }));
  await screen.findByTestId("canvas");
  expect(screen.queryByRole("button", { name: "Global" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "IAM" })).not.toBeInTheDocument();
});
```

Note: `renderPage()` must wrap in `MemoryRouter` (it already does) — `useGraphView` reads the router's search params.

- [ ] **Step 5: Run them, verify failure**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/pages/playground-page.test.tsx`
Expected: FAIL — no view tabs exist on the page yet.

- [ ] **Step 6: Wire the views into `playground-page.tsx`**

Imports:

```ts
import { GraphCanvas } from "@/components/graph-canvas"; // already there
import { IamTable } from "@/components/iam-table";
import { ViewSwitcher, useGraphView, viewsFor } from "@/components/view-switcher";
import { networkProjection } from "@/lib/graph-layout";
import type { GraphNode } from "@/api/types";
import { useMemo } from "react"; // extend the existing react import
```

Page state (after the Task 2 mode state):

```ts
const kubernetes = iacType === "kubernetes";
const { view, setView } = useGraphView(viewsFor("playground", kubernetes));
// Network view (GP-44's projection, client-side and pure) on the active snapshot.
const network = useMemo(
  () =>
    snapshot && view === "network" ? networkProjection(snapshot.graph) : null,
  [snapshot, view],
);
// GP-49's jump: an IAM row lands selected on the Global canvas.
const [focusNodeId, setFocusNodeId] = useState<string | null>(null);
const viewOnCanvas = useCallback(
  (node: GraphNode) => {
    setFocusNodeId(node.id);
    setView("infra");
  },
  [setView],
);
```

The diagram section becomes a column: a slim tab bar (only when the mode has a snapshot and offers >1 view — in Kubernetes mode `ViewSwitcher` self-removes, so the bar must not render an empty shell), then the surface. The gridded paper is the diagram's surface; the IAM table sits on plain background (the docs page's rule):

```tsx
<div className="flex min-h-0 flex-1 flex-col">
  {snapshot && !kubernetes && (
    <div className="bg-card border-border flex items-center border-b px-4 pt-2">
      <ViewSwitcher variant="playground" kubernetes={kubernetes} />
    </div>
  )}
  <section
    aria-label="Diagram"
    className={cn(
      "relative min-h-0 flex-1",
      view !== "iam" && "blueprint-grid",
    )}
  >
    {(() => {
      if (!snapshot) {
        return (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground max-w-sm text-center text-sm">
              Edit the files on the left, then click{" "}
              <span className="text-foreground font-medium">Visualize</span>{" "}
              to draw the diagram. Nothing is saved or sent anywhere else.
            </p>
          </div>
        );
      }
      if (view === "iam") {
        return (
          <IamTable
            graph={snapshot.graph}
            variant="docs"
            onViewInPlanImpact={viewOnCanvas}
          />
        );
      }
      return (
        <GraphCanvas
          graph={network ? network.graph : snapshot.graph}
          variant="docs"
          containerIds={network?.containerIds}
          stacks={network?.stacks}
          chips={network?.chips}
          focusNodeId={focusNodeId}
        />
      );
    })()}
  </section>
</div>
```

(This replaces the existing bare `<section>`; the `?view=` param needs no clearing on mode switch — `useGraphView` already falls back to `infra` when the allowed list shrinks.)

- [ ] **Step 7: Run the page tests**

Run: `pnpm --filter @groundplan/frontend exec vitest run src/pages/playground-page.test.tsx`
Expected: PASS.

- [ ] **Step 8: Full frontend suite + typecheck**

Run: `pnpm --filter @groundplan/frontend test && pnpm --filter @groundplan/frontend typecheck`
Expected: PASS (axe assertions in the page tests stay clean with the new bar).

- [ ] **Step 9: Commit**

```bash
git add apps/frontend/src/components/view-switcher.tsx apps/frontend/src/components/view-switcher.test.tsx apps/frontend/src/pages/playground-page.tsx apps/frontend/src/pages/playground-page.test.tsx
git commit -m "feat(frontend): playground views — Global/Network/IAM lenses, diagram-only Kubernetes (GP-xxx)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: End-to-end verification + Jira

**Files:** none.

- [ ] **Step 1:** `pnpm typecheck && pnpm --filter @groundplan/backend test && pnpm --filter @groundplan/frontend test` — everything green from the repo root.
- [ ] **Step 2:** Use the `verify` skill (Postgres + Keycloak + backend + frontend + real browser) to observe: the centered switch with both logos; a manifest file enabling the Kubernetes side; Visualize drawing a Kubernetes diagram; the Global/Network/IAM tabs on a Terraform snapshot; the IAM table row jumping back to the canvas.
- [ ] **Step 3:** Transition the completed Jira stories to Done (transition id 41) via `mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue`.
