import { createContext, useCallback, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";

// A phase can move from the live tail into persisted history. Its expansion
// belongs to the logical phase, not whichever component currently hosts it.
export const TaskChatExpansionState = createContext<Map<string, boolean> | null>(null);

export function useTaskChatExpansion(id: string, initial: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const memory = useContext(TaskChatExpansionState);
  const [open, setOpen] = useState(() => memory?.get(id) ?? initial);
  const update = useCallback<Dispatch<SetStateAction<boolean>>>((value) => {
    setOpen((previous) => {
      const next = typeof value === "function" ? value(previous) : value;
      memory?.set(id, next);
      return next;
    });
  }, [id, memory]);
  return [open, update];
}

// Runs whose compacted output the reader asked to see through the history
// disclosure ("More run output"). Their saved activity opens with that one
// activation instead of needing a second click per turn; later toggles are
// remembered in TaskChatExpansionState like any other.
const NO_REVEALED_RUNS: ReadonlySet<string> = new Set();
export const TaskChatRevealedRunIds = createContext<ReadonlySet<string>>(NO_REVEALED_RUNS);
export const TaskChatRevealActivity = createContext(false);

export function TaskChatRunActivityReveal({ runId, children }: { runId?: string | null; children: ReactNode }) {
  const revealed = useContext(TaskChatRevealedRunIds);
  return (
    <TaskChatRevealActivity.Provider value={Boolean(runId && revealed.has(runId))}>
      {children}
    </TaskChatRevealActivity.Provider>
  );
}

/** Like useTaskChatExpansion, but opens once when its run's output is revealed. */
export function useRevealableTaskChatExpansion(id: string, initial: boolean): [boolean, Dispatch<SetStateAction<boolean>>] {
  const reveal = useContext(TaskChatRevealActivity);
  const memory = useContext(TaskChatExpansionState);
  const [open, setOpen] = useTaskChatExpansion(id, initial || reveal);
  useEffect(() => {
    if (reveal && !memory?.has(id)) setOpen(true);
  }, [reveal, memory, id, setOpen]);
  return [open, setOpen];
}
