import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Input, SearchField } from "./Input";

const distancePerCharacter = 20;
const fieldWidth = 100;
const value = "字".repeat(30);

beforeEach(() => {
  vi.useFakeTimers();
  const canvasContext = {
    measureText: (text: string) => ({ width: text.length * distancePerCharacter }),
  } as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(canvasContext);
});

afterEach(() => {
  fireEvent.mouseUp(window);
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setFieldGeometry(field: HTMLInputElement | HTMLTextAreaElement) {
  Object.defineProperties(field, {
    clientWidth: { value: fieldWidth },
    scrollWidth: { value: value.length * distancePerCharacter },
  });
  vi.spyOn(field, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, fieldWidth, 20));
}

it.each([
  { edge: "left", pointerX: -1, endpoint: "selectionStart" },
  { edge: "right", pointerX: fieldWidth + 1, endpoint: "selectionEnd" },
] as const)("keeps scrolling past wide characters at the $edge edge", ({ edge, pointerX, endpoint }) => {
  const view = render(<SearchField value={value} onChange={() => {}} multiline />);
  const field = view.getByRole("textbox") as HTMLTextAreaElement;
  setFieldGeometry(field);
  field.focus();
  field.scrollLeft = 200;
  field.setSelectionRange(12, 12);
  fireEvent.mouseDown(field, { button: 0, clientX: 42, clientY: 10 });
  fireEvent.mouseMove(window, { buttons: 1, clientX: pointerX, clientY: 10 });
  for (let i = 0; i < 25; i++) vi.advanceTimersToNextFrame();

  if (edge === "left") {
    expect(field.scrollLeft).toBeLessThan(200);
    expect(field[endpoint]).toBeLessThan(10);
    expect(field.selectionEnd).toBe(12);
  } else {
    expect(field.scrollLeft).toBeGreaterThan(200);
    expect(field[endpoint]).toBeGreaterThan(15);
    expect(field.selectionStart).toBe(12);
  }
  fireEvent.mouseUp(window);
  const offset = field.scrollLeft;
  vi.advanceTimersToNextFrame();
  expect(field.scrollLeft).toBe(offset);
});

it.each(["number", "date", "password"])("leaves selection to the browser for %s inputs", (type) => {
  const { container } = render(<Input type={type} />);
  const field = container.querySelector("input")!;
  setFieldGeometry(field);
  field.focus();
  const selection = vi.spyOn(field, "setSelectionRange").mockImplementation(() => {});
  fireEvent.mouseDown(field, { button: 0, clientX: 42, clientY: 10 });
  expect(fireEvent.mouseMove(window, { buttons: 1, clientX: 120, clientY: 10 })).toBe(true);
  expect(selection).not.toHaveBeenCalled();
});

it("respects a caller that prevents the start of a drag", () => {
  const view = render(<Input defaultValue={value} onMouseDown={(e) => e.preventDefault()} />);
  const field = view.getByRole("textbox") as HTMLInputElement;
  setFieldGeometry(field);
  field.focus();
  fireEvent.mouseDown(field, { button: 0, clientX: 42, clientY: 10 });
  expect(fireEvent.mouseMove(window, { buttons: 1, clientX: 120, clientY: 10 })).toBe(true);
  expect(field.scrollLeft).toBe(0);
});
