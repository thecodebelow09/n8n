# Custom adaptive builder memory

This fork changes only the prompt copy sent to the model. Stored messages and full
tool outputs remain intact in n8n's persistence layer.

## Added behavior

- Counts the builder system prompt, observation memory, tool definitions, and messages
  against one configurable input ceiling before every model call, including resumed runs.
- Replaces oversized tool outputs in the prompt copy with head/tail previews.
- Selects newest complete user turns instead of injecting the full thread.
- Selects observations by marker priority and recency, then renders them chronologically.
- Renders only the newest active `BUILDER STATE:` record while the reflector catches up.
- Directs observational memory to maintain a compact `BUILDER STATE:` record.

## Environment variables

See `builder-memory.env.example` in the external setup kit. Defaults in source target a
Gemma 4 26B deployment configured for a 32,768-token Ollama context:

- `N8N_AI_BUILDER_MAX_INPUT_TOKENS=28672`
- `N8N_AI_BUILDER_TOOL_RESULT_TOKENS=2048`
- `N8N_AI_BUILDER_MIN_RECENT_TURNS=2`
- `N8N_AI_BUILDER_OBSERVER_TOKENS=6000`
- `N8N_AI_BUILDER_REFLECTOR_TOKENS=6500`
- `N8N_AI_BUILDER_MEMORY_RENDER_TOKENS=7000`
- `N8N_AI_BUILDER_MAX_ITERATIONS=30`

The token estimator is intentionally approximate (`characters / 4`). The context manager
stops with a clear error when fixed system/tool overhead leaves too little room for the
minimum recent turns. Validate with real builder traces and provider-reported input usage before increasing
`N8N_AI_BUILDER_MAX_INPUT_TOKENS`.
