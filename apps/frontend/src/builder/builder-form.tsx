/**
 * The selected resource's form (GP-133): its Terraform name, one field per
 * catalog attribute, and one control per reference slot.
 *
 * The slot controls matter beyond convenience — dragging a wire is not a thing
 * everybody can do, and a builder that can only be driven by pointer is a
 * builder half the team cannot use. Both paths go through the same rules, so
 * neither can make a connection the other would refuse.
 */
import { useState } from "react";

import {
  addressOf,
  attributeKey,
  attributeValue,
  CATALOG,
  canConnect,
  isBlank,
  isNameIssue,
  isTypeIssue,
  schemaKindOf,
  type AttributeDef,
  type BuilderGraph,
  type BuilderIssue,
  type BuilderMode,
  type BuilderNode,
  type BuilderValue,
  type ReferenceSlot,
  type ResourceDef,
} from "@groundplan/builder";
import { Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

import { connectedTo } from "./builder-ops";

const FIELD = "border-input bg-background h-8 w-full rounded-md border px-2 text-xs";

/** The message for a field, when validation has one for it. */
function messageFor(
  issues: readonly BuilderIssue[],
  attribute: string,
): string | undefined {
  return issues.find((i) => !isNameIssue(i) && i.attribute === attribute)
    ?.message;
}

function AttributeField({
  attribute,
  node,
  issues,
  onChange,
}: Readonly<{
  attribute: AttributeDef;
  node: BuilderNode;
  issues: readonly BuilderIssue[];
  onChange: (value: BuilderValue | undefined) => void;
}>) {
  // The storage key, not the HCL name: a schema-derived type can carry the same
  // argument name at the top level and inside a required block (GP-238).
  const key = attributeKey(attribute);
  const id = `attr-${node.id}-${key}`;
  const value = attributeValue(attribute, node);
  const problem = messageFor(issues, key);

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {attribute.label}
        {attribute.required && <span className="text-destructive"> *</span>}
        {/* The provider called this sensitive (GP-238). The builder writes
            literals into a file somebody is about to commit, so the field says
            so where the value is typed — not in a footnote. */}
        {attribute.sensitive && (
          <span className="text-impacted ml-1.5 font-mono text-[10px] tracking-[0.08em] uppercase">
            sensitive
          </span>
        )}
      </Label>
      {(() => {
        if (attribute.kind === "enum") {
          return (
            <select
              id={id}
              className={FIELD}
              value={typeof value === "string" ? value : ""}
              onChange={(e) => onChange(e.target.value)}
            >
              <option value="">—</option>
              {(attribute.values ?? []).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          );
        }
        if (attribute.kind === "bool") {
          return (
            <input
              id={id}
              type="checkbox"
              className="size-4"
              checked={value === true}
              onChange={(e) => onChange(e.target.checked)}
            />
          );
        }
        if (attribute.kind === "number") {
          return (
            <Input
              id={id}
              type="number"
              className="h-8 text-xs"
              value={typeof value === "number" ? String(value) : ""}
              onChange={(e) =>
                onChange(e.target.value === "" ? undefined : Number(e.target.value))
              }
            />
          );
        }
        if (attribute.kind === "list") {
          return (
            <Input
              id={id}
              className="h-8 font-mono text-xs"
              value={Array.isArray(value) ? value.join(", ") : ""}
              placeholder="comma separated"
              onChange={(e) => {
                const parts = e.target.value
                  .split(",")
                  .map((part) => part.trim())
                  .filter((part) => part !== "");
                onChange(parts.length > 0 ? parts : undefined);
              }}
            />
          );
        }
        return (
          <Input
            id={id}
            className="h-8 font-mono text-xs"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => onChange(e.target.value)}
          />
        );
      })()}
      {attribute.sensitive && !problem && (
        <p className="text-muted-foreground text-[11px]">
          Written into the generated file as a literal. Replace it with a
          variable or a Key Vault reference before committing.
        </p>
      )}
      {problem ? (
        <p className="text-destructive text-[11px]">{problem}</p>
      ) : (
        attribute.hint && (
          <p className="text-muted-foreground text-[11px]">{attribute.hint}</p>
        )
      )}
    </div>
  );
}

