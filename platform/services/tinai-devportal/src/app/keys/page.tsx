import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "API Keys",
  description: "Manage your Tinai API keys.",
};

export default function KeysPage() {
  return (
    <div className="max-w-3xl mx-auto px-6 pt-14 pb-20">
      <h1 className="text-4xl font-bold text-white mb-3">API Keys</h1>
      <p className="text-[var(--muted)] text-lg mb-10">
        Create and manage keys to authenticate with the Tinai platform.
      </p>

      {/* Key format explainer */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 mb-8">
        <h2 className="font-semibold text-white mb-3">Key format</h2>
        <div className="font-mono text-sm bg-[#0d0d18] rounded-lg p-4 border border-[var(--border)] mb-4">
          <span className="text-[var(--muted)]">tn_</span>
          <span className="text-yellow-400">prod</span>
          <span className="text-[var(--muted)]">_</span>
          <span className="text-blue-400">agri</span>
          <span className="text-[var(--muted)]">_</span>
          <span className="text-[var(--accent)]">a1b2c3d4e5f6789012345678901234ab</span>
          <div className="mt-3 grid grid-cols-3 gap-3 text-xs text-[var(--muted)]">
            <div><span className="text-yellow-400">env</span> = prod | sandbox</div>
            <div><span className="text-blue-400">type</span> = agri | edu | skill | all</div>
            <div><span className="text-[var(--accent)]">secret</span> = 32 hex chars</div>
          </div>
        </div>
        <p className="text-sm text-[var(--muted)]">
          All keys are exactly 45 characters. Sandbox keys hit simulated data —
          no AgriStack access required, safe for development.
        </p>
      </div>

      {/* Rate limits */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 mb-8">
        <h2 className="font-semibold text-white mb-4">Rate limits</h2>
        <div className="overflow-hidden rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[#0d0d18] border-b border-[var(--border)]">
              <tr>
                <th className="text-left px-4 py-2.5 text-[var(--muted)] font-medium">Plan</th>
                <th className="text-left px-4 py-2.5 text-[var(--muted)] font-medium">Requests / day</th>
                <th className="text-left px-4 py-2.5 text-[var(--muted)] font-medium">Price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {[
                { plan: "Free", rps: "100", price: "₹0" },
                { plan: "Builder", rps: "10,000", price: "₹999/mo" },
                { plan: "Scale", rps: "Unlimited", price: "Contact us" },
              ].map(({ plan, rps, price }) => (
                <tr key={plan}>
                  <td className="px-4 py-2.5 font-medium text-white">{plan}</td>
                  <td className="px-4 py-2.5 text-[var(--muted)]">{rps}</td>
                  <td className="px-4 py-2.5 text-[var(--muted)]">{price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* CTA */}
      <div className="rounded-xl border border-[var(--accent)]/20 bg-[var(--accent)]/5 p-8 text-center">
        <h2 className="text-xl font-semibold text-white mb-2">Ready to get your key?</h2>
        <p className="text-[var(--muted)] text-sm mb-6">
          API key management is handled through Forgejo. Sign in and create a key
          in your account settings.
        </p>
        <a
          href="https://git.tinai.cloud"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-[var(--accent)] text-white font-medium hover:bg-[var(--accent-hover)] transition-colors"
        >
          Sign in to git.tinai.cloud →
        </a>
      </div>
    </div>
  );
}
