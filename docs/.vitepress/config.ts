import { defineConfig } from "vitepress";

export default defineConfig({
  // Project Pages deploys at https://<user>.github.io/<repo>/, so all
  // assets and links must be prefixed with `/llm-ports/`. Override via
  // the VITEPRESS_BASE env var when deploying elsewhere (custom domain,
  // preview build, or local dev with `pnpm docs:dev`).
  base: process.env["VITEPRESS_BASE"] ?? "/llm-ports/",
  title: "llm-ports",
  description:
    "Provider-agnostic LLM architecture for TypeScript: cost gating, fallback chains, capability factories, tool-use security primitives.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,

  head: [
    ["meta", { name: "theme-color", content: "#3c8772" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "llm-ports" }],
    [
      "meta",
      {
        property: "og:description",
        content:
          "Provider-agnostic LLM architecture for TypeScript. Cost gating, fallback chains, capability factories.",
      },
    ],
  ],

  themeConfig: {
    siteTitle: "llm-ports",
    nav: [
      { text: "Guide", link: "/getting-started" },
      { text: "Capabilities", link: "/capabilities/" },
      { text: "Adapters", link: "/adapters/" },
      { text: "Migration", link: "/migration/from-vercel-ai" },
      {
        text: "v0.1",
        items: [
          { text: "v0.1 status (what's stable, what's not)", link: "/v0-1-status" },
          { text: "Changelog", link: "https://github.com/baabakk/llm-ports/blob/main/CHANGELOG.md" },
        ],
      },
    ],

    sidebar: {
      "/": [
        {
          text: "Introduction",
          items: [
            { text: "What is llm-ports?", link: "/" },
            { text: "Getting Started", link: "/getting-started" },
            { text: "Why this exists", link: "/why" },
            { text: "v0.1 status", link: "/v0-1-status" },
          ],
        },
        {
          text: "Concepts",
          collapsed: false,
          items: [
            { text: "Ports and Adapters", link: "/concepts/ports-and-adapters" },
            { text: "Task Routing", link: "/concepts/task-routing" },
            { text: "Cost vs Request Gating", link: "/concepts/cost-vs-request-gating" },
            { text: "Content Blocks", link: "/concepts/content-blocks" },
            { text: "Cache Control", link: "/concepts/cache" },
            { text: "Validation Strategies", link: "/concepts/validation-strategies" },
            { text: "Observability Hooks", link: "/concepts/observability" },
            { text: "Capability Detection", link: "/concepts/capability-detection" },
          ],
        },
        {
          text: "Guides",
          collapsed: false,
          items: [
            { text: "Multi-Provider Routing", link: "/guides/multi-provider" },
            { text: "Local-to-Cloud Flip", link: "/guides/local-to-cloud" },
            { text: "Cost Gating in Production", link: "/guides/cost-gating" },
            { text: "Cancellation with AbortSignal", link: "/guides/cancellation" },
            { text: "Runtime Model Discovery", link: "/guides/model-discovery" },
            { text: "Reasoning Effort", link: "/guides/reasoning-effort" },
            { text: "Tool-Use Security", link: "/guides/security" },
            { text: "Custom Adapters", link: "/guides/custom-adapters" },
          ],
        },
        {
          text: "Capabilities",
          collapsed: false,
          items: [
            { text: "Overview", link: "/capabilities/" },
            { text: "createClassifier", link: "/capabilities/classifier" },
            { text: "createScorer", link: "/capabilities/scorer" },
            { text: "createExtractor", link: "/capabilities/extractor" },
            { text: "createSummarizer", link: "/capabilities/summarizer" },
            { text: "createDrafter", link: "/capabilities/drafter" },
            { text: "createPlanner", link: "/capabilities/planner" },
            { text: "createAnalyzer", link: "/capabilities/analyzer" },
          ],
        },
        {
          text: "Adapters",
          collapsed: false,
          items: [
            { text: "Overview + Feature Matrix", link: "/adapters/" },
            { text: "Anthropic", link: "/adapters/anthropic" },
            { text: "OpenAI (+12 compat providers)", link: "/adapters/openai" },
            { text: "Google Gemini", link: "/adapters/google" },
            { text: "Ollama (local)", link: "/adapters/ollama" },
            { text: "Vercel AI SDK", link: "/adapters/vercel" },
          ],
        },
        {
          text: "Migration",
          collapsed: true,
          items: [
            { text: "From Vercel AI SDK", link: "/migration/from-vercel-ai" },
            { text: "From direct SDKs", link: "/migration/from-direct-sdk" },
            { text: "From LangChain.js (planned)", link: "/migration/from-langchain" },
            { text: "alpha.18 → alpha.19 (BREAKING)", link: "/migration/alpha-18-to-alpha-19" },
            { text: "alpha.19 → alpha.20 (TS-level)", link: "/migration/alpha-19-to-alpha-20" },
            { text: "alpha.20 → alpha.21 (additive)", link: "/migration/alpha-20-to-alpha-21" },
            { text: "alpha.21 → alpha.22 (additive)", link: "/migration/alpha-21-to-alpha-22" },
            { text: "alpha.22 → alpha.23 (additive)", link: "/migration/alpha-22-to-alpha-23" },
            { text: "alpha.23 → alpha.24 (additive)", link: "/migration/alpha-23-to-alpha-24" },
            { text: "alpha.24 → alpha.25 (additive)", link: "/migration/alpha-24-to-alpha-25" },
          ],
        },
        {
          text: "Examples",
          collapsed: false,
          items: [
            { text: "Overview", link: "/examples" },
            { text: "basic", link: "https://github.com/baabakk/llm-ports/tree/main/examples/basic" },
            { text: "multi-provider", link: "https://github.com/baabakk/llm-ports/tree/main/examples/multi-provider" },
            { text: "streaming-chat", link: "https://github.com/baabakk/llm-ports/tree/main/examples/streaming-chat" },
            { text: "email-triage", link: "https://github.com/baabakk/llm-ports/tree/main/examples/email-triage" },
            { text: "extract-from-pdf", link: "https://github.com/baabakk/llm-ports/tree/main/examples/extract-from-pdf" },
            { text: "agent-with-approval", link: "https://github.com/baabakk/llm-ports/tree/main/examples/agent-with-approval" },
            { text: "migrate-from-vercel-ai", link: "https://github.com/baabakk/llm-ports/tree/main/examples/migrate-from-vercel-ai" },
            { text: "with-onretry", link: "https://github.com/baabakk/llm-ports/tree/main/examples/with-onretry" },
            { text: "local-with-ollama", link: "https://github.com/baabakk/llm-ports/tree/main/examples/local-with-ollama" },
            { text: "live-integration-tests", link: "https://github.com/baabakk/llm-ports/tree/main/examples/live-integration-tests" },
          ],
        },
      ],
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/baabakk/llm-ports" },
      { icon: "npm", link: "https://www.npmjs.com/org/llm-ports" },
    ],

    footer: {
      message: "MIT License",
      copyright: "Copyright © 2026 Babak Abbaschian and contributors",
    },

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/baabakk/llm-ports/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
  },
});
