---
"@llm-ports/capabilities": patch
---

Docs: surface the implicit task types used by capability factories. Each factory (`createClassifier`, `createScorer`, `createDrafter`, `createSummarizer`, `createExtractor`, `createPlanner`, `createAnalyzer`) defaults to a specific `taskType` (`classify`, `score`, `draft`, ...). If your `.env` only declares a single `LLM_TASK_ROUTE_*` entry and you call a capability without overriding `taskType`, the registry throws `NoProvidersAvailableError`. The getting-started guide now shows the catch-all pattern (`LLM_TASK_ROUTE_GENERAL=fast,smart`), and the task-routing concept page documents per-capability defaults and how to override them. No API change — the `taskType?: string` config option already existed. Closes #6.
