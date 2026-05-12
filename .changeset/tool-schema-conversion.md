---
"@llm-ports/adapter-anthropic": patch
"@llm-ports/adapter-openai": patch
---

Convert `ToolDefinition.inputSchema` (Zod) to real JSON Schema before sending to the provider. Both adapters previously passed `{ type: "object", properties: {} }` to the model, which meant the model had no idea what arguments a tool actually took — tool use was effectively broken when the agent had to infer field names. Adapters now wire `zod-to-json-schema` (`target: "openAi"` for the OpenAI adapter, default standard JSON Schema for Anthropic) with `$refStrategy: "none"` to inline references. Non-Zod inputs still fall back to the safe `{}` shape. Closes #1.
