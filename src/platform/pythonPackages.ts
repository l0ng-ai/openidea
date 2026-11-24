/** The packages of a Python interpreter, and which of them have a newer release. */
import { useCallback, useEffect, useState } from "react";
import { call, commands, nextRequestId, type PythonPackage } from "./ipc";

export function usePythonPackages(python: string | null) {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    python: string;
    packages: PythonPackage[] | null;
    error: string | null;
  } | null>(null);
  // Newer releases by package name; `null` when the check failed.
  const [newer, setNewer] = useState<{ key: string; versions: Map<string, string> | null } | null>(null);
  useEffect(() => {
    if (!python) return;
    let live = true;
    let check: number | undefined;
    const key = `${python}#${tick}`;
    call(commands.sdkPythonPackages(python, false, nextRequestId()))
      .then((packages) => {
        if (!live) return;
        setResult({ key, python, packages, error: null });
        // The list shows first: this asks the package index, which can take a while.
        const request = nextRequestId();
        check = request;
        call(commands.sdkPythonPackages(python, true, request))
          .then(
            (outdated) =>
              live && setNewer({ key, versions: new Map(outdated.map((p) => [p.name, p.latestVersion ?? p.version])) }),
            () => live && setNewer({ key, versions: null }),
          )
          .finally(() => (check = undefined));
      })
      .catch(
        (e: unknown) => live && setResult({ key, python, packages: null, error: String((e as Error)?.message ?? e) }),
      );
    return () => {
      live = false;
      if (check !== undefined) void commands.cancelRequest(check);
    };
  }, [python, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  // While reloading the same interpreter, keep showing its previous list.
  const same = !!python && result?.python === python;
  const key = `${python}#${tick}`;
  const listed = same && result.key === key && !!result.packages;
  return {
    packages: same ? result.packages : null,
    error: same ? result.error : null,
    loading: !!python && result?.key !== key,
    newer: listed && newer?.key === key ? newer.versions : null,
    checking: listed && newer?.key !== key,
    checkFailed: listed && newer?.key === key && !newer.versions,
    reload,
  };
}
