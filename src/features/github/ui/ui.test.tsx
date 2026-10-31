import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { DEFAULT_DATE_FORMAT } from "@/platform/dateFormat";
import * as openUrl from "@/platform/openUrl";
import { Avatar, AvatarStack, avatarSrc, reviewerRingColor } from "./Avatar";
import { BranchChip, LabelChip, StateTag, labelForeground } from "./chips";
import { ChooserPopup, chooserItems } from "./ChooserPopup";
import { Markdown } from "./Markdown";
import { prettyDate, prettyDateTime } from "./prettyDate";

describe("prettyDate", () => {
  const o = { ...DEFAULT_DATE_FORMAT, overrideSystem: true, pattern: "dd.MM.yyyy", use24Hour: true };
  const now = new Date(2026, 9, 30, 15, 0).getTime();

  it("formats like DateFormatUtil.formatPrettyDate", () => {
    expect(prettyDate(now - 20_000, now, o)).toBe("Moments ago");
    expect(prettyDate(now - 60_000, now, o)).toBe("1 minute ago");
    expect(prettyDate(now - 42 * 60_000, now, o)).toBe("42 minutes ago");
    expect(prettyDate(now - 3 * 3_600_000, now, o)).toBe("Today");
    expect(prettyDate(new Date(2026, 9, 29, 9, 5).getTime(), now, o)).toBe("Yesterday");
    expect(prettyDate(new Date(2026, 8, 2, 9, 5).getTime(), now, o)).toBe("02.09.2026");
    expect(prettyDate("not a date", now, o)).toBe("");
  });

  it("adds the time with formatPrettyDateTime, and honours pretty formatting off", () => {
    expect(prettyDateTime(new Date(2026, 9, 30, 9, 5).getTime(), now, o)).toBe("Today 09:05");
    expect(prettyDateTime(new Date(2026, 9, 29, 9, 5).getTime(), now, o)).toBe("Yesterday 09:05");
    expect(prettyDateTime(new Date(2026, 8, 2, 9, 5).getTime(), now, o)).toBe("02.09.2026 09:05");
    expect(prettyDate(now - 20_000, now, { ...o, pretty: false })).toBe("30.10.2026");
  });
});

describe("Avatar", () => {
  it("loads the avatar at twice its size and falls back to the initial", () => {
    expect(avatarSrc("https://avatars.githubusercontent.com/u/1?v=4", 20)).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4&s=40",
    );
    expect(avatarSrc("https://example.com/a.png", 20)).toBe("https://example.com/a.png");
    const { container } = render(<Avatar url="https://avatars.githubusercontent.com/u/1?v=4" name="octocat" />);
    const img = container.querySelector("img")!;
    expect(img).toBeTruthy();
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("O");
    expect(container.querySelector("[title='octocat']")).toBeTruthy();
  });

  it("rings reviewer avatars in their state colour and stacks at most two", () => {
    expect(reviewerRingColor("APPROVED")).toContain("approved");
    expect(reviewerRingColor("RE_REQUESTED")).toContain("neutral");
    const { container } = render(
      <AvatarStack
        items={["a", "b", "c"].map((n) => ({ key: n, url: null, name: n, ring: reviewerRingColor("APPROVED") }))}
        title="Reviewers"
      />,
    );
    expect(container.querySelectorAll("[data-avatar]")).toHaveLength(2);
  });
});

describe("chips", () => {
  it("shows the state tag except for open pull requests", () => {
    const { container, rerender } = render(<StateTag state="OPEN" isDraft={false} />);
    expect(container.textContent).toBe("");
    rerender(<StateTag state="OPEN" isDraft />);
    expect(container.textContent).toBe("DRAFT");
  });

  it("draws labels in their colour with readable text", () => {
    expect(labelForeground("ffffff")).toBe("#000000");
    expect(labelForeground("0e1a8a")).toBe("#ffffff");
    render(<LabelChip label={{ name: "bug", color: "d73a4a" }} />);
    expect(screen.getByText("bug").getAttribute("style")).toContain("background");
    render(<BranchChip name="feature/x" />);
    expect(screen.getByTitle("feature/x")).toBeTruthy();
  });
});

describe("ChooserPopup", () => {
  const users = [
    { id: "1", login: "ann", name: "Ann Lee" },
    { id: "2", login: "bob", name: "Robert" },
    { id: "3", login: "cy", name: null },
  ];
  const present = (u: (typeof users)[number]) => ({ text: u.login, detail: u.name, avatarUrl: null });
  const getKey = (u: (typeof users)[number]) => u.id;

  it("lists the chosen items first, without duplicates", () => {
    expect(chooserItems([users[2]!], users, getKey).map((u) => u.login)).toEqual(["cy", "ann", "bob"]);
  });

  it("chooses one item and closes (single)", () => {
    const onChoose = vi.fn();
    const onClose = vi.fn();
    render(
      <ChooserPopup
        mode="single"
        anchor={{ x: 0, y: 0 }}
        items={users}
        getKey={getKey}
        present={present}
        onChoose={onChoose}
        onClose={onClose}
        aria-label="Author"
      />,
    );
    const search = screen.getAllByLabelText("Author").find((e) => e.tagName === "INPUT")!;
    fireEvent.change(search, { target: { value: "rob" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChoose).toHaveBeenCalledWith(users[1]);
    expect(onClose).toHaveBeenCalled();
  });

  it("toggles items and reports them on close (multi)", async () => {
    const onClose = vi.fn();
    render(
      <ChooserPopup
        mode="multi"
        anchor={{ x: 0, y: 0 }}
        items={users}
        chosen={[users[0]!]}
        getKey={getKey}
        present={present}
        loading
        onClose={onClose}
        aria-label="Reviewers"
      />,
    );
    expect(screen.getByText("Loading…")).toBeTruthy();
    const search = screen.getAllByLabelText("Reviewers").find((e) => e.tagName === "INPUT")!;
    fireEvent.keyDown(search, { key: "Enter" }); // unchecks ann (first, active)
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" }); // checks bob
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(onClose).toHaveBeenCalledWith([users[1]]);
  });
});

describe("Markdown", () => {
  it("opens web links in the browser and never navigates the page for other links", async () => {
    const open = vi.spyOn(openUrl, "openExternalUrl").mockResolvedValue();
    const { container } = render(<Markdown text="[web](https://example.com/a) [rel](docs/guide.md)" />);
    const links = await vi.waitFor(() => {
      const found = container.querySelectorAll("a");
      expect(found).toHaveLength(2);
      return found;
    });
    const click = (a: Element) => {
      const e = new MouseEvent("click", { bubbles: true, cancelable: true });
      a.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(click(links[0]!)).toBe(true);
    expect(open).toHaveBeenCalledWith("https://example.com/a");
    open.mockClear();
    expect(click(links[1]!)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
