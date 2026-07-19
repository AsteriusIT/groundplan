/**
 * GP-140: the local AI-elements primitives — anatomy, interactions, a11y.
 */
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";

import { Conversation, ConversationContent } from "./conversation";
import { Message, MessageContent } from "./message";
import { PromptInput } from "./prompt-input";
import { Suggestion, Suggestions } from "./suggestion";
import { Shimmer } from "./shimmer";
import { CodeBlock } from "./code-block";
import { FileTree } from "./file-tree";
import { Snippet } from "./snippet";

it("renders a conversation with user and assistant turns, accessibly", async () => {
  const { container } = render(
    <Conversation>
      <ConversationContent>
        <Message from="user">
          <MessageContent from="user">create a vnet</MessageContent>
        </Message>
        <Message from="assistant">
          <MessageContent from="assistant">Done.</MessageContent>
        </Message>
        <Shimmer />
      </ConversationContent>
    </Conversation>,
  );
  expect(screen.getByRole("log", { name: "Conversation" })).toBeInTheDocument();
  expect(screen.getByText("create a vnet")).toBeInTheDocument();
  expect(screen.getByRole("status", { name: "Generating" })).toBeInTheDocument();
  expect((await axe(container)).violations).toEqual([]);
});

it("submits the prompt on Enter and clears; Shift+Enter stays put", () => {
  const onSubmit = vi.fn();
  render(<PromptInput onSubmit={onSubmit} />);
  const box = screen.getByRole("textbox", { name: "Message" });

  fireEvent.change(box, { target: { value: "two subnets" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSubmit).toHaveBeenCalledWith("two subnets");
  expect(box).toHaveValue("");
});

it("shows Stop instead of Send while streaming", () => {
  const onStop = vi.fn();
  render(<PromptInput onSubmit={() => {}} onStop={onStop} streaming />);
  fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
  expect(onStop).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
});

it("a suggestion chip submits its prompt", () => {
  const onClick = vi.fn();
  render(
    <Suggestions>
      <Suggestion suggestion="Create a resource group" onClick={onClick} />
    </Suggestions>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Create a resource group" }));
  expect(onClick).toHaveBeenCalledWith("Create a resource group");
});

it("CodeBlock highlights HCL and marks the requested range", () => {
  const code = 'resource "azurerm_resource_group" "rg" {\n  name = "demo"\n}\n';
  render(<CodeBlock code={code} highlightRange={{ start: 2, end: 2 }} />);
  // The keyword got a token span; the marked line got the soft background.
  expect(screen.getByText("resource")).toBeInTheDocument();
  expect(document.querySelector(".bg-impacted-soft")).not.toBeNull();
});

it("FileTree lists directories once and selects files", () => {
  const onSelect = vi.fn();
  render(
    <FileTree
      files={["main.tf", "modules/net/vnet.tf", "modules/net/subnet.tf"]}
      active="main.tf"
      onSelect={onSelect}
    />,
  );
  expect(screen.getAllByText("net")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /vnet\.tf/ }));
  expect(onSelect).toHaveBeenCalledWith("modules/net/vnet.tf");
  expect(screen.getByRole("button", { name: /main\.tf/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
});

it("Snippet renders a copyable command", () => {
  render(<Snippet command="terraform init && terraform plan" />);
  expect(
    screen.getByText(/terraform init && terraform plan/),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
});
