import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="flex flex-col gap-4 rounded-xl bg-white p-6 shadow-sm">
      <h1 className="text-2xl font-semibold text-brand-700">Tailwind CSS fixture</h1>
      {/* Intentional warning: `flex` and `block` both set `display`. */}
      <p className="flex block text-slate-600">Clicked {count} times.</p>
      <button type="button" className="btn self-start" onClick={() => setCount(count + 1)}>
        Click me
      </button>
    </main>
  );
}
