import { describe, expect, test } from "bun:test";
import {
  agentModelEnv,
  agentModelKindOf,
  agentModelsOf,
  builtinAgentOverrides,
  DEFAULT_AGENT_MODELS,
} from "../../src/domain/agentModels.ts";

describe("agentModels", () => {
  test("defaults: subagents and workers on sonnet, planning on opus", () => {
    expect(agentModelsOf(() => undefined)).toEqual({ subagent: "sonnet", worker: "sonnet", plan: "opus" });
    expect(DEFAULT_AGENT_MODELS.plan).toBe("opus");
  });

  test("a stored value wins; blank or whitespace falls back to the default", () => {
    const stored: Record<string, string> = { subagent: " haiku ", worker: "", plan: "  " };
    expect(agentModelsOf((k) => stored[k])).toEqual({ subagent: "haiku", worker: "sonnet", plan: "opus" });
  });

  test("only the three kinds are recognised", () => {
    expect(agentModelKindOf("worker")).toBe("worker");
    expect(agentModelKindOf("owner")).toBeUndefined();
  });

  test("the env carries the subagent default and the worker model, never the force switch", () => {
    const env = agentModelEnv({ subagent: "sonnet", worker: "haiku", plan: "opus" });
    expect(env).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", BOT_WORKER_MODEL: "haiku" });
    // forcing would also put Plan on the subagent model
    expect(env).not.toHaveProperty("CLAUDE_CODE_SUBAGENT_MODEL_FORCE");
  });

  test("Explore runs on the subagent model and Plan on the plan model, both read-only", () => {
    const o = builtinAgentOverrides({ subagent: "sonnet", worker: "sonnet", plan: "opus" });
    expect(Object.keys(o).sort()).toEqual(["Explore", "Plan"]);
    expect(o.Explore?.model).toBe("sonnet");
    expect(o.Plan?.model).toBe("opus");
    for (const def of Object.values(o)) {
      expect(typeof def.prompt).toBe("string");
      expect(def.disallowedTools).toEqual(expect.arrayContaining(["Edit", "Write", "Agent"]));
    }
  });
});
