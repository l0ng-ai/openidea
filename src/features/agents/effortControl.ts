import { useEffect, useMemo, useReducer, useState } from "react";
import type { AgentConfigOption } from "@/bindings";
import { notifications } from "@/workbench/contributions";
import { nextValue } from "./composerModel";

type Write = (id: string, value: string) => void | Promise<unknown>;
type Kind = "effort" | "model" | "other";
interface Choice {
  id: string;
  value: string;
  previous: string | null;
  kind: Kind;
  identity: string;
  epoch: number;
  write: Write;
  settled: boolean;
}
interface Control {
  identity: string;
  config: readonly AgentConfigOption[];
  write: Write;
  epoch: number;
  flight: Choice | null;
  queue: Choice[];
  effort: Choice | null;
  switching: Choice | null;
  announcement: string | null;
  active: boolean;
}

function sameLevels(a: AgentConfigOption | undefined, b: AgentConfigOption | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.id === b.id &&
    a.via === b.via &&
    a.values.length === b.values.length &&
    a.values.every((value, index) => value.value === b.values[index]!.value && value.name === b.values[index]!.name)
  );
}

/** One writer per composer host; the latest effort intent wins without racing provider requests. */
export function useEffortControl(config: readonly AgentConfigOption[], write: Write, identity: string) {
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  const [state] = useState<Control>(() => ({
    identity,
    config,
    write,
    epoch: 0,
    flight: null,
    queue: [],
    effort: null,
    switching: null,
    announcement: null,
    active: true,
  }));
  const previousModel = state.config.find((option) => option.category === "model");
  const model = config.find((option) => option.category === "model");
  const previousEffort = state.config.find((option) => option.category === "thought_level" && option.values.length > 0);
  const effort = config.find((option) => option.category === "thought_level" && option.values.length > 0);
  const flight = state.flight?.epoch === state.epoch ? state.flight : null;
  const modelFlight = state.flight?.kind === "model" && state.flight.identity === identity ? state.flight : null;
  const modelChanged = previousModel?.id !== model?.id || previousModel?.current !== model?.current;
  const ownModelChange =
    state.switching &&
    model?.id === state.switching.id &&
    (model.current === state.switching.value ||
      (modelFlight && (model.current === modelFlight.value || model.current === modelFlight.previous)));
  const ownEffortChange =
    state.effort &&
    effort?.id === state.effort.id &&
    (effort.current === state.effort.value ||
      (flight?.kind === "effort" && (effort.current === flight.value || effort.current === flight.previous)));
  if (
    state.identity !== identity ||
    (modelChanged && !ownModelChange) ||
    (!sameLevels(previousEffort, effort) && !state.switching) ||
    (state.effort && previousEffort?.current !== effort?.current && !ownEffortChange)
  ) {
    state.epoch++;
    state.queue = [];
    state.effort = null;
    state.switching = null;
    state.announcement = null;
  }
  state.identity = identity;
  state.config = config;
  state.write = write;
  // Keep an optimistic event from ending the flight, and keep a completed sync choice
  // visible until its new props arrive (including several presses in the same event).
  if (state.effort?.settled && effort?.current === state.effort.value) state.effort = null;
  if (state.switching?.settled && model?.current === state.switching.value) state.switching = null;

  const handlers = useMemo(() => {
    function finish(choice: Choice, succeeded: boolean, error?: unknown) {
      if (state.flight !== choice) return;
      state.flight = null;
      if (!state.active) return;
      if (choice.epoch === state.epoch) {
        if (!succeeded) {
          state.queue = [];
          state.effort = null;
          state.switching = null;
          state.announcement = null;
          notifications().notify({ level: "error", title: "Couldn't change the setting", body: String(error) });
        } else {
          if (choice.kind === "effort" && state.effort?.id === choice.id && state.effort.value === choice.value) {
            state.effort.settled = true;
            if (state.config.find((option) => option.id === choice.id)?.current === choice.value) state.effort = null;
          }
          if (state.switching === choice) {
            choice.settled = true;
            if (state.config.find((option) => option.id === choice.id)?.current === choice.value)
              state.switching = null;
          }
        }
      }
      flush();
      refresh();
    }

    function flush() {
      if (!state.active || state.flight) return;
      const choice = state.queue.shift();
      if (!choice) return;
      state.flight = choice;
      try {
        const result = choice.write(choice.id, choice.value);
        if (result) {
          void result.then(
            () => finish(choice, true),
            (error: unknown) => finish(choice, false, error),
          );
        } else {
          finish(choice, true);
        }
      } catch (error) {
        finish(choice, false, error);
      }
    }

    function change(id: string, value: string, announce: boolean) {
      if (!state.active) return;
      const option = state.config.find((entry) => entry.id === id);
      const kind: Kind =
        option?.category === "thought_level" ? "effort" : option?.category === "model" ? "model" : "other";
      if (kind === "effort" && state.switching) return;
      if (kind === "model") {
        state.epoch++;
        state.effort = null;
        state.announcement = null;
        state.queue = state.queue.filter((choice) => choice.kind === "other");
      }
      const choice: Choice = {
        id,
        value,
        previous: (kind === "effort" ? state.effort?.value : null) ?? option?.current ?? null,
        kind,
        identity: state.identity,
        epoch: state.epoch,
        write: state.write,
        settled: false,
      };
      if (kind === "effort") {
        state.effort = choice;
        state.announcement = announce ? (option?.values.find((level) => level.value === value)?.name ?? null) : null;
        state.queue = state.queue.filter((queued) => queued.kind !== "effort");
        // A full lap can land back on the request already in flight.
        const alreadyWriting =
          state.flight?.epoch === state.epoch &&
          state.flight.kind === "effort" &&
          state.flight.id === id &&
          state.flight.value === value;
        if (!alreadyWriting) {
          state.queue.push(choice);
        }
      } else {
        if (kind === "model") state.switching = choice;
        state.queue.push(choice);
      }
      flush();
      refresh();
    }

    return {
      onChange: (id: string, value: string) => change(id, value, false),
      cycle: () => {
        if (state.switching) return;
        const option = state.config.find((entry) => entry.category === "thought_level" && entry.values.length > 0);
        if (!option || option.values.length <= 1) return;
        const value = nextValue(option, state.effort?.value ?? option.current);
        if (value !== null) change(option.id, value, true);
      },
    };
  }, [state]);

  useEffect(() => {
    state.active = true;
    return () => {
      state.active = false;
      state.epoch++;
      state.queue = [];
      state.effort = null;
      state.switching = null;
    };
  }, [state]);

  const desired = state.effort;
  return {
    config: desired
      ? config.map((option) => (option.id === desired.id ? { ...option, current: desired.value } : option))
      : config,
    onChange: handlers.onChange,
    cycle: !state.switching && effort && effort.values.length > 1 ? handlers.cycle : undefined,
    announcement: state.announcement,
    pending: state.flight !== null || state.queue.length > 0 || state.switching !== null,
  };
}
