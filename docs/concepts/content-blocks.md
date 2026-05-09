# Content Blocks

LLM messages aren't strings anymore. Modern models accept text, images, audio, tool calls, and tool results — often all in the same message. `llm-ports` represents this as a discriminated union of `ContentBlock` types.

```ts
import type { ContentBlock, MessageContent, LLMMessage } from "@llm-ports/core";
```

## The five block types

```ts
type ContentBlock =
  | TextBlock          // { type: "text", text: string }
  | ImageBlock         // { type: "image", source: { kind: "base64"|"url", ... } }
  | AudioBlock         // { type: "audio", source: { kind: "base64", mediaType, data } }
  | ToolUseBlock       // { type: "tool_use", id, name, input }
  | ToolResultBlock;   // { type: "tool_result", toolUseId, content, isError? }
```

## MessageContent: string OR blocks

`MessageContent = string | ContentBlock[]`. A bare string is sugar for `[{ type: "text", text: "..." }]`. Adapters accept either form and normalize internally.

```ts
// These are equivalent:
const a: LLMMessage = { role: "user", content: "hello" };
const b: LLMMessage = { role: "user", content: [{ type: "text", text: "hello" }] };
```

Use a string when content is text-only. Use the array form when you need multimodal content or need to mix text with tool calls.

## Multimodal: images and audio

```ts
// Image (URL): the most common form
const message: LLMMessage = {
  role: "user",
  content: [
    { type: "text", text: "Describe this image:" },
    { type: "image", source: { kind: "url", url: "https://example.com/cat.jpg" } },
  ],
};

// Image (base64): when you have local data
const message2: LLMMessage = {
  role: "user",
  content: [
    { type: "text", text: "What's in this screenshot?" },
    {
      type: "image",
      source: {
        kind: "base64",
        mediaType: "image/png",
        data: base64EncodedImage,
      },
    },
  ],
};

// Audio (base64; URL audio not supported by current providers)
const message3: LLMMessage = {
  role: "user",
  content: [
    { type: "text", text: "Transcribe this audio:" },
    {
      type: "audio",
      source: { kind: "base64", mediaType: "audio/mp3", data: base64EncodedAudio },
    },
  ],
};
```

## Adapter capability differences

Not all adapters support all block types. The adapter throws `ContentBlockUnsupportedError` if you send a block it can't handle.

| Block | Anthropic | OpenAI | Ollama | Vercel |
|-------|-----------|--------|--------|--------|
| `text` | ✓ | ✓ | ✓ | ✓ |
| `image` (base64) | ✓ | ✓ (data URI) | ✓ | partial (via SDK) |
| `image` (URL) | ✓ | ✓ | ✗ (Ollama doesn't fetch URLs) | partial |
| `audio` | ✗ (Anthropic chat doesn't accept audio) | ✓ (wav, mp3 only; ogg ✗) | ✗ | ✗ |
| `tool_use` (assistant) | ✓ | ✓ (as `tool_calls`) | ✓ | partial (single-turn in v0.1) |
| `tool_result` (user→tool message) | ✓ | ✓ (separate `role: tool` message) | ✓ | partial |

See [the adapter feature matrix →](/adapters/) for the full breakdown.

## Tool blocks: where the magic happens

When the model calls a tool, the assistant message contains a `tool_use` block. When you respond with the tool's output, you send a `tool_result` block back. This dance enables agent loops.

```ts
// Step 1: User asks the agent to do something
let conversation: LLMMessage[] = [
  { role: "user", content: "Search the inbox for invoices from Acme" },
];

// Step 2: Agent's response (assistant message) — includes a tool_use block
conversation.push({
  role: "assistant",
  content: [
    { type: "text", text: "Let me search." },
    {
      type: "tool_use",
      id: "toolu_01",
      name: "searchEmails",
      input: { query: "from:acme.com invoice" },
    },
  ],
});

// Step 3: You execute the tool and append the result
conversation.push({
  role: "user",
  content: [
    {
      type: "tool_result",
      toolUseId: "toolu_01",
      content: JSON.stringify({ found: 3, ids: [...] }),
    },
  ],
});

// Step 4: Send the conversation back to the agent for the next turn
const next = await llm.runAgent({ ... });
```

In practice, `runAgent` on the LLM port handles this loop for you in v0.1: declare the tools, the agent calls them, the multi-turn message accumulation happens inside the adapter. A higher-level `createAgent` capability factory (matching the ergonomics of `createClassifier` / `createDrafter`) ships in v0.2 — until then, use `llm.runAgent({ ... })` directly.

## Adapter normalization

Internally, each adapter converts `ContentBlock[]` to its provider's wire format and back. Examples:

- **Anthropic**: `image.source = { kind: "base64", mediaType, data }` → `{ type: "base64", media_type, data }` (note the field rename)
- **OpenAI**: image becomes `{ type: "image_url", image_url: { url: "..." or "data:image/...;base64,..." } }`
- **Ollama**: images get split into a separate `images: [base64, ...]` field; text-only `content: string`
- **Vercel**: passes through (Vercel's content shape is similar to ours)

Tool blocks have similar per-adapter quirks. For example, OpenAI promotes assistant `tool_use` blocks into a separate `tool_calls` field on the message; user `tool_result` blocks become standalone `role: "tool"` messages. Each adapter handles this on the way in and out.

## Helper functions

```ts
import { toBlocks, isStringContent, tryCollapseToText, extractText } from "@llm-ports/core";

// Always get the array form
toBlocks("hello"); // [{ type: "text", text: "hello" }]
toBlocks([{ type: "text", text: "hi" }]); // (passthrough)

// Check the runtime form
isStringContent("hello"); // true
isStringContent([{ type: "text", text: "hello" }]); // false

// Collapse text-only arrays to a string (returns null if non-text blocks present)
tryCollapseToText([{ type: "text", text: "a" }, { type: "text", text: "b" }]); // "ab"
tryCollapseToText([{ type: "text", text: "a" }, { type: "image", ... }]); // null

// Strip non-text content
extractText([{ type: "text", text: "describe " }, { type: "image", ... }, { type: "text", text: "this" }]);
// "describe this"
```

Use these in your own code when interfacing between user-supplied content and adapter calls.

## Reading next

- [`createDrafter` capability →](/capabilities/drafter) — handles thread history with mixed content
- [Tool-use security →](/guides/security) — when blocks carry untrusted data
