import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";
import { Alert, AlertDescription } from "./alert";
import { Input } from "./input";

describe("carbon ui primitives", () => {
  it("Button renders the primary carbon fill by default", () => {
    render(<Button>Sign In</Button>);
    const button = screen.getByRole("button", { name: "Sign In" });
    expect(button.className).toContain("bg-primary");
    expect(button.className).toContain("text-primary-foreground");
  });

  it("Button outline variant uses token-based classes only", () => {
    render(<Button variant="outline">Cancel</Button>);
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button.className).toContain("border-input");
  });

  it("Alert error variant is an alert region with the delete status border", () => {
    render(
      <Alert variant="error">
        <AlertDescription>Invalid username or password.</AlertDescription>
      </Alert>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("border-delete/40");
    expect(alert).toHaveTextContent("Invalid username or password.");
  });

  it("Input forwards its type and reflects aria-invalid", () => {
    render(<Input type="password" aria-invalid />);
    const input = document.querySelector("input");
    expect(input).not.toBeNull();
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });
});
