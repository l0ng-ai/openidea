import type { commands } from "@/platform/ipc";

/** Lets tests share their fixtures for batched and single execution. */
export function streamExecution(execute: typeof commands.dbExecute): typeof commands.dbExecuteStream {
  return async (request, id, statements, maxRows, schema, channel) => {
    channel.onmessage({ type: "started", index: 0 });
    const reply = await execute(request, id, statements, 0, maxRows, schema);
    if (reply.status === "error") channel.onmessage({ type: "done", error: reply.error });
    else {
      reply.data.forEach((outcome, index) => {
        if (index) channel.onmessage({ type: "started", index });
        channel.onmessage({ type: "completed", index, outcome });
      });
      channel.onmessage({ type: "done", error: null });
    }
    return { status: "ok", data: null };
  };
}
