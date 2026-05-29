import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";

export default definePluginEntry({
  id: "dmem",
  name: "dmem (Memory)",
  description: "dmem memory_search replacement",

  register(api) {

    const serviceUrl = api.pluginConfig?.serviceUrl ?? "https://dmem.ai";
    const apiKey: string = (api.pluginConfig?.apiKey as string) ?? "local";
    const reinjectFrequency: number = (api.pluginConfig?.reinjectFrequency as number) ?? 3;

    const LOOKUP_RESULT_INSTRUCTIONS = "The confidence score indicates how strongly the memory system believes this answer -- the information in the field \"answer\" -- is accurate. Use results with confidence above 0.7 as reliable context. For scores between 0.3 and 0.7, surface the information tentatively — e.g. \"I think we discussed this before, but I'm not certain.\" For scores below 0.3, treat the result as speculative or ignore it.";

    const TOOL_INSTRUCTIONS = `IMPORTANT — DO ON EVERY MESSAGE:\nLOOK UP FIRST: Does this reference a person, project, topic, or anything that could be from a past conversation, or is there potentially relevant context from a past conversation? If yes or unsure, call memory_search() BEFORE responding. Ignore sender metadata when formulating memory_search queries.`;

    const PROMOTE_INSTRUCTIONS = ` A promote_to_long_term_memory field is present, suggesting this information may be worth saving to long-term memory. Use your own judgment about whether it actually is.

    Only save it if it's durable — something that will still be true and still matter in days or weeks. Skip transient details (e.g. "the user debugged a file today," "the user is currently running X") even if the field contains them. Note that this information was surfaced because the underlying phrase has been retrieved frequently and recently — that does not mean it is new or currently true, only that it's been coming up.

    If it passes that bar, write it into your MEMORY.md or USER.md file, as appropriate: MEMORY.md for instructions, durable facts, significant events, thoughts, decisions, opinions, lessons learned; USER.md for facts about the user, their preferences, their personality. If the information is already captured in MEMORY.md or USER.md, don't write anything.

    If the information contradicts something already in MEMORY.md or USER.md, do not assume the new information is more current. If it's clearly correct and the old entry is just stale, replace the old entry. If you genuinely can't tell which is true, keep the existing entry, add the new information alongside it marked clearly as an unresolved conflict to raise with the user (e.g. "⚠️ UNRESOLVED: memory says X, recent activity suggests Y — confirm with user"), and keep both until the user resolves it. Raise it with the user next time it's natural to do so.`;

    const DMEM_STATE_FILE = path.join(
        os.tmpdir(),
        "dmem-last-session"
    );

    let turnCount = 0;

    let lastSessionIds: Record<string, string> = {};
    try {
        lastSessionIds = JSON.parse(fs.readFileSync(DMEM_STATE_FILE, "utf-8"));
    } catch {}

    let sessionKey = "unknown";

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

    api.on("after_compaction", async (event, ctx) => {
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";
        const lastSessionId = lastSessionIds[sessionKey];
        if (lastSessionId) {
            triggerFlush(lastSessionId, sessionKey, false);
        }
    });

    api.on("before_prompt_build", async (event, ctx) => {
        const sessionId = (ctx as any)?.sessionId ?? "unknown";
        sessionKey = (ctx as any)?.sessionKey ?? "unknown";

        if (sessionKey.startsWith("slug-generator") || sessionKey.startsWith("unknown")) return {};

        const lastSessionId = lastSessionIds[sessionKey];

        if (lastSessionId && sessionId !== lastSessionId) {
            triggerFlush(lastSessionId, sessionKey, true);
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
        name: "recent_context",
        label: "Recent Context",
        description: "Temporal memory search. Call this if the user asks something like 'what have we been working on' or 'what did we decide about <topic> last week'. Call with latency_matters=true unless explicitly prompted to call with latency_matters=false.",
        parameters: Type.Object({
            time_period_description: Type.String({ description: "Describe the time period the user is looking for. For example, 'last week', 'yesterday', 'the day before yesterday', 'last month', 'in the last week', 'in the last month', 'over the last week, 'over the last month'. Note that 'last week' is not the same as 'in the last week' -- 'last week' means the last calender week, 'in the last week' means over the last 7 days."}),
            topic: Type.Optional(Type.String({ description: "The topic you need context for. Omit if the user doesn't ask about a specific topic. For example, if the user says something like \"what did we decide about Ollama last week?\" set topic=Ollama. If the user asks \"what did we work on last week?\", omit the topic parameter." })),
            latency_matters: Type.Optional(Type.Boolean({ description: "Omit unless prompted to call with latency_matters=False"})),
        }),
        async execute(_id, params: {
            time_period_description: string,
            topic?: string,
            latency_matters?: boolean
        }) {
            const query = new URLSearchParams({
                time_period: params.time_period_description,
                hot_path: String(params.latency_matters ?? true),
            });
            if (params.topic) {
                query.set("topic", params.topic);
            }
            const response = await fetch(`${serviceUrl}/recent_context?${query}`, {
                headers: { "Authorization": apiKey }
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
            query: Type.String({ description: "What to look up in memory. Be specific and use natural language." }),
        }),
        async execute(_id, params: { query: string }) {
            const response = await fetch(`${serviceUrl}/lookup?m=${encodeURIComponent(params.query)}`, {
                headers: {
                    "Authorization": apiKey
                }
            });
            const data = await response.json();
            let text = JSON.stringify(data) + "<instructions>" + LOOKUP_RESULT_INSTRUCTIONS + "</instructions>";
            if (data?.promote_to_long_term_memory) {
                text += "<instructions>" + PROMOTE_INSTRUCTIONS + "</instructions>";
            }
            return {
                content: [{
                    type: "text",
                    text: text
                }],
                details: {}
            };
        }
    });
  }
});
