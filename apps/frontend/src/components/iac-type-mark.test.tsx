import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { IacTypeMark } from "./iac-type-mark";

describe("IacTypeMark", () => {
  it("renders a different official mark for each IaC type", () => {
    const { container: tf } = render(<IacTypeMark iacType="terraform" />);
    const { container: k8s } = render(<IacTypeMark iacType="kubernetes" />);
    const tfSrc = tf.querySelector("img")?.getAttribute("src");
    const k8sSrc = k8s.querySelector("img")?.getAttribute("src");

    expect(tfSrc).toBeTruthy();
    expect(k8sSrc).toBeTruthy();
    expect(tfSrc).not.toEqual(k8sSrc);
  });

  it("is decorative by default, and labelled when given an alt", () => {
    const { container: bare } = render(<IacTypeMark iacType="terraform" />);
    const decorative = bare.querySelector("img")!;
    expect(decorative).toHaveAttribute("aria-hidden", "true");
    expect(decorative).toHaveAttribute("alt", "");

    const { container: labelled } = render(
      <IacTypeMark iacType="kubernetes" alt="Kubernetes" />,
    );
    const named = labelled.querySelector("img")!;
    expect(named).toHaveAttribute("alt", "Kubernetes");
    expect(named).not.toHaveAttribute("aria-hidden");
  });
});
