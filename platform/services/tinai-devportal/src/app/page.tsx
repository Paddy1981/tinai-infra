import Link from "next/link";
import { CodeBlock } from "./components/CodeBlock";

// Hoisted static data — avoids re-creation on each render (server-hoist-static-io)
const APIS = [
  {
    id: "agri",
    icon: "🌾",
    name: "Agri API",
    desc: "Real-time mandi prices, hyperlocal weather, PMFBY eligibility, AI crop diagnosis, and unified advisory in one endpoint.",
    badge: "Live",
    badgeColor: "bg-green-500/10 text-green-400",
    href: "/docs/api-reference#agri",
  },
  {
    id: "bhashini",
    icon: "🗣",
    name: "Bhashini API",
    desc: "Translate, transcribe, and synthesize speech across all 22 scheduled Indian languages using the government BHASHINI stack.",
    badge: "Live",
    badgeColor: "bg-green-500/10 text-green-400",
    href: "/docs/api-reference#bhashini",
  },
  {
    id: "edu",
    icon: "📚",
    name: "Edu API",
    desc: "Adaptive questioning with IRT, spaced repetition, mock test lifecycle, and AI tutoring via @tutor-bot.",
    badge: "Live",
    badgeColor: "bg-green-500/10 text-green-400",
    href: "/docs/api-reference#edu",
  },
  {
    id: "skill",
    icon: "🎓",
    name: "Skill API",
    desc: "PMKVY course catalog, enrollment, module progress tracking, and tamper-evident certificate issuance and verification.",
    badge: "Live",
    badgeColor: "bg-green-500/10 text-green-400",
    href: "/docs/api-reference#skill",
  },
];

const QUICKSTART_PYTHON = `
from tinai import Client

client = Client(api_key="tn_prod_agri_...")

# Mandi prices near Pune for tomatoes
result = client.agri.mandi_prices(lat=18.52, lng=73.85, crop="tomato")
print(f"Best price: ₹{result.best_price_per_quintal}/quintal at {result.best_mandi.mandi_name}")

# Translate to Hindi
translated = client.bhashini.translate("Sell now — prices peak in 3 days", "en", "hi")
print(translated.first)
`;

const QUICKSTART_NODE = `
import { Client } from "tinai-sdk";

const client = new Client({ apiKey: "tn_prod_agri_..." });

// Mandi prices near Pune for tomatoes
const result = await client.agri.mandiPrices(18.52, 73.85, "tomato");
console.log(\`Best: ₹\${result.bestPricePerQuintal}/quintal at \${result.bestMandi?.mandiName}\`);

// Translate to Hindi
const translated = await client.bhashini.translate("Sell now", "en", "hi");
console.log(translated.first);
`;

export default function HomePage() {
  return (
    <div className="max-w-6xl mx-auto px-6">
      {/* Hero */}
      <section className="pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/5 text-[var(--accent)] text-xs mb-6">
          <span className="w-1.5 h-1.5 rounded-full bg-[var(--green)] animate-pulse" />
          All Phase 1 APIs live · Python &amp; Node.js SDKs available
        </div>

        <h1 className="text-5xl sm:text-6xl font-bold text-white tracking-tight mb-6">
          Build for{" "}
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-[var(--accent)] to-purple-400">
            Bharat
          </span>
        </h1>

        <p className="text-xl text-[var(--muted)] max-w-2xl mx-auto mb-10">
          Sovereign AI APIs for agriculture, education, language, and skills —
          designed for India's 1.4 billion people. Zero external dependencies.
          22 Indian languages.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/docs/python-sdk"
            className="px-6 py-3 rounded-lg bg-[var(--accent)] text-white font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            Get started →
          </Link>
          <Link
            href="/explorer"
            className="px-6 py-3 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-white/30 transition-colors"
          >
            Explore API
          </Link>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-20">
        {[
          { n: "22", label: "Indian languages" },
          { n: "4", label: "API verticals" },
          { n: "0", label: "Runtime deps (SDKs)" },
          { n: "100%", label: "Sovereign infrastructure" },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 text-center"
          >
            <div className="text-3xl font-bold text-white">{s.n}</div>
            <div className="text-sm text-[var(--muted)] mt-1">{s.label}</div>
          </div>
        ))}
      </section>

      {/* APIs */}
      <section className="mb-20">
        <h2 className="text-2xl font-bold text-white mb-2">APIs</h2>
        <p className="text-[var(--muted)] mb-8">
          One API key, four verticals, all of India.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {APIS.map((api) => (
            <Link
              key={api.id}
              href={api.href}
              className="group rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 hover:border-[var(--accent)]/40 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{api.icon}</span>
                  <span className="font-semibold text-white">{api.name}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${api.badgeColor}`}>
                  {api.badge}
                </span>
              </div>
              <p className="text-sm text-[var(--muted)] leading-relaxed">{api.desc}</p>
              <div className="mt-4 text-xs text-[var(--accent)] group-hover:text-[var(--accent-hover)] transition-colors">
                View docs →
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Quick-start */}
      <section className="mb-20">
        <h2 className="text-2xl font-bold text-white mb-2">Quick start</h2>
        <p className="text-[var(--muted)] mb-8">
          Up and running in 60 seconds.
        </p>

        <div className="space-y-6">
          <div>
            <div className="text-sm text-[var(--muted)] mb-2">
              <code className="text-[var(--accent)]">pip install tinai-sdk</code>
              {" "}· Python ≥ 3.10 · zero deps
            </div>
            <CodeBlock code={QUICKSTART_PYTHON} lang="python" filename="quickstart.py" />
          </div>

          <div>
            <div className="text-sm text-[var(--muted)] mb-2">
              <code className="text-[var(--accent)]">npm install tinai-sdk</code>
              {" "}· Node ≥ 18 · ESM + CJS · zero deps
            </div>
            <CodeBlock code={QUICKSTART_NODE} lang="typescript" filename="quickstart.ts" />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mb-20 rounded-2xl border border-[var(--accent)]/20 bg-gradient-to-br from-[var(--accent)]/5 to-purple-900/10 p-12 text-center">
        <h2 className="text-3xl font-bold text-white mb-4">Ready to build?</h2>
        <p className="text-[var(--muted)] mb-8 max-w-lg mx-auto">
          Get your API key and start making calls in minutes.
          Free tier: 100 req/day across all APIs.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link
            href="/keys"
            className="px-6 py-3 rounded-lg bg-[var(--accent)] text-white font-medium hover:bg-[var(--accent-hover)] transition-colors"
          >
            Get API key
          </Link>
          <Link
            href="/docs"
            className="px-6 py-3 rounded-lg border border-[var(--border)] text-[var(--muted)] hover:text-white hover:border-white/30 transition-colors"
          >
            Read the docs
          </Link>
        </div>
      </section>
    </div>
  );
}
