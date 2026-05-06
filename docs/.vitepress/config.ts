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
          { text: "Changelog", link: "https://github.com/baabakk/llm-ports/blob/main/CHANGELOG.md" },
          { text: "Implementation plan", link: "https://github.com/baabakk/llm-ports/blob/main/PLAN.md" },
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
            { text: "Validation Strategies", link: "/concepts/validation-strategies" },
          ],
        },
        {
          text: "Guides",
          collapsed: false,
          items: [
            { text: "Multi-Provider Routing", link: "/guides/multi-provider" },
            { text: "Local-to-Cloud Flip", link: "/guides/local-to-cloud" },
            { text: "Cost Gating in Production", link: "/guides/cost-gating" },
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
            { text: "OpenAI (+10 compat providers)", link: "/adapters/openai" },
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
