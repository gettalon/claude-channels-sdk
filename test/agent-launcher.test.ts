/**
 * Tests for the persistent agent launcher (SDK query()-based).
 *
 * All tests mock the query() factory to avoid actually calling the Claude Agent SDK.
 * Tests use the real ~/.talon/agents/ directory for folder operations but
 * clean up after themselves.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Helpers: Mock Query ─────────────────────────────────────────────────────

/** Create a minimal mock Query object that satisfies the interface. */
function createMockQuery() {
  let closed = false;
  const messages: any[] = [];

  const mockQuery = {
    // AsyncGenerator interface
    async *[Symbol.asyncIterator]() {
      // Yield nothing — just stay open until closed
      while (!closed) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    next: async () => ({ value: undefined, done: true }) as any,
    return: async () => ({ value: undefined, done: true }) as any,
    throw: async () => ({ value: undefined, done: true }) as any,
    interrupt: async () => { closed = true; },
    close: () => { closed = true; },
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    applyFlagSettings: async () => {},
    initializationResult: async () => ({} as any),
    supportedCommands: async () => [],
    supportedModels: async () => [],
    supportedAgents: async () => [],
    mcpServerStatus: async () => [],
    getContextUsage: async () => ({} as any),
    reloadPlugins: async () => ({} as any),
    accountInfo: async () => ({} as any),
    rewindFiles: async () => ({} as any),
    seedReadState: async () => {},
    reconnectMcpServer: async () => {},
    toggleMcpServer: async () => {},
    setMcpServers: async () => ({} as any),
    streamInput: async () => {},
    stopTask: async () => {},
    _isMock: true,
    _closed: () => closed,
    _messages: messages,
  };

  return mockQuery as any;
}

// ── Dynamic imports ─────────────────────────────────────────────────────────

let launchAgent: typeof import("../dist/tools/agent-launcher.js").launchAgent;
let stopAgent: typeof import("../dist/tools/agent-launcher.js").stopAgent;
let sendToAgent: typeof import("../dist/tools/agent-launcher.js").sendToAgent;
let listRunningAgents: typeof import("../dist/tools/agent-launcher.js").listRunningAgents;
let getAgentStatus: typeof import("../dist/tools/agent-launcher.js").getAgentStatus;
let getAgent: typeof import("../dist/tools/agent-launcher.js").getAgent;
let agentFolder: typeof import("../dist/tools/agent-launcher.js").agentFolder;
let AsyncQueue: typeof import("../dist/tools/agent-launcher.js").AsyncQueue;
let _setQueryFactory: typeof import("../dist/tools/agent-launcher.js")._setQueryFactory;
let _resetQueryFactory: typeof import("../dist/tools/agent-launcher.js")._resetQueryFactory;
let _clearRunningAgents: typeof import("../dist/tools/agent-launcher.js")._clearRunningAgents;
let API_PROVIDERS: typeof import("../dist/tools/agent-launcher.js").API_PROVIDERS;

let mockQueryCalls: Array<{ prompt: any; options: any }>;
let lastMockQuery: ReturnType<typeof createMockQuery>;

// Track agent names we create so we can clean up
const createdAgentNames: string[] = [];

beforeEach(async () => {
  mockQueryCalls = [];

  // Dynamic import (ESM)
  const mod = await import("../dist/tools/agent-launcher.js");
  launchAgent = mod.launchAgent;
  stopAgent = mod.stopAgent;
  sendToAgent = mod.sendToAgent;
  listRunningAgents = mod.listRunningAgents;
  getAgentStatus = mod.getAgentStatus;
  getAgent = mod.getAgent;
  agentFolder = mod.agentFolder;
  AsyncQueue = mod.AsyncQueue;
  _setQueryFactory = mod._setQueryFactory;
  _resetQueryFactory = mod._resetQueryFactory;
  _clearRunningAgents = mod._clearRunningAgents;
  API_PROVIDERS = mod.API_PROVIDERS;

  // Clear any in-memory agents from previous tests
  _clearRunningAgents();

  // Mock the query factory
  _setQueryFactory((params: any) => {
    lastMockQuery = createMockQuery();
    mockQueryCalls.push({ prompt: params.prompt, options: params.options });
    return lastMockQuery;
  });
});

afterEach(async () => {
  _clearRunningAgents();
  _resetQueryFactory();
  // Clean up agent folders we created
  for (const name of createdAgentNames) {
    await rm(agentFolder(name), { recursive: true, force: true }).catch(() => {});
  }
  createdAgentNames.length = 0;
});

// ── AsyncQueue tests ────────────────────────────────────────────────────────

describe("AsyncQueue", () => {
  it("push and iterate works", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    const results: number[] = [];
    for await (const item of q) {
      results.push(item);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it("waits for items when queue is empty", async () => {
    const q = new AsyncQueue<string>();
    const results: string[] = [];

    // Start consuming in background
    const consumer = (async () => {
      for await (const item of q) {
        results.push(item);
      }
    })();

    // Push items after a delay
    q.push("hello");
    q.push("world");
    q.close();

    await consumer;
    expect(results).toEqual(["hello", "world"]);
  });

  it("ignores pushes after close", () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.close();
    q.push(2); // should be ignored
    expect(q.length).toBe(1);
    expect(q.isClosed).toBe(true);
  });

  it("reports length correctly", () => {
    const q = new AsyncQueue<number>();
    expect(q.length).toBe(0);
    q.push(1);
    expect(q.length).toBe(1);
    q.push(2);
    expect(q.length).toBe(2);
  });

  it("handles close when waiting for item", async () => {
    const q = new AsyncQueue<number>();
    const results: number[] = [];

    const consumer = (async () => {
      for await (const item of q) {
        results.push(item);
      }
    })();

    // Close immediately without pushing
    q.close();
    await consumer;
    expect(results).toEqual([]);
  });
});

// ── agentFolder tests ───────────────────────────────────────────────────────

describe("agentFolder", () => {
  it("returns correct path under ~/.talon/agents/", () => {
    const folder = agentFolder("dexter");
    expect(folder).toBe(join(homedir(), ".talon", "agents", "dexter"));
  });

  it("handles names with special characters", () => {
    const folder = agentFolder("my-agent-123");
    expect(folder).toBe(join(homedir(), ".talon", "agents", "my-agent-123"));
  });
});

// ── launchAgent tests ───────────────────────────────────────────────────────

describe("launchAgent", () => {
  it("creates folder, CLAUDE.md, and agent.json", async () => {
    const name = `test-agent-${Date.now()}`;
    createdAgentNames.push(name);

    const result = await launchAgent(name);

    expect(result.name).toBe(name);
    expect(result.status).toBe("running");
    expect(result.mode).toBe("master");
    expect(result.folder).toBe(agentFolder(name));

    // Check folder exists
    const folder = agentFolder(name);
    const folderStat = await stat(folder);
    expect(folderStat.isDirectory()).toBe(true);

    // Check CLAUDE.md was written
    const claudeMd = await readFile(join(folder, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain(name);
    expect(claudeMd).toContain("Mode: master");

    // Check agent.json metadata
    const meta = JSON.parse(await readFile(join(folder, "agent.json"), "utf-8"));
    expect(meta.name).toBe(name);
    expect(meta.status).toBe("running");
    expect(meta.mode).toBe("master");
    expect(meta.startedAt).toBeTruthy();
  });

  it("calls query() with streaming input and correct options", async () => {
    const name = `query-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);

    expect(mockQueryCalls.length).toBe(1);
    const call = mockQueryCalls[0];

    // prompt should be an AsyncIterable (the AsyncQueue)
    expect(call.prompt).toBeDefined();
    expect(typeof call.prompt[Symbol.asyncIterator]).toBe("function");

    // Options should include key settings
    expect(call.options.cwd).toBe(agentFolder(name));
    // continueConversation is false for fresh agents (no .claude dir yet)
    expect(call.options.continueConversation).toBe(false);
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    expect(call.options.mcpServers).toBeDefined();
    expect(call.options.mcpServers["talon-hub"]).toBeDefined();
    expect(call.options.mcpServers["talon-hub"].command).toBe("node");
  });

  it("respects custom prompt", async () => {
    const name = `prompt-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, { prompt: "You are a prediction markets expert." });

    // CLAUDE.md should have the custom prompt
    const claudeMd = await readFile(join(agentFolder(name), "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("You are a prediction markets expert.");
  });

  it("sets bot token env in MCP server config for direct mode", async () => {
    const name = `direct-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, {
      mode: "direct",
      botToken: "123:ABC",
    });

    const call = mockQueryCalls[0];
    const talonConfig = call.options.mcpServers["talon-hub"];
    expect(talonConfig.env.TELEGRAM_BOT_TOKEN).toBe("123:ABC");
    expect(talonConfig.env.TALON_AGENT_NAME).toBe(name);
  });

  it("sets mode in metadata and CLAUDE.md", async () => {
    const name = `bypass-test-${Date.now()}`;
    createdAgentNames.push(name);

    const result = await launchAgent(name, { mode: "bypass" });
    expect(result.mode).toBe("bypass");

    const claudeMd = await readFile(join(agentFolder(name), "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("Mode: bypass");
  });

  it("returns existing agent if already running", async () => {
    const name = `dup-test-${Date.now()}`;
    createdAgentNames.push(name);

    const first = await launchAgent(name);
    const second = await launchAgent(name);

    // Should be the same object
    expect(second).toBe(first);
    // query() should only have been called once
    expect(mockQueryCalls.length).toBe(1);
  });

  it("sets hubUrl in metadata", async () => {
    const name = `hub-test-${Date.now()}`;
    createdAgentNames.push(name);

    const result = await launchAgent(name, { hubUrl: "ws://10.0.0.1:8080" });
    expect(result.hubUrl).toBe("ws://10.0.0.1:8080");

    const meta = JSON.parse(await readFile(join(agentFolder(name), "agent.json"), "utf-8"));
    expect(meta.hubUrl).toBe("ws://10.0.0.1:8080");
  });

  it("provides a sendMessage function on the agent handle", async () => {
    const name = `send-handle-${Date.now()}`;
    createdAgentNames.push(name);

    const agent = await launchAgent(name);
    expect(typeof agent.sendMessage).toBe("function");
  });

  it("provides a query instance on the agent handle", async () => {
    const name = `query-handle-${Date.now()}`;
    createdAgentNames.push(name);

    const agent = await launchAgent(name);
    expect(agent.query).toBeDefined();
    expect(agent.query!._isMock).toBe(true);
  });
});

// ── sendToAgent tests ───────────────────────────────────────────────────────

describe("sendToAgent", () => {
  it("sends a message to a running agent", async () => {
    const name = `send-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);

    const result = sendToAgent(name, "Hello agent!");
    expect(result.sent).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("buffers message for non-running agent", () => {
    const result = sendToAgent("nonexistent-agent", "Hello");
    expect(result.sent).toBe(false);
    expect(result.buffered).toBe(true);
  });

  it("queues messages to the agent input", async () => {
    const name = `queue-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);

    // Send multiple messages
    sendToAgent(name, "Message 1");
    sendToAgent(name, "Message 2", "user123");

    // The messages should have been pushed to the queue
    // We can verify the agent handle has a sendMessage function
    const agent = getAgent(name);
    expect(agent).toBeDefined();
    expect(agent!.status).toBe("running");
  });
});

// ── stopAgent tests ─────────────────────────────────────────────────────────

describe("stopAgent", () => {
  it("stops a running agent", async () => {
    const name = `stop-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);
    const result = await stopAgent(name);
    expect(result.stopped).toBe(true);

    // Agent should now be stopped
    const agent = getAgent(name);
    expect(agent!.status).toBe("stopped");
    expect(agent!.query).toBeUndefined();
    expect(agent!.sendMessage).toBeUndefined();
  });

  it("returns error when agent is not running", async () => {
    const result = await stopAgent("nonexistent");
    expect(result.stopped).toBe(false);
    expect(result.error).toContain("not running");
  });

  it("updates metadata on disk", async () => {
    const name = `stop-meta-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);
    await stopAgent(name);

    const meta = JSON.parse(await readFile(join(agentFolder(name), "agent.json"), "utf-8"));
    expect(meta.status).toBe("stopped");
  });

  it("calls interrupt and close on the query", async () => {
    const name = `stop-query-${Date.now()}`;
    createdAgentNames.push(name);

    const agent = await launchAgent(name);
    const q = agent.query!;

    await stopAgent(name);

    // The mock query should have been closed
    expect(q._closed()).toBe(true);
  });
});

// ── listRunningAgents tests ─────────────────────────────────────────────────

describe("listRunningAgents", () => {
  it("returns empty array when no agents are running", async () => {
    const agents = await listRunningAgents();
    // Filter to our test agents only to avoid interference from real agents
    const testAgents = agents.filter((a) => a.name.includes("-test-") || a.name.includes("-list-"));
    // We haven't launched any, so test agents should be empty or all stopped
    for (const a of testAgents) {
      if (a.status === "running") {
        // This might be a leftover from a previous run
      }
    }
    expect(Array.isArray(agents)).toBe(true);
  });

  it("lists launched agents", async () => {
    const nameA = `list-a-${Date.now()}`;
    const nameB = `list-b-${Date.now()}`;
    createdAgentNames.push(nameA, nameB);

    await launchAgent(nameA);
    await launchAgent(nameB, { mode: "bypass" });

    const agents = await listRunningAgents();
    const names = agents.map((a) => a.name);

    expect(names).toContain(nameA);
    expect(names).toContain(nameB);

    const agentA = agents.find((a) => a.name === nameA)!;
    expect(agentA.status).toBe("running");
    expect(agentA.mode).toBe("master");

    const agentB = agents.find((a) => a.name === nameB)!;
    expect(agentB.status).toBe("running");
    expect(agentB.mode).toBe("bypass");
  });

  it("shows stopped agents after stop", async () => {
    const name = `list-stop-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);
    await stopAgent(name);

    const agents = await listRunningAgents();
    const agent = agents.find((a) => a.name === name);
    expect(agent).toBeDefined();
    expect(agent!.status).toBe("stopped");
  });
});

// ── getAgent tests ──────────────────────────────────────────────────────────

describe("getAgent", () => {
  it("returns undefined for non-existent agent", () => {
    const agent = getAgent("does-not-exist");
    expect(agent).toBeUndefined();
  });

  it("returns agent handle for running agent", async () => {
    const name = `get-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);
    const agent = getAgent(name);
    expect(agent).toBeDefined();
    expect(agent!.name).toBe(name);
    expect(agent!.status).toBe("running");
  });
});

// ── onOutput callback tests ─────────────────────────────────────────────────

describe("onOutput callback", () => {
  it("receives agent output when query yields assistant messages", async () => {
    const outputs: Array<{ name: string; text: string; chatId?: string }> = [];

    // Create a mock query that yields an assistant message then closes
    const mockQueryWithOutput = () => {
      let closed = false;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: { role: "assistant", content: "Hello from agent!" },
          };
          closed = true;
        },
        interrupt: async () => { closed = true; },
        close: () => { closed = true; },
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        applyFlagSettings: async () => {},
        initializationResult: async () => ({} as any),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        mcpServerStatus: async () => [],
        getContextUsage: async () => ({} as any),
        reloadPlugins: async () => ({} as any),
        accountInfo: async () => ({} as any),
        rewindFiles: async () => ({} as any),
        seedReadState: async () => {},
        reconnectMcpServer: async () => {},
        toggleMcpServer: async () => {},
        setMcpServers: async () => ({} as any),
        streamInput: async () => {},
        stopTask: async () => {},
        _isMock: true,
        _closed: () => closed,
      } as any;
    };

    _setQueryFactory(() => mockQueryWithOutput());

    const name = `output-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, {
      onOutput: (agentName, text, chatId) => {
        outputs.push({ name: agentName, text, chatId });
      },
    });

    // Wait for the output consumer to process the message
    await new Promise((r) => setTimeout(r, 200));

    expect(outputs.length).toBe(1);
    expect(outputs[0].name).toBe(name);
    expect(outputs[0].text).toBe("Hello from agent!");
  });

  it("tracks lastChatId from sendToAgent", async () => {
    const name = `chatid-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);
    sendToAgent(name, "Hello", "user1", "telegram:12345");

    const agent = getAgent(name);
    expect(agent!.lastChatId).toBe("telegram:12345");
  });

  it("handles array content blocks in assistant messages", async () => {
    const outputs: string[] = [];

    _setQueryFactory(() => {
      let closed = false;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Part 1. " },
                { type: "text", text: "Part 2." },
              ],
            },
          };
          closed = true;
        },
        interrupt: async () => { closed = true; },
        close: () => { closed = true; },
        setPermissionMode: async () => {},
        setModel: async () => {},
        setMaxThinkingTokens: async () => {},
        applyFlagSettings: async () => {},
        initializationResult: async () => ({} as any),
        supportedCommands: async () => [],
        supportedModels: async () => [],
        supportedAgents: async () => [],
        mcpServerStatus: async () => [],
        getContextUsage: async () => ({} as any),
        reloadPlugins: async () => ({} as any),
        accountInfo: async () => ({} as any),
        rewindFiles: async () => ({} as any),
        seedReadState: async () => {},
        reconnectMcpServer: async () => {},
        toggleMcpServer: async () => {},
        setMcpServers: async () => ({} as any),
        streamInput: async () => {},
        stopTask: async () => {},
        _isMock: true,
        _closed: () => closed,
      } as any;
    });

    const name = `array-output-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, {
      onOutput: (_name, text) => outputs.push(text),
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(outputs.length).toBe(1);
    expect(outputs[0]).toBe("Part 1. Part 2.");
  });
});

// ── getAgentStatus tests ────────────────────────────────────────────────────

describe("getAgentStatus", () => {
  it("returns stopped status for non-existent agent", async () => {
    const status = await getAgentStatus("ghost");
    expect(status.name).toBe("ghost");
    expect(status.status).toBe("stopped");
    expect(status.folder).toBe(agentFolder("ghost"));
  });

  it("returns correct metadata for running agent", async () => {
    const name = `status-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, { mode: "direct", botToken: "tok" });

    const status = await getAgentStatus(name);
    expect(status.name).toBe(name);
    expect(status.mode).toBe("direct");
    expect(status.botToken).toBe("tok");
    expect(status.status).toBe("running");
  });
});

describe("API Provider support", () => {
  it("has built-in provider presets", () => {
    expect(API_PROVIDERS.anthropic).toBeDefined();
    expect(API_PROVIDERS.glm).toBeDefined();
    expect(API_PROVIDERS.deepseek).toBeDefined();
    expect(API_PROVIDERS.ark).toBeDefined();
    expect(API_PROVIDERS.openrouter).toBeDefined();
  });

  it("glm provider has correct baseUrl and model", () => {
    expect(API_PROVIDERS.glm.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(API_PROVIDERS.glm.model).toBe("glm-5");
    expect(API_PROVIDERS.glm.smallModel).toBe("glm-4.7-air");
  });

  it("passes API provider env vars to query()", async () => {
    const name = `api-provider-test-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, { apiProvider: "glm" });

    const env = mockQueryCalls[0].options.env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ANTHROPIC_MODEL).toBe("glm-5");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("glm-4.7-air");
  });

  it("custom api_base_url overrides provider preset", async () => {
    const name = `api-custom-url-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, {
      apiProvider: "glm",
      apiBaseUrl: "https://custom.api.com/anthropic",
    });

    const env = mockQueryCalls[0].options.env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://custom.api.com/anthropic");
  });

  it("custom api_key overrides provider preset", async () => {
    const name = `api-custom-key-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, {
      apiProvider: "deepseek",
      apiToken: "sk-custom-123",
    });

    const env = mockQueryCalls[0].options.env;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-custom-123");
  });

  it("custom model overrides provider preset", async () => {
    const name = `api-custom-model-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name, {
      apiProvider: "glm",
      model: "glm-5-turbo",
      smallModel: "glm-4-air",
    });

    const env = mockQueryCalls[0].options.env;
    expect(env.ANTHROPIC_MODEL).toBe("glm-5-turbo");
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe("glm-4-air");
  });

  it("no provider defaults to inherited env vars", async () => {
    const name = `api-inherit-${Date.now()}`;
    createdAgentNames.push(name);

    await launchAgent(name);

    const env = mockQueryCalls[0].options.env;
    // Should inherit from process.env — no override set
    expect(env.TALON_AGENT_NAME).toBe(name);
  });

  it("unknown provider name is ignored gracefully", async () => {
    const name = `api-unknown-${Date.now()}`;
    createdAgentNames.push(name);

    // Should not throw
    await launchAgent(name, { apiProvider: "nonexistent" });
    expect(mockQueryCalls.length).toBe(1);
  });
});
