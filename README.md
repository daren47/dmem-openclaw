# dmem OpenClaw Plugin

dmem adds long-term memory lookup to OpenClaw sessions. It captures useful conversation context, refreshes session summaries, and exposes memory tools that agents can call before answering.

## Install

Install the plugin from your preferred OpenClaw plugin source, then configure dmem:

```bash
openclaw plugins config dmem set serviceUrl https://dmem.ai
openclaw plugins config dmem set apiKey DMEM_API_KEY
openclaw gateway restart
```

`serviceUrl` defaults to `https://dmem.ai`. `apiKey` defaults to `local` for local development.

## Tools

### `memory_search`

Searches remembered context from previous sessions. Use it when the user mentions a person, project, topic, decision, or thread that may have appeared before.

| Parameter | Type | Description |
| --- | --- | --- |
| `query` | string | Natural-language description of the memory to retrieve. |

### `recent_context`

Returns a summary of recent work, useful when the user asks what has been happening or what the agent has been working on.

| Parameter | Type | Description |
| --- | --- | --- |
| `latency_matters` | boolean | Use `true` for the fast path unless the user asks for deeper recall. |

## Use with TweetClaw

dmem is useful beside source and action plugins because it keeps durable conclusions separate from the tool that collected them. For X/Twitter automation, install [TweetClaw](https://github.com/Xquik-dev/tweetclaw):

```bash
openclaw plugins install @xquik/tweetclaw
```

TweetClaw can scrape tweets, search tweets, search tweet replies, post tweets, post tweet replies, export followers, perform user lookup, handle media upload and media download, send direct messages, monitor tweets, deliver webhooks, and run giveaway draws. dmem can then remember concise research notes, selected tweet URLs, monitor decisions, giveaway criteria, campaign context, and review outcomes for later sessions.

Keep raw credential material and large exports out of memory. Store only the minimum context needed to explain later decisions, and review any TweetClaw visible action before posting or replying.
