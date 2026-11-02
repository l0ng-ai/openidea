/** Test helper: an endpoint of a fake provider. */
import type { Endpoint } from "./model";

const ROOT = "/p/app";

export function endpoint(method: string, path: string, target: string, extra: Partial<Endpoint> = {}): Endpoint {
  const targetClass = extra.targetClass ?? target.split(/[#.]/)[0]!;
  return {
    id: `test:${method} ${path}`,
    method,
    path,
    target,
    targetClass,
    name: null,
    file: `${ROOT}/config/routes.rb`,
    line: 1,
    module: "app",
    framework: "Test",
    type: "HTTP",
    request: { name: target, method, url: `http://localhost${path}`, headers: [] },
    ...extra,
  };
}
