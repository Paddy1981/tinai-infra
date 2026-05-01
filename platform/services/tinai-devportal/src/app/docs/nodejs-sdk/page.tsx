import type { Metadata } from "next";
import { CodeBlock } from "../../components/CodeBlock";

export const metadata: Metadata = {
  title: "Node.js SDK",
  description: "Tinai Node.js / TypeScript SDK — install, authenticate, and call all Phase 1 APIs.",
};

const INSTALL = `npm install tinai-sdk
# or
yarn add tinai-sdk
# or
pnpm add tinai-sdk`;

const BASIC = `
import { Client } from "tinai-sdk";

const client = new Client({ apiKey: "tn_prod_agri_32hexchars00000000000000000000" });

// Mandi prices
const result = await client.agri.mandiPrices(18.52, 73.85, "tomato");
console.log(result.bestPricePerQuintal);   // 3200
console.log(result.bestMandi?.mandiName);  // "Nashik APMC"
console.log(result.cacheHit);             // true

// Scheme eligibility
const schemes = await client.agri.schemeEligibility("maharashtra", 2.5, ["wheat"]);
for (const s of schemes.eligibleSchemes) {
  console.log(s.schemeName, s.benefitAmountInr);
}

// Unified advisory (SDK polls automatically)
const advisory = await client.agri.advisory({
  lat: 18.52, lng: 73.85, crops: ["tomato"], state: "maharashtra", language: "hi",
});
console.log(advisory.summary);
console.log(advisory.mandiBestPrice);
`;

const BHASHINI = `
import { BhashiniClient } from "tinai-sdk";

// Translate
const result = await client.bhashini.translate("Good morning", "en", "hi");
console.log(result.first);         // "सुप्रभात"
console.log(result.latencyMs);

// Language name helper (static)
console.log(BhashiniClient.languageName("hi"));   // "Hindi"
console.log(BhashiniClient.languageName("ta"));   // "Tamil"

// Synthesize speech
const audio = await client.bhashini.synthesize("नमस्ते", "hi", "female");
const buffer = audio.audioBuffer();   // Buffer
await fs.writeFile("/tmp/greeting.wav", buffer);
`;

const ERRORS = `
import { AuthError, RateLimitError, ValidationError, AdvisoryTimeoutError } from "tinai-sdk";

try {
  const result = await client.agri.mandiPrices(18.52, 73.85, "tomato");
} catch (err) {
  if (err instanceof AuthError) {
    console.error("Invalid key:", err.statusCode);
  } else if (err instanceof RateLimitError) {
    console.error("Rate limit. Resets at:", err.resetAt);
  } else if (err instanceof ValidationError) {
    console.error("Bad input:", err.message);
  } else if (err instanceof AdvisoryTimeoutError) {
    console.error("Advisory timed out");
  }
}
`;

const TYPES = `
import type {
  MandiPrice,
  MandiPricesResult,
  SchemeEligibilityResult,
  AdvisoryResult,
  TranslateResult,
  CertificateVerification,
} from "tinai-sdk";

// All response objects are plain interfaces (no class instances)
// — tree-shake friendly, zero runtime overhead
function displayMandi(r: MandiPricesResult) {
  const best: MandiPrice | null = r.bestMandi;
  return best ? \`₹\${best.modalPricePerQuintal} at \${best.mandiName}\` : "No data";
}
`;

export default function NodeSdkPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-14 pb-20">
      <div className="mb-2 text-xs text-[var(--muted)]">
        <a href="/docs" className="hover:text-white transition-colors">Docs</a>
        <span className="mx-2">/</span>
        Node.js SDK
      </div>
      <h1 className="text-4xl font-bold text-white mb-3">Node.js SDK</h1>
      <p className="text-[var(--muted)] text-lg mb-10">
        TypeScript native. ESM + CJS dual output. Zero runtime dependencies —
        uses Node.js built-in <code className="text-[var(--accent)]">https</code> only.
      </p>

      <Section title="Installation">
        <CodeBlock code={INSTALL} lang="bash" />
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          {[
            { k: "Node.js", v: "≥ 18" },
            { k: "Formats", v: "ESM + CJS" },
            { k: "Types", v: "Bundled .d.ts" },
          ].map(({ k, v }) => (
            <div key={k} className="rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2">
              <div className="text-[var(--muted)] text-xs">{k}</div>
              <div className="text-white font-medium">{v}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Agri API">
        <CodeBlock code={BASIC} lang="typescript" filename="agri.ts" />
      </Section>

      <Section title="Bhashini API">
        <CodeBlock code={BHASHINI} lang="typescript" filename="bhashini.ts" />
      </Section>

      <Section title="Error handling">
        <CodeBlock code={ERRORS} lang="typescript" filename="errors.ts" />
      </Section>

      <Section title="TypeScript types">
        <CodeBlock code={TYPES} lang="typescript" filename="types.ts" />
        <p className="mt-3 text-sm text-[var(--muted)]">
          All response types are plain interfaces — no class instances — making
          them fully tree-shakeable and zero-overhead at runtime.
        </p>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="text-xl font-semibold text-white mb-4 pb-2 border-b border-[var(--border)]">
        {title}
      </h2>
      {children}
    </section>
  );
}
