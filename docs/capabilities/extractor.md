# `createExtractor`

Pull structured fields from unstructured input. Returns Zod-validated typed data. Default temperature 0 (deterministic — extraction should be reproducible).

## Signature

```ts
function createExtractor<TSchema extends z.ZodTypeAny>(config: {
  port: LLMPort;
  schema: TSchema;
  schemaName: string;
  fieldGuide?: Resolvable<ExtractInput, string>;
  examples?: Resolvable<ExtractInput, string>;
  systemContext?: Resolvable<ExtractInput, string>;
  taskType?: string;          // default "extract"
  priority?: LLMPriority;
  temperature?: number;       // default 0
  maxOutputTokens?: number;
  onBeforeCall?: (input: ExtractInput) => void | Promise<void>;
  onResult?: (event: CapabilityEvent<z.infer<TSchema>>) => void | Promise<void>;
  onError?: (error: Error, input: ExtractInput) => void | Promise<void>;
}): (input: ExtractInput) => Promise<z.infer<TSchema>>;
```

## Example: contact extraction

```ts
import { createExtractor } from "@llm-ports/capabilities";
import { z } from "zod";

const ContactSchema = z.object({
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
});

export const extractContact = createExtractor({
  port: llm,
  schema: ContactSchema,
  schemaName: "contact",
  fieldGuide: `
    name: full name as written
    email: email address; null if not present
    phone: phone number; null if not present
    company: organization affiliation; null if unclear
    title: job title; null if not stated
  `,
});

const result = await extractContact({
  content: "Hi, I'm Alice from Acme Corp. You can reach me at alice@acme.com or 555-0100.",
});
// { name: "Alice", email: "alice@acme.com", phone: "555-0100", company: "Acme Corp", title: null }
```

## With examples (reduces field-name hallucination)

```ts
export const extractInvoice = createExtractor({
  port: llm,
  schema: InvoiceSchema,
  schemaName: "invoice",
  fieldGuide: `
    invoiceNumber: the document's identifier
    issueDate: when the invoice was issued (ISO 8601)
    dueDate: when payment is due
    amountUSD: total in USD; convert if needed
    lineItems: array of { description, quantity, unitPrice, total }
  `,
  examples: `
    Input: "Invoice #INV-2024-001, issued 2024-03-15, due 2024-04-14. Total: $1,500."
    Output: { invoiceNumber: "INV-2024-001", issueDate: "2024-03-15", dueDate: "2024-04-14", amountUSD: 1500, lineItems: [] }
  `,
});
```

## Anti-hallucination guardrails

The extractor's default system prompt includes:

> Do not infer fields that aren't in the input. Use null/empty for missing data rather than guessing.

This pairs with `.nullable()` on optional schema fields. The model is more likely to honestly emit null than to fabricate when the schema permits it.

## Reading next

- [`createClassifier`](/capabilities/classifier) — single category, not multiple fields
- [`createAnalyzer`](/capabilities/analyzer) — when you want analysis, not extraction
- [Validation strategies](/concepts/validation-strategies)
