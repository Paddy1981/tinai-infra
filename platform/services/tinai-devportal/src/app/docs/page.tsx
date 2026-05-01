import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Docs",
  description: "Tinai API documentation — SDKs, API reference, and guides.",
};

const SECTIONS = [
  {
    title: "SDKs",
    items: [
      { href: "/docs/python-sdk", title: "Python SDK", desc: "pip install tinai-sdk · Python ≥ 3.10 · zero runtime deps" },
      { href: "/docs/nodejs-sdk", title: "Node.js SDK", desc: "npm install tinai-sdk · ESM + CJS · TypeScript native" },
    ],
  },
  {
    title: "API Reference",
    items: [
      { href: "/docs/api-reference#agri", title: "Agri API", desc: "Mandi prices, weather, schemes, diagnosis, advisory" },
      { href: "/docs/api-reference#bhashini", title: "Bhashini API", desc: "Translate, transcribe, synthesize across 22 languages" },
      { href: "/docs/api-reference#edu", title: "Edu API", desc: "Adaptive questions, mock tests, AI tutor" },
      { href: "/docs/api-reference#skill", title: "Skill API", desc: "PMKVY courses, enrollment, certificate verification" },
    ],
  },
  {
    title: "Guides",
    items: [
      { href: "/docs/authentication", title: "Authentication", desc: "API key format, rate limits, and error handling" },
      { href: "/docs/languages", title: "Indian language support", desc: "Using Accept-Language with all 22 scheduled languages" },
      { href: "/docs/errors", title: "Error reference", desc: "HTTP status codes, error bodies, and retry strategies" },
    ],
  },
];

export default function DocsIndexPage() {
  return (
    <div className="max-w-4xl mx-auto px-6 pt-14 pb-20">
      <h1 className="text-4xl font-bold text-white mb-3">Documentation</h1>
      <p className="text-[var(--muted)] text-lg mb-12">
        Everything you need to build with the Tinai platform.
      </p>

      <div className="space-y-12">
        {SECTIONS.map((section) => (
          <div key={section.title}>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--muted)] mb-4">
              {section.title}
            </h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex flex-col gap-1 rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 hover:border-[var(--accent)]/40 transition-colors"
                >
                  <span className="font-medium text-white group-hover:text-[var(--accent-hover)] transition-colors">
                    {item.title}
                  </span>
                  <span className="text-sm text-[var(--muted)]">{item.desc}</span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
