import type { ActionFunctionArgs } from "react-router";

/** Wrap an action so thrown API errors surface as `{ error }` instead of crashing. */
export const guard =
  (fn: (a: ActionFunctionArgs) => Promise<unknown>) =>
  async (args: ActionFunctionArgs) => {
    try {
      return await fn(args);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
