import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
export default definePluginEntry({
    id: "dmem",
    name: "dmem (Memory)",
    description: "dmem memory_search replacement",
    register(api) {
        const serviceUrl = api.pluginConfig?.serviceUrl ?? "https://dmem.ai";
        const apiKey = api.pluginConfig?.apiKey ?? "local";
        const reinjectFrequency = api.pluginConfig?.reinjectFrequency ?? 3;
        const LOOKUP_RESULT_INSTRUCTIONS = "\n\n---\nThe confidence score indicates how strongly the memory system believes this answer is accurate. Use results with confidence above 0.7 as reliable context. For scores between 0.3 and 0.7, surface the information tentatively — e.g. \"I think we discussed this before, but I'm not certain.\" For scores below 0.3, treat the result as speculative or ignore it.";
        const TOOL_INSTRUCTIONS = `IMPORTANT — DO ON EVERY MESSAGE:\nLOOK UP FIRST: Does this reference a person, project, topic, or anything that could be from a past conversation, or is there potentially relevant context from a past conversation? If yes or unsure, call memory_search() BEFORE responding. Ignore sender metadata when formulating memory_search queries.`;
        const DMEM_STATE_FILE = path.join(os.tmpdir(), "dmem-last-session");
        let turnCount = 0;
        let lastSessionIds = {};
        try {
            lastSessionIds = JSON.parse(fs.readFileSync(DMEM_STATE_FILE, "utf-8"));
        }
        catch { }
        let sessionKey = "unknown";
        const waitingForFlush = {};
        function triggerFlush(sessionId, sessionKey, cacheSummary) {
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
            }
            catch { }
        }
        api.on("after_compaction", async (event, ctx) => {
            sessionKey = ctx?.sessionKey ?? "unknown";
            const lastSessionId = lastSessionIds[sessionKey];
            if (lastSessionId) {
                triggerFlush(lastSessionId, sessionKey, false);
            }
        });
        api.on("before_agent_start", async (event, ctx) => {
            const sessionId = ctx?.sessionId ?? "unknown";
            sessionKey = ctx?.sessionKey ?? "unknown";
            if (sessionKey.startsWith("slug-generator") || sessionKey.startsWith("unknown"))
                return {};
            const lastSessionId = lastSessionIds[sessionKey];
            if (lastSessionId && sessionId !== lastSessionId) {
                triggerFlush(lastSessionId, sessionKey, true);
                waitingForFlush[sessionKey] = true;
            }
            if (sessionId !== lastSessionId) {
                lastSessionIds[sessionKey] = sessionId;
                persistState();
            }
            if (turnCount % reinjectFrequency == 0 || sessionId !== lastSessionId) {
                turnCount += 1;
                return {
                    prependContext: `<memory-instructions>${TOOL_INSTRUCTIONS}</memory-instructions>`
                };
            }
            turnCount += 1;
        });
        api.on("agent_end", async (event, ctx) => {
            if (!event.success || !event.messages || event.messages.length === 0) {
                return;
            }
            const sessionId = ctx?.sessionId ?? "unknown";
            sessionKey = ctx?.sessionKey ?? "unknown";
            try {
                // Find the last user message index — that's the start of the turn
                let turnStart = -1;
                for (let i = event.messages.length - 1; i >= 0; i--) {
                    const msg = event.messages[i];
                    if (msg?.role === "user") {
                        turnStart = i;
                        break;
                    }
                }
                if (turnStart === -1)
                    return;
                const turnMessages = event.messages.slice(turnStart);
                const formattedMessages = [];
                for (const msg of turnMessages) {
                    if (!msg || typeof msg !== "object")
                        continue;
                    const msgObj = msg;
                    const role = msgObj.role;
                    if (!role)
                        continue;
                    let textContent = "";
                    const content = msgObj.content;
                    if (typeof content === "string") {
                        textContent = content;
                    }
                    else if (Array.isArray(content)) {
                        for (const block of content) {
                            if (block &&
                                typeof block === "object" &&
                                "text" in block &&
                                typeof block.text === "string") {
                                textContent +=
                                    (textContent ? "\n" : "") +
                                        block.text;
                            }
                        }
                    }
                    if (!textContent)
                        continue;
                    formattedMessages.push({
                        role,
                        content: textContent,
                    });
                }
                if (formattedMessages.length === 0)
                    return;
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
            }
            catch (err) {
                api.logger.warn(`dmem: capture failed: ${String(err)}`);
            }
        });
        api.registerTool({
            name: "recent_context",
            label: "Recent Context",
            description: "Get a summary of the last 7 days of your conversations with your user. Call this if the user asks something like 'what have we been working on'. Call with latency_matters=true unless explicitly prompted to call with latency_matters=false.",
            parameters: Type.Object({
                latency_matters: Type.Boolean(),
            }),
            async execute(_id, params) {
                const response = await fetch(`${serviceUrl}/recent_context?hot_path=${encodeURIComponent(params.latency_matters)}`, {
                    headers: {
                        "Authorization": apiKey
                    }
                });
                const data = await response.json();
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify(data)
                        }],
                    details: {}
                };
            }
        });
        api.registerTool({
            name: "memory_search",
            label: "Memory Search",
            description: "Use memory_search() whenever the user references something from a past conversation, or when you think relevant context might exist from previous sessions. Describe what you're looking for in natural language — be specific about what information you need.",
            parameters: Type.Object({
                query: Type.String(),
            }),
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
                        }],
                    details: {}
                };
            }
        });
    }
});
