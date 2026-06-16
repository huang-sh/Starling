import type { Task } from "../types.js";
import { personalityTask } from "./personality.js";

/** All bundled tasks, keyed by id. */
const TASKS: Record<string, Task> = {
  [personalityTask.id]: personalityTask,
};

/** Load a task by id. Throws if the id is unknown. */
export function loadTask(id: string): Task {
  const task = TASKS[id];
  if (!task) {
    throw new Error(`Unknown task: ${id}\nAvailable tasks: ${listTaskIds().join(", ")}`);
  }
  return task;
}

/** List all available task ids. */
export function listTaskIds(): string[] {
  return Object.keys(TASKS).sort();
}
