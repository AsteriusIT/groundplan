import { expect, it, describe } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { axe } from "vitest-axe";

import {
  CiSetupBlock,
  ciWorkflowSnippet,
  docsFromCi,
  manifestWorkflowSnippet,
} from "./ci-setup-block";

const URL = "https://gp.example.com/api/v1/webhooks/ci/r1";

/**
 * These strings are the product for anyone setting Groundplan up: a snippet that
 * does not paste-and-run is a broken feature, whatever the UI around it does. So
 * the contract they encode — the webhook envelope, the secret reference, the
 * render step — is asserted, not eyeballed.
 */
describe("the workflow a user pastes into their CI", () => {
  it("never writes the token into the file", () => {
    const snippets = [
      ciWorkflowSnippet(URL),
      manifestWorkflowSnippet(URL, "raw"),
      manifestWorkflowSnippet(URL, "helm"),
      manifestWorkflowSnippet(URL, "kustomize"),
    ];
    for (const snippet of snippets) {
      expect(snippet).toContain("${{ secrets.GROUNDPLAN_WEBHOOK_TOKEN }}");
      expect(snippet).toContain(`curl -sf -X POST "${URL}"`);
    }
  });

  it("renders each flavour the way that flavour is actually built", () => {
    expect(manifestWorkflowSnippet(URL, "raw")).toContain("cat manifests/*.yaml");
    expect(manifestWorkflowSnippet(URL, "helm")).toContain("helm template . -f values.yaml");
    expect(manifestWorkflowSnippet(URL, "kustomize")).toContain(
      "kustomize build overlays/prod",
    );
  });

  it("posts the rendered YAML as manifests, and a pull request's number with it", () => {
    const snippet = manifestWorkflowSnippet(URL, "helm");
    expect(snippet).toContain('event:"pull_request"');
    expect(snippet).toContain("--argjson pr ${{ github.event.pull_request.number }}");
    expect(snippet).toContain("payload:{manifests:$manifests}");
    // It is manifests, not a plan: nothing in here shells out to Terraform.
    expect(snippet).not.toContain("terraform");
  });

  it("documents main from the render for a chart, and from the repository for raw YAML", () => {
    // A chart's templates are Go source, so its diagram of main can only come from
    // the same render its pull requests use — the push carries the YAML.
    expect(docsFromCi("helm")).toBe(true);
    expect(docsFromCi("kustomize")).toBe(true);
    expect(manifestWorkflowSnippet(URL, "helm")).toContain(
      'event:"push", payload:{manifests:$manifests}',
    );

    // Raw manifests we can read ourselves, so the push only says that main moved.
    expect(docsFromCi("raw")).toBe(false);
    expect(manifestWorkflowSnippet(URL, "raw")).toContain('event:"push", payload:{}');
  });
});

describe("the CI setup block", () => {
  it("shows a Terraform repository no flavour question at all", () => {
    render(<CiSetupBlock webhookUrl={URL} webhookToken="tok" />);
    expect(
      screen.queryByRole("group", { name: "Manifest flavour" }),
    ).not.toBeInTheDocument();
    // The front door for Terraform is the CLI, not a raw curl block.
    expect(document.querySelector("pre")?.textContent).toContain(
      "npx @groundplan/cli push-plan",
    );
  });

  it("makes the CLI the front door and keeps the raw webhook behind Advanced", () => {
    render(<CiSetupBlock webhookUrl={URL} webhookToken="tok" />);

    // The two env vars the CLI reads, with the token shown once.
    expect(screen.getByText("GROUNDPLAN_URL")).toBeInTheDocument();
    expect(screen.getByText("GROUNDPLAN_TOKEN — shown once")).toBeInTheDocument();

    // The primary snippet is the CLI; the raw webhook is still there, behind a
    // disclosure, so a Node-less runner can still integrate.
    const pres = [...document.querySelectorAll("pre")].map((p) => p.textContent ?? "");
    expect(pres[0]).toContain("terraform show -json plan.out > plan.json");
    expect(screen.getByText(/Advanced/i)).toBeInTheDocument();
    const all = pres.join("\n");
    expect(all).toContain(`curl -sf -X POST "${URL}"`);
    expect(all).toContain("terraform plan");
  });

  it("switches the workflow, and the guidance, with the flavour", () => {
    render(<CiSetupBlock webhookUrl={URL} webhookToken="tok" iacType="kubernetes" />);

    const workflow = () => document.querySelector("pre")?.textContent ?? "";
    expect(workflow()).toContain("cat manifests/*.yaml");
    expect(screen.getByText(/reads these manifests from the repository itself/i))
      .toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Kustomize" }));
    expect(workflow()).toContain("kustomize build overlays/prod");
    // The honest sentence: an overlay's documentation comes from your CI, and the
    // user should know that before they wonder why main has no diagram.
    expect(screen.getByText(/main's documentation comes from your CI/i)).toBeInTheDocument();
  });

  it("shows the token once, and says what to do with it", () => {
    render(<CiSetupBlock webhookUrl={URL} webhookToken="wh-secret" iacType="kubernetes" />);
    expect(screen.getByText("wh-secret")).toBeInTheDocument();
    expect(screen.getByText(/won't be shown again/i)).toBeInTheDocument();
  });

  it("has no accessibility violations", async () => {
    // In the app this block always sits inside the dialog's (or the card's) main
    // region; axe should see it in one here too, rather than floating in a bare
    // document where every node is outside a landmark.
    const { baseElement } = render(
      <main>
        <CiSetupBlock webhookUrl={URL} webhookToken="tok" iacType="kubernetes" />
      </main>,
    );
    const results = await axe(baseElement);
    expect(results.violations).toEqual([]);
  });
});
