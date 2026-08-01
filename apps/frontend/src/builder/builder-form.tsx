/**
 * The selected resource's form (GP-133): its Terraform name, one field per
 * catalog attribute, and one control per reference slot.
 *
 * The slot controls matter beyond convenience — dragging a wire is not a thing
 * everybody can do, and a builder that can only be driven by pointer is a
 * builder half the team cannot use. Both paths go through the same rules, so
 * neither can make a connection the other would refuse.
 */
import {
  attributeValue,
  canConnect,
  isNameIssue,
  type AttributeDef,
  type BuilderGraph,
  type BuilderIssue,
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
  const id = `attr-${node.id}-${attribute.name}`;
  const value = attributeValue(attribute, node);
  const problem = messageFor(issues, attribute.name);

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-[11px]">
        {attribute.label}
        {attribute.required && <span className="text-destructive"> *</span>}
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
  issues,
  onConnect,
  onDisconnect,
}: Readonly<{
  slot: ReferenceSlot;
  node: BuilderNode;
  graph: BuilderGraph;
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
      canConnect(node.type, slot.attribute, candidate.type) &&
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
                {target.type}.{target.name}
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
              {candidate.type}.{candidate.name}
            </option>
          ))}
        </select>
      )}
      {problem && <p className="text-destructive text-[11px]">{problem}</p>}
    </div>
  );
}

export function BuilderForm({
  node,
  def,
  graph,
  issues,
  onRename,
  onAttribute,
  onConnect,
  onDisconnect,
  onDelete,
}: Readonly<{
  node: BuilderNode;
  def: ResourceDef;
  graph: BuilderGraph;
  issues: readonly BuilderIssue[];
  onRename: (name: string) => void;
  onAttribute: (attribute: string, value: BuilderValue | undefined) => void;
  onConnect: (attribute: string, to: string) => void;
  onDisconnect: (attribute: string, to: string) => void;
  onDelete: () => void;
}>) {
  // The Terraform name's problems are the ones about the name, not the ones
  // about an attribute that happens to be called `name` (most types have one).
  const nameProblem = issues.find(isNameIssue)?.message;

  return (
    <aside
      aria-label="Resource details"
      className="bg-card border-border flex w-80 shrink-0 flex-col overflow-y-auto border-l"
    >
      <div className="border-border flex items-center justify-between gap-2 border-b px-4 py-1.5">
        <span className="text-muted-foreground truncate font-mono text-[11px] tracking-[0.12em] uppercase">
          {def.label}
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
            <p className="text-muted-foreground font-mono text-[11px]">
              {node.type}.{node.name}
            </p>
          )}
        </div>

        {def.attributes.map((attribute) => (
          <AttributeField
            key={attribute.name}
            attribute={attribute}
            node={node}
            issues={issues}
            onChange={(value) => onAttribute(attribute.name, value)}
          />
        ))}

        {def.references.map((slot) => (
          <SlotField
            key={slot.attribute}
            slot={slot}
            node={node}
            graph={graph}
            issues={issues}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        ))}
      </div>
    </aside>
  );
}