function SlotField({
  slot,
  node,
  graph,
  catalog,
  issues,
  onConnect,
  onDisconnect,
}: Readonly<{
  slot: ReferenceSlot;
  node: BuilderNode;
  graph: BuilderGraph;
  catalog: readonly ResourceDef[];
  issues: readonly BuilderIssue[];
  onConnect: (attribute: string, to: string) => void;
  onDisconnect: (attribute: string, to: string) => void;
}>) {
  const id = `slot-${node.id}-${slot.attribute}`;
  const targets = connectedTo(graph, node.id, slot.attribute);
  const problem = messageFor(issues, slot.attribute);
  // Only what the catalog allows is ever offered — the same rule the canvas
  // enforces while dragging, asked of the same function.
  const candidates = graph.nodes.filter(
    (candidate) =>
      candidate.id !== node.id &&
      canConnect(
        node.type,
        slot.attribute,
        candidate.type,
        catalog,
        schemaKindOf(node),
      ) &&
      !targets.some((t) => t.id === candidate.id),
  );

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {slot.label}
        {slot.required && <span className="text-destructive"> *</span>}
      </Label>

      {targets.length > 0 && (
        <ul className="space-y-1">
          {targets.map((target) => (
            <li key={target.id} className="flex items-center gap-1">
              <span className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-[11px]">
                {addressOf(target)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Disconnect ${slot.label} from ${target.name}`}
                onClick={() => onDisconnect(slot.attribute, target.id)}
              >
                <Trash2 className="size-3" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {(slot.list || targets.length === 0) && (
        <select
          id={id}
          className={cn(FIELD, candidates.length === 0 && "text-muted-foreground")}
          value=""
          disabled={candidates.length === 0}
          onChange={(e) => {
            if (e.target.value) onConnect(slot.attribute, e.target.value);
          }}
        >
          <option value="">
            {candidates.length === 0
              ? `No ${slot.targetTypes.map((t) => t.replace(/^azurerm_/, "")).join(" or ")} to connect`
              : "Connect…"}
          </option>
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {addressOf(candidate)}
            </option>
          ))}
        </select>
      )}
      {problem && <p className="text-destructive text-[11px]">{problem}</p>}
    </div>
  );
}


/**
 * A custom resource's form: the type, then whatever fields and references the
 * user decides it has. Nothing is offered from a catalog because there is no
 * catalog entry — this is the part of the builder where the user is the schema.
 */
function CustomFields({
  node,
  graph,
  issues,
  onRetype,
  onAttribute,
  onRenameReference,
  onSetTargetAttribute,
  onDisconnect,
}: Readonly<{
  node: BuilderNode;
  graph: BuilderGraph;
  issues: readonly BuilderIssue[];
  onRetype: (type: string) => void;
  onAttribute: (attribute: string, value: BuilderValue | undefined) => void;
  onRenameReference: (attribute: string, next: string) => void;
  onSetTargetAttribute: (attribute: string, targetAttribute: string) => void;
  onDisconnect: (attribute: string, to: string) => void;
}>) {
  const [newKey, setNewKey] = useState("");
  const typeProblem = issues.find(isTypeIssue)?.message;
  const references = graph.references.filter((r) => r.from === node.id);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  function addAttribute() {
    const key = newKey.trim();
    if (key === "") return;
    onAttribute(key, "");
    setNewKey("");
  }

  return (
    <>
      <div className="space-y-1">
        <Label htmlFor={`type-${node.id}`} className="text-[11px]">
          Terraform type<span className="text-destructive"> *</span>
        </Label>
        <Input
          id={`type-${node.id}`}
          className="h-8 font-mono text-xs"
          placeholder="azurerm_management_lock"
          value={node.type}
          onChange={(e) => onRetype(e.target.value)}
        />
        {typeProblem ? (
          <p className="text-destructive text-[11px]">{typeProblem}</p>
        ) : (
          <p className="text-muted-foreground text-[11px]">
            Nothing here is checked against a provider schema — the fields are
            yours to get right.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
          Attributes
        </span>
        {Object.entries(node.attributes).map(([key, value]) => (
          <div key={key} className="flex items-end gap-1">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={`custom-${node.id}-${key}`} className="text-[11px]">
                {key}
              </Label>
              <Input
                id={`custom-${node.id}-${key}`}
                className="h-8 font-mono text-xs"
                value={typeof value === "string" ? value : String(value)}
                onChange={(e) => onAttribute(key, e.target.value)}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Remove ${key}`}
              onClick={() => onAttribute(key, undefined)}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        ))}
        <div className="flex items-end gap-1">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor={`new-attr-${node.id}`} className="text-[11px]">
              New attribute
            </Label>
            <Input
              id={`new-attr-${node.id}`}
              className="h-8 font-mono text-xs"
              placeholder="lock_level"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addAttribute();
              }}
            />
          </div>
          <Button variant="outline" className="h-8" onClick={addAttribute}>
            Add
          </Button>
        </div>
      </div>

      {references.length > 0 && (
        <div className="space-y-2">
          <span className="text-muted-foreground font-mono text-[11px] tracking-[0.12em] uppercase">
            References
          </span>
          {references.map((reference) => {
            const target = byId.get(reference.to);
            const problem = messageFor(issues, reference.attribute);
            return (
              <div key={reference.attribute} className="space-y-1">
                <div className="flex items-center gap-1">
                  <Input
                    aria-label={`Reference attribute for ${target?.name ?? reference.to}`}
                    className="h-8 min-w-0 flex-1 font-mono text-xs"
                    value={reference.attribute}
                    onChange={(e) =>
                      onRenameReference(reference.attribute, e.target.value)
                    }
                  />
                  <span className="text-faint shrink-0 font-mono text-[11px]">
                    =
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Remove reference ${reference.attribute}`}
                    onClick={() =>
                      onDisconnect(reference.attribute, reference.to)
                    }
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  <span className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 font-mono text-[11px]">
                    {target ? `${target.type}.${target.name}` : reference.to}
                  </span>
                  <span className="text-faint shrink-0 font-mono text-[11px]">
                    .
                  </span>
                  <Input
                    aria-label={`Target attribute for ${reference.attribute}`}
                    className="h-8 w-24 font-mono text-xs"
                    value={reference.targetAttribute ?? ""}
                    placeholder="id"
                    onChange={(e) =>
                      onSetTargetAttribute(reference.attribute, e.target.value)
                    }
                  />
                </div>
                {problem && (
                  <p className="text-destructive text-[11px]">{problem}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/**
 * Declared here, or already out there (GP-248).
 *
 * Two buttons rather than a checkbox, because these are two kinds of Terraform
 * block and not a flag on one — and the sentence underneath says what the
 * choice *means*, since "data source" is exactly the piece of Terraform
 * vocabulary somebody composing visually may not have met yet.
 */
function ModeToggle({
  node,
  busy,
  error,
  onSetMode,
}: Readonly<{
  node: BuilderNode;
  busy: boolean;
  error: string | null;
  onSetMode: (mode: BuilderMode) => void;
}>) {
  const mode: BuilderMode = node.mode ?? "resource";
  return (
    <fieldset className="space-y-1">
      <legend className="text-[11px] font-medium">Terraform block</legend>
      <div className="border-input flex gap-0.5 rounded-md border p-0.5">
        {(["resource", "data"] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={mode === option}
            disabled={busy}
            onClick={() => onSetMode(option)}
            className={cn(
              "flex-1 rounded px-2 py-1 font-mono text-[11px] transition-colors disabled:opacity-60",
              mode === option
                ? "bg-accent text-ink"
                : "text-muted-foreground hover:text-ink",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground text-[11px]">
        {mode === "data"
          ? "Looked up, not created: this one already exists and Terraform only reads it."
          : "Declared here: Terraform creates it and owns it from then on."}
      </p>
      {error && <p className="text-destructive text-[11px]">{error}</p>}
    </fieldset>
  );
}

export function BuilderForm({
  node,
  def,
  catalog = CATALOG,
  graph,
  issues,
  onRename,
  onRetype,
  onAttribute,
  onConnect,
  onDisconnect,
  onRenameReference,
  onSetTargetAttribute,
  onSetMode,
  modeBusy = false,
  modeError = null,
  onDelete,
}: Readonly<{
  node: BuilderNode;
  /** The catalog definition; absent on a custom resource. */
  def?: ResourceDef;
  /** Everything the builder can compose with, for the slot candidate lists. */
  catalog?: readonly ResourceDef[];
  graph: BuilderGraph;
  issues: readonly BuilderIssue[];
  onRename: (name: string) => void;
  onRetype: (type: string) => void;
  onAttribute: (attribute: string, value: BuilderValue | undefined) => void;
  onConnect: (attribute: string, to: string) => void;
  onDisconnect: (attribute: string, to: string) => void;
  onRenameReference: (attribute: string, next: string) => void;
  onSetTargetAttribute: (attribute: string, targetAttribute: string) => void;
  /** Switch between declaring this resource and looking it up (GP-248). */
  onSetMode?: (mode: BuilderMode) => void;
  /** A switch is in flight: the other schema is being read. */
  modeBusy?: boolean;
  /** Why the last switch did not happen — usually "there is no data source". */
  modeError?: string | null;
  onDelete: () => void;
}>) {
  // The Terraform name's problems are the ones about the name, not the ones
  // about an attribute that happens to be called `name` (most types have one).
  const nameProblem = issues.find(isNameIssue)?.message;

  // Required first, in catalog order; everything else folded below. A curated
  // type has a handful of each; a type read from a provider can have ninety
  // optional arguments, and the required ones are what makes it valid.
  const required = (def?.attributes ?? []).filter((a) => a.required);
  const optional = (def?.attributes ?? []).filter((a) => !a.required);
  const optionalFilled = optional.filter(
    (a) => !isBlank(node.attributes[attributeKey(a)]),
  ).length;

  return (
    <aside
      aria-label="Resource details"
      className="bg-card border-border flex w-80 shrink-0 flex-col overflow-y-auto border-l"
    >
      <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-1.5">
        <span className="text-muted-foreground truncate font-mono text-[11px] tracking-[0.12em] uppercase">
          {def?.label ?? "Custom resource"}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label={`Delete ${node.name}`}
          onClick={onDelete}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-4 p-4">
        <div className="space-y-1">
          <Label htmlFor={`name-${node.id}`} className="text-[11px]">
            Terraform name<span className="text-destructive"> *</span>
          </Label>
          <Input
            id={`name-${node.id}`}
            className="h-8 font-mono text-xs"
            value={node.name}
            onChange={(e) => onRename(e.target.value)}
          />
          {nameProblem ? (
            <p className="text-destructive text-[11px]">{nameProblem}</p>
          ) : (
            // The address it will be referenced by — `data.` and all (GP-248).
            <p className="text-muted-foreground font-mono text-[11px]">
              {addressOf(node)}
            </p>
          )}
        </div>

        {/* A custom resource has no schema to switch to: the user is the
            schema there, and there is no data source of a type nobody
            described. */}
        {onSetMode && !node.custom && (
          <ModeToggle
            node={node}
            busy={modeBusy}
            error={modeError}
            onSetMode={onSetMode}
          />
        )}

        {def === undefined ? (
          <CustomFields
            node={node}
            graph={graph}
            issues={issues}
            onRetype={onRetype}
            onAttribute={onAttribute}
            onRenameReference={onRenameReference}
            onSetTargetAttribute={onSetTargetAttribute}
            onDisconnect={onDisconnect}
          />
        ) : (
          <>
            {required.map((attribute) => (
              <AttributeField
                key={attribute.name}
                attribute={attribute}
                node={node}
                issues={issues}
                onChange={(value) => onAttribute(attributeKey(attribute), value)}
              />
            ))}

            {def.references.map((slot) => (
              <SlotField
                key={slot.attribute}
                slot={slot}
                node={node}
                graph={graph}
                catalog={catalog}
                issues={issues}
                onConnect={onConnect}
                onDisconnect={onDisconnect}
              />
            ))}

            {/* A type read from the provider can have ninety optional
                arguments (GP-238). They are all here — nothing is hidden — but
                folded away, because a form that opens on ninety empty fields
                is a form nobody reads. What is required, and what is
                connected, is what a resource needs to be valid. */}
            {optional.length > 0 && (
              <details className="border-border border-t pt-3">
                <summary className="text-muted-foreground cursor-pointer text-[11px] select-none">
                  Optional arguments ({optional.length})
                  {optionalFilled > 0 && ` · ${optionalFilled} set`}
                </summary>
                <div className="space-y-4 pt-3">
                  {optional.map((attribute) => (
                    <AttributeField
                      key={attribute.name}
                      attribute={attribute}
                      node={node}
                      issues={issues}
                      onChange={(value) =>
                        onAttribute(attributeKey(attribute), value)
                      }
                    />
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
