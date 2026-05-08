/**
 * Document extraction example.
 *
 * Pipeline:
 *   raw OCR'd text  →  LLM extraction with Zod schema  →  typed object
 *
 * What this example demonstrates:
 *
 *   - generateStructured: typed result, schema-validated by Zod
 *   - validation-retry-with-feedback: if the model emits malformed
 *     JSON or violates the schema, the strategy passes the parse
 *     errors back to the model and asks it to correct. The example
 *     surfaces validationAttempts so you see when this fires.
 *   - createExtractor capability factory: schema + field guide bound
 *     once at module scope, called many times. Improving the field
 *     guide improves every extraction call site.
 *   - Cost gating + cost tracking: every call records cost.totalUSD
 *     for downstream observability.
 *
 * What this example does NOT do (in scope for v0.2):
 *
 *   - PDF parsing. Real document pipelines OCR the PDF first (via
 *     Tesseract, Adobe Extract API, AWS Textract, etc.) and feed the
 *     text into this extraction step. This example uses three
 *     pre-OCR'd text snippets to focus on the LLM extraction layer.
 *   - Vision-based extraction. The OpenAI / Anthropic adapters can
 *     accept image ContentBlocks; passing a rendered PDF page as PNG
 *     skips OCR entirely. See the README for the upgrade path.
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @llm-ports/example-extract-from-pdf start
 */

import { z } from "zod";
import { createRegistryFromEnv } from "@llm-ports/core";
import { createAnthropicAdapter } from "@llm-ports/adapter-anthropic";
import { createExtractor, type CapabilityEvent } from "@llm-ports/capabilities";

// ─── Adapter wiring ───────────────────────────────────────────────

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Set ANTHROPIC_API_KEY before running this example.");
  process.exit(1);
}

const registry = createRegistryFromEnv({
  env: {
    LLM_PROVIDER_PRIMARY: "anthropic|claude-haiku-4-5|cost:5/day",
    LLM_TASK_ROUTE_EXTRACT: "primary",
  },
  adapters: { anthropic: createAnthropicAdapter({ apiKey }) },
});

const llm = registry.getPort();

// ─── Zod schema for invoices ──────────────────────────────────────

// The shape your downstream system needs. Strictness here drives the
// validation retry. Fields that are nullable here (notes, taxID) won't
// trigger a retry if absent; required fields will.
const InvoiceSchema = z.object({
  vendor: z.object({
    name: z.string().min(1),
    address: z.string().nullable(),
    taxID: z.string().nullable(),
  }),
  invoiceNumber: z.string().min(1),
  invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD").nullable(),
  lineItems: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.number().positive(),
        unitPriceUSD: z.number().nonnegative(),
        lineTotalUSD: z.number().nonnegative(),
      }),
    )
    .min(1, "At least one line item required"),
  subtotalUSD: z.number().nonnegative(),
  taxUSD: z.number().nonnegative(),
  totalUSD: z.number().positive(),
  notes: z.string().nullable(),
});

type Invoice = z.infer<typeof InvoiceSchema>;

// ─── Capability factory: defined once ─────────────────────────────

const events: Array<CapabilityEvent<Invoice>> = [];

const extractInvoice = createExtractor({
  port: llm,
  schema: InvoiceSchema,
  schemaName: "invoice",
  fieldGuide: `
    vendor.name: the company billing the customer (top of invoice)
    vendor.address: full mailing address; null if not present
    vendor.taxID: VAT/EIN/tax ID number; null if not present
    invoiceNumber: the unique invoice id (often labeled INV-#### or similar)
    invoiceDate: when the invoice was issued, normalize to YYYY-MM-DD
    dueDate: when payment is due, YYYY-MM-DD; null if not stated
    lineItems: every billable row. Each has description, quantity, unit price, line total.
    subtotalUSD: pre-tax total
    taxUSD: tax amount in USD; 0 if not present
    totalUSD: final amount due
    notes: any free-text note (terms, payment instructions, etc.); null if none
  `,
  onResult: (event) => {
    events.push(event);
  },
});

// ─── Three sample inputs (pretend these are OCR output) ───────────

