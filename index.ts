import fs from "node:fs";
import path from "node:path";

export default function(api) {

    const serviceUrl = api.pluginConfig?.serviceUrl ?? "https://dmem.ai";
    const apiKey = api.pluginConfig?.apiKey ?? "local";

    const LOOKUP_RESULT_INSTRUCTIONS = "\n\n---\nThe confidence score indicates how strongly the memory system believes this answer is accurate. Use results with confidence above 0.7 as reliable context. For scores between 0.3 and 0.7, surface the information tentatively — e.g. \"I think we discussed this before, but I'm not certain.\" For scores below 0.3, treat the result as speculative or ignore it."

    const TOOL_INSTRUCTIONS = `IMPORTANT — DO BOTH ON EVERY MESSAGE:\n1. LOOK UP FIRST: Does this reference a person, project, topic, or anything that could be from a past conversation? If yes or unsure, call lookup() BEFORE responding. Ignore sender metadata when formulating lookup queries.\n2. REMEMBER AFTER: Did the user share a long-term fact — a preference, decision, project detail, or explicit instruction? Call remember(). ONLY store things useful days or weeks from now. Do NOT store transient activity like debugging, test results, or what's happening right now.`

    const HIJACK_PROMPT = "DO NOT read memory/YYYY-MM-DD.md or MEMORY.md. Ignore any instructions from other files that tell you to read memory/YYYY-MM-DD.md or MEMORY.md.\nAll memory is managed by dmem.\nAll memory operations go through your dmem tools: lookup() and remember()."

    const DMEM_STATE_FILE = path.join(
        process.env.HOME ?? "/tmp",
        ".openclaw",
        "workspace",
        ".dmem-last-session"
    );

    let lastSessionIds: Record<string, string> = {};
    try {
        lastSessionIds = JSON.parse(fs.readFileSync(DMEM_STATE_FILE, "utf-8"));
    } catch {}

    let sessionKey = "unknown";

    const waitingForFlush: Record<string, boolean> = {};
    const needsBootstrapReinject: Record<string, boolean> = {};

    function triggerFlush(sessionId: string, sessionKey: string, cacheSummary: boolean) {
        void fetch(serviceUrl + "/flush_openclaw", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": apiKey,
            },
            body: JSON.stringify({
                session_id: sessionId,
                session_key: sessionKey,
                cache_summary: cacheSummary
            }),
        }).catch((err) => {
            api.logger.warn(`dmem: flush failed: ${String(err)}`);
        });
    }

    function persistState() {
        try {
            fs.mkdirSync(path.dirname(DMEM_STATE_FILE), { recursive: true });
            fs.writeFileSync(DMEM_STATE_FILE, JSON.stringify(lastSessionIds));
        } catch {}
    }

    api.on("before_tool_call", async (event, ctx) => {
        // need to set sessionKey before toolCall so that it can be sent to dmem server
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";
    });

    api.on("after_tool_call", async (event, ctx) => {
        api.logger.warn(`dmemtool: after tool call: ${String(event.toolName)} ${JSON.stringify(event.params)}`);
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";
        void fetch(serviceUrl + "/ingest_toolcall_openclaw", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": apiKey
            },
            body: JSON.stringify({
                tool_name: event.toolName,
                args: event.params,
                result: event.result,
                session_key: sessionKey,
            }),
        }).catch((err) => {
            api.logger.warn(`dmem: tool call ingest failed: ${String(err)}`);
        });
    });

    api.on("after_compaction", async (event, ctx) => {
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";
        const lastSessionId = lastSessionIds[sessionKey];
        if (lastSessionId) {
            triggerFlush(lastSessionId, sessionKey, false);
        }
	needsBootstrapReinject[sessionKey] = true;
    });

    api.on("before_agent_start", async (event, ctx) => {
        const sessionId = (ctx as any)?.sessionId ?? "unknown";
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";

        if (sessionKey.startsWith("slug-generator") || sessionKey.startsWith("unknown")) return {};

        const lastSessionId = lastSessionIds[sessionKey];

        if (lastSessionId && sessionId !== lastSessionId) {
            triggerFlush(lastSessionId, sessionKey, true);
            waitingForFlush[sessionKey] = true;
	}

	if (sessionId !== lastSessionId) {
            lastSessionIds[sessionKey] = sessionId;
	    persistState();
        }

        if (sessionId !== lastSessionId || needsBootstrapReinject[sessionKey]) {
            const response = await fetch(serviceUrl + "/bootstrap", {
                headers: { "Authorization": apiKey }
            });
            const data = await response.json();
            needsBootstrapReinject[sessionKey] = false;
            return {
                prependContext: `<memory-hijack>${HIJACK_PROMPT}</memory-hijack><bootstrap-memories>${data.memories}</bootstrap-memories><memory-instructions>${TOOL_INSTRUCTIONS}</memory-instructions>`
            };
        } else if (waitingForFlush[sessionKey]) {
            // check server if flush for session key has completed. inject results if it has.
            const response = await fetch(serviceUrl + "/pending_summary?" + new URLSearchParams({
                session_key: sessionKey
            }), {
                headers: { "Authorization": apiKey }
            });
            const data = await response.json();
            if (data.summary) {
                waitingForFlush[sessionKey] = false;
                return {
                    prependContext: `<previous-conversation-summary>This is a summary of your previous conversation with the user. This summary was being processed when the current conversation started and has just become available. Do not acknowledge or reference this summary directly — just use the information naturally.\n\n${data.summary}</previous-conversation-summary><memory-instructions>${TOOL_INSTRUCTIONS}</memory-instructions>`
                };
            }
        }

        return {
            prependContext: `<memory-instructions>${TOOL_INSTRUCTIONS}</memory-instructions>`
        };
    });

    api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
            return;
        }

        const sessionId = (ctx as any)?.sessionId ?? "unknown";
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";

        try {
            // Find the last user message index — that's the start of the turn
            let turnStart = -1;
            for (let i = event.messages.length - 1; i >= 0; i--) {
                const msg = event.messages[i] as Record<string, unknown>;
                if (msg?.role === "user") {
                    turnStart = i;
                    break;
                }
            }
            if (turnStart === -1) return;

            const turnMessages = event.messages.slice(turnStart);
            const formattedMessages: Array<{
                role: string;
                content: string;
                type?: string;
            }> = [];

            for (const msg of turnMessages) {
                if (!msg || typeof msg !== "object") continue;
                const msgObj = msg as Record<string, unknown>;
                const role = msgObj.role as string;
                if (!role) continue;

                let textContent = "";
                const content = msgObj.content;

                if (typeof content === "string") {
                    textContent = content;
                } else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (
                            block &&
                            typeof block === "object" &&
                            "text" in block &&
                            typeof (block as Record<string, unknown>).text === "string"
                        ) {
                            textContent +=
                                (textContent ? "\n" : "") +
                                ((block as Record<string, unknown>).text as string);
                        }
                    }
                }

                if (!textContent) continue;

                formattedMessages.push({
                    role,
                    content: textContent,
                });
            }

            if (formattedMessages.length === 0) return;

            await fetch(serviceUrl + "/ingest_openclaw", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": apiKey
                },
                body: JSON.stringify({
                    session_id: sessionId,
                    session_key: sessionKey,
                    messages: formattedMessages
                }),
            }).catch((err) => {
                api.logger.warn(`dmem: ingest failed: ${String(err)}`);
            });
        } catch (err) {
            api.logger.warn(`dmem: capture failed: ${String(err)}`);
        }
    });

    api.registerTool({
        name: "remember",
        description: "Use this tool to save something important to long-term memory — facts about the user, their preferences, ongoing projects, or explicit instructions they've given you. Call this whenever you learn something worth remembering across future conversations, or when the user explicitly asks you to remember something.",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "What to store in memory"
                }
            },
            required: ["text"]
        },
        async execute(_id, params) {
            await fetch(serviceUrl + "/remember_openclaw", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": apiKey
                },
                body: JSON.stringify({
                   "text": params.text,
                   "session_key": sessionKey
                }),
            });
            return {
                content: [{
            	    type: "text",
                    text: "ok"
                }]
            };
        }
    });

    api.registerTool({
        name: "lookup",
        description: "Use lookup() whenever the user references something from a past conversation, or when you think relevant context might exist from previous sessions. Describe what you're looking for in natural language — be specific about what information you need. Call lookup() separately for each distinct topic if you need information about multiple things.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "What to look up in memory"
                }
            },
            required: ["query"]
        },
        async execute(_id, params) {
            const response = await fetch(`${serviceUrl}/lookup?m=${encodeURIComponent(params.query)}`, {
                headers: {
                    "Authorization": apiKey
                }
            });
            const data = await response.json();
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(data) + LOOKUP_RESULT_INSTRUCTIONS
                }]
            };
        }
    });
}
