import { useMemo, type ReactNode } from "react";
import { create } from "zustand";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { buildPageTree } from "@/features/settings/model/pages";
import { SettingsFormContext, useSettingsPages, type SettingsForm } from "@/workbench/contributions";
import { AgentPolicyPage } from "./AgentPolicyPage";
import { activateSettingsPages } from "./index";
import { POLICY_PAGE, REGISTRY_PAGE } from "./model";

const useFormStore = create<{ agentSecurity?: unknown; staged: unknown[] }>(() => ({
  agentSecurity: undefined,
  staged: [],
}));

function FormWrapper({ children }: { children: ReactNode }) {
  const form = useMemo<SettingsForm>(
    () => ({
      scope: "global",
      useValue: (key) => useFormStore((s) => (key === "agentSecurity" ? s.agentSecurity : undefined)),
      set: (key, value) => {
        if (key === "agentSecurity") {
          useFormStore.setState((s) => ({ agentSecurity: value, staged: [...s.staged, value] }));
        }
      },
      useExternal: (_key, base) => ({ value: base, current: base, set: () => undefined, saving: false }),
    }),
    [],
  );
  return <SettingsFormContext.Provider value={form}>{children}</SettingsFormContext.Provider>;
}

describe("Command Execution Policy sub-page", () => {
  it("registers as a child page under Tools › Agents", () => {
    const dispose = activateSettingsPages();
    try {
      const tree = buildPageTree(useSettingsPages.getState().pages.values());
      const toolsGroup = tree.find((n) => n.title === "Tools");
      const agentsNode = toolsGroup?.children.find((n) => n.key === REGISTRY_PAGE);
      expect(agentsNode?.title).toBe("Agents");
      expect(agentsNode?.children.map((c) => [c.key, c.title])).toEqual([[POLICY_PAGE, "Command Execution Policy"]]);
      expect(agentsNode?.children[0]?.page?.projectScope).toBe(true);
    } finally {
      dispose();
    }
  });

  it("stages whitelist and blacklist pattern edits via SettingsForm", () => {
    useFormStore.setState({ agentSecurity: undefined, staged: [] });
    render(
      <FormWrapper>
        <AgentPolicyPage />
      </FormWrapper>,
    );

    const policy = screen.getByRole("region", { name: "Command Execution Policy" });
    expect(within(policy).getByText("git status*")).toBeInTheDocument();
    expect(within(policy).getByText("rm -rf *")).toBeInTheDocument();

    fireEvent.change(within(policy).getByRole("textbox", { name: "Allowed command pattern" }), {
      target: { value: "cargo test*" },
    });
    fireEvent.click(within(policy).getByRole("button", { name: "Add allowed command" }));
    expect(within(policy).getByText("cargo test*")).toBeInTheDocument();

    fireEvent.click(within(policy).getByRole("button", { name: "Remove cargo test*" }));
    expect(within(policy).queryByText("cargo test*")).toBeNull();

    fireEvent.change(within(policy).getByRole("textbox", { name: "Blocked command pattern" }), {
      target: { value: "git push --force*" },
    });
    fireEvent.click(within(policy).getByRole("button", { name: "Add blocked command" }));
    expect(within(policy).getByText("git push --force*")).toBeInTheDocument();

    fireEvent.click(within(policy).getByRole("button", { name: "Remove git push --force*" }));
    expect(within(policy).queryByText("git push --force*")).toBeNull();
    expect(useFormStore.getState().staged).toHaveLength(4);
  });
});
