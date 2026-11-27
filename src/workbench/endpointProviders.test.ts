import { expect, it, vi } from "vitest";
import {
  endpointsChanged,
  onEndpointsChanged,
  registerEndpointProvider,
  searchEndpoints,
  type EndpointEntry,
} from "./contributions";

const endpoint: EndpointEntry = {
  method: "GET",
  url: "/menu/list",
  controller: "MenuController",
  methodName: "listMenus",
  path: "/p/MenuController.java",
  rel: "MenuController.java",
  line: 4,
  col: 11,
};

it("collects endpoints from all providers for the requested root", async () => {
  const first = vi.fn(async () => [endpoint]);
  const second = vi.fn(async () => [{ ...endpoint, url: "/other" }]);
  const disposers = [
    registerEndpointProvider({ id: "test.first", endpoints: first }),
    registerEndpointProvider({ id: "test.second", endpoints: second }),
  ];
  try {
    expect(await searchEndpoints(null)).toEqual([]);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(await searchEndpoints("/p")).toEqual([endpoint, { ...endpoint, url: "/other" }]);
    expect(first).toHaveBeenCalledWith("/p");
    expect(second).toHaveBeenCalledWith("/p");
  } finally {
    disposers.forEach((dispose) => dispose());
  }
  expect(await searchEndpoints("/p")).toEqual([]);
});

it("keeps a replacement provider registered when its predecessor is disposed", async () => {
  const disposeOld = registerEndpointProvider({ id: "test.replaced", endpoints: async () => [] });
  const disposeNew = registerEndpointProvider({ id: "test.replaced", endpoints: async () => [endpoint] });
  try {
    disposeOld();
    expect(await searchEndpoints("/p")).toEqual([endpoint]);
  } finally {
    disposeOld();
    disposeNew();
  }
  expect(await searchEndpoints("/p")).toEqual([]);
});

it("keeps notifying endpoint listeners after one throws", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const second = vi.fn();
  const offs = [
    onEndpointsChanged(() => {
      throw new Error("boom");
    }),
    onEndpointsChanged(second),
  ];
  try {
    endpointsChanged();
  } finally {
    offs.forEach((off) => off());
  }
  expect(second).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
});