const samples: Array<{ id: string; ocrText: string }> = [
  {
    id: "clean-invoice",
    ocrText: `
      Acme Corporation
      123 Main Street, San Francisco, CA 94102
      Tax ID: 12-3456789

      INVOICE INV-2026-0042
      Date: 2026-04-15
      Due: 2026-05-15

      Description                     Qty   Unit Price   Total
      Professional services Q1         1     $15,000.00   $15,000.00
      Onsite consulting (3 days)       3      $2,500.00    $7,500.00
      Software license renewal         1      $4,800.00    $4,800.00

      Subtotal:                                          $27,300.00
      Tax (8.5%):                                         $2,320.50
      TOTAL DUE:                                         $29,620.50

      Net 30. Payment via wire transfer. ACH details on file.
    `,
  },
  {
    id: "no-due-date",
    ocrText: `
      Quick Print Shop
      456 Oak Avenue
      Los Angeles, CA

      Invoice 1098
      Issued: April 22, 2026

      Item                            Qty   Each       Line Total
      Color brochures, 11x17           500   $0.85      $425.00
      Black & white flyers, letter    1000   $0.12      $120.00

      Subtotal: $545.00
      Tax: $48.78
      Total: $593.78
    `,
  },
  {
    id: "messy-ocr",
    ocrText: `
      [Logo unreadable]
      ConsultCo  LLC
      VAT: GB-123456789

      Inv. # 2026-CC-0317
      Date  17/04/2026
      Pay by  17/05/2026

      Strategy workshop ............ 1 x £4,500.00 ......... £4,500.00
      Followup advisory hours ......... 8 x £300.00 ......... £2,400.00

      Sub-total : £6,900.00
      VAT (20%) : £1,380.00
      DUE       : £8,280.00

      Wire to IBAN GB00 BARC 2031 8200 1234 56
    `,
  },
];

// ─── Run extraction over each sample ──────────────────────────────

console.log("Extracting structured invoices from OCR text...\n");

for (const sample of samples) {
  console.log(`📄 Sample: ${sample.id}`);
  try {
    const invoice = await extractInvoice({ content: sample.ocrText });

    console.log(`   vendor: ${invoice.vendor.name}`);
    console.log(`   invoice: ${invoice.invoiceNumber}, dated ${invoice.invoiceDate}, due ${invoice.dueDate ?? "<not stated>"}`);
    console.log(`   line items: ${invoice.lineItems.length}`);
    for (const li of invoice.lineItems) {
      console.log(`     - ${li.description} (${li.quantity} × $${li.unitPriceUSD.toFixed(2)} = $${li.lineTotalUSD.toFixed(2)})`);
    }
    console.log(`   subtotal: $${invoice.subtotalUSD.toFixed(2)}, tax: $${invoice.taxUSD.toFixed(2)}, total: $${invoice.totalUSD.toFixed(2)}`);

    const lastEvent = events[events.length - 1]!;
    console.log(`   → cost: $${lastEvent.cost.totalUSD.toFixed(6)}, latency: ${lastEvent.latencyMs}ms, validation attempts: ${lastEvent.validationAttempts ?? 1}`);
  } catch (err) {
    // After validation-retry exhausts, you get a typed ValidationError.
    // In production you'd land this in a "needs human review" queue.
    console.log(`   ✗ extraction failed: ${(err as Error).message}`);
    console.log(`     (in production this would land in the human-review queue)`);
  }
  console.log();
}

// ─── Summary ──────────────────────────────────────────────────────

const totalCost = events.reduce((s, e) => s + e.cost.totalUSD, 0);
const retried = events.filter((e) => (e.validationAttempts ?? 1) > 1).length;

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log(`Extracted ${events.length} of ${samples.length} invoices`);
console.log(`Total cost: $${totalCost.toFixed(6)}`);
console.log(`Validation retries: ${retried} of ${events.length} extractions needed a 2nd attempt`);
console.log(`Avg latency: ${Math.round(events.reduce((s, e) => s + e.latencyMs, 0) / Math.max(events.length, 1))}ms`);
