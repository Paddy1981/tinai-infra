'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { forgeApi, ForgeProduct, ForgeSummary } from '@/lib/forge-api';

const STATUS_COLORS: Record<string, string> = {
  up_to_date: 'bg-green-100 text-green-800',
  update_available: 'bg-yellow-100 text-yellow-800',
  building: 'bg-blue-100 text-blue-800',
  rolling_out: 'bg-purple-100 text-purple-800',
  failed: 'bg-red-100 text-red-800',
};

const TINAI_NAMES: Record<string, string> = {
  forgejo: 'TinAI Repos',
  woodpecker: 'TinAI Pipelines',
  grafana: 'TinAI Insights',
  prometheus: 'TinAI Metrics',
  loki: 'TinAI Logs',
  minio: 'TinAI Storage',
  cloudnativepg: 'TinAI Database',
  'cert-manager': 'TinAI Certs',
  keda: 'TinAI Scale',
  knative: 'TinAI Functions',
  'ingress-nginx': 'TinAI Gateway',
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

export default function ForgeDashboard() {
  const [products, setProducts] = useState<ForgeProduct[]>([]);
  const [summary, setSummary] = useState<ForgeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forgeDeployed, setForgeDeployed] = useState(true);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000); // Auto-refresh every 30 seconds
    return () => clearInterval(interval);
  }, []);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const summaryData = await forgeApi.getSummary();
      setSummary(summaryData);

      if (summaryData.forge_status === 'not_deployed') {
        setForgeDeployed(false);
        setProducts([]);
      } else {
        setForgeDeployed(true);
        const productsData = await forgeApi.getProducts();
        setProducts(productsData);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
      setForgeDeployed(false);
    } finally {
      setLoading(false);
    }
  }

  async function triggerBuild(productId: string) {
    try {
      await forgeApi.buildProduct(productId);
      await fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger build');
    }
  }

  const stats = summary || {
    total_products: 0,
    up_to_date: 0,
    updates_available: 0,
    builds_in_progress: 0,
    rollouts_in_progress: 0,
    last_check: '',
  };

  if (!forgeDeployed) {
    return (
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-[#0F172A] text-white px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-[#06B6D4]">TinAI Forge</h1>
              <p className="text-gray-400 text-sm">Automated White-Label Pipeline</p>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-yellow-900 text-yellow-300">
              Forge Engine: Not Deployed
            </span>
          </div>
        </div>

        {/* Not Deployed Notice */}
        <div className="px-6 py-6">
          <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-6 max-w-2xl">
            <div className="flex items-start gap-3">
              <span className="text-yellow-600 text-2xl">⚠</span>
              <div>
                <h3 className="font-semibold text-yellow-800 text-lg">Forge Engine Not Deployed</h3>
                <p className="text-yellow-700 text-sm mt-2">
                  The TinAI Forge service is not yet running in the cluster. Deploy it to enable automated version watching, building, and tenant rollouts.
                </p>
                <Link
                  href="/admin/forge/setup"
                  className="inline-block mt-4 bg-yellow-600 text-white px-4 py-2 rounded text-sm hover:bg-yellow-700 transition-colors"
                >
                  View Setup Instructions →
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#0F172A] text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#06B6D4]">TinAI Forge</h1>
            <p className="text-gray-400 text-sm">Automated White-Label Pipeline</p>
          </div>
          <div className="flex items-center gap-4">
            <span className="px-3 py-1 rounded-full text-xs font-medium bg-green-900 text-green-300">
              Forge Engine: Online
            </span>
            <button
              onClick={fetchData}
              disabled={loading}
              className="bg-[#06B6D4] text-white px-4 py-2 rounded text-sm hover:bg-[#0891B2] disabled:opacity-50 transition-colors"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-6 mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
          <div className="flex items-start gap-3">
            <span className="text-red-600 text-xl">✕</span>
            <div>
              <h3 className="font-semibold text-red-800">Error</h3>
              <p className="text-red-700 text-sm mt-1">{error}</p>
              <button
                onClick={fetchData}
                className="inline-block mt-2 text-sm text-red-800 underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stats bar */}
      {!loading && (
        <div className="bg-white border-b px-6 py-4">
          <div className="flex gap-8">
            <div className="text-center">
              <div className="text-3xl font-bold text-[#0F172A]">{stats.total_products}</div>
              <div className="text-xs text-gray-500 uppercase">Products Tracked</div>
            </div>
            <div className="text-center">
              <div
                className={`text-3xl font-bold ${stats.updates_available > 0 ? 'text-yellow-600' : 'text-green-600'}`}
              >
                {stats.updates_available}
              </div>
              <div className="text-xs text-gray-500 uppercase">Updates Available</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-blue-600">{stats.builds_in_progress}</div>
              <div className="text-xs text-gray-500 uppercase">Builds In Progress</div>
            </div>
            <div className="text-center">
              <div className="text-3xl font-bold text-purple-600">{stats.rollouts_in_progress}</div>
              <div className="text-xs text-gray-500 uppercase">Active Rollouts</div>
            </div>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="px-6 py-6">
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="h-96 bg-gray-100 animate-pulse flex items-center justify-center">
              <div className="text-gray-500">Loading products...</div>
            </div>
          </div>
        </div>
      )}

      {/* Version Matrix */}
      {!loading && (
        <div className="px-6 py-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Product Version Matrix</h2>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#0F172A] text-white">
                <tr>
                  <th className="px-4 py-3 text-left">TinAI Product</th>
                  <th className="px-4 py-3 text-left">Current Version</th>
                  <th className="px-4 py-3 text-left">Latest Version</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Last Checked</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {products.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      No products found
                    </td>
                  </tr>
                ) : (
                  products.map((product) => (
                    <tr key={product.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-[#0F172A]">
                        {TINAI_NAMES[product.id] || product.name}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs bg-gray-50 rounded">{product.current_version}</td>
                      <td className="px-4 py-3 font-mono text-xs">
                        {product.latest_version !== product.current_version ? (
                          <span className="text-yellow-700 font-semibold">{product.latest_version} ↑</span>
                        ) : (
                          <span className="text-green-700">{product.latest_version}</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-medium ${
                            STATUS_COLORS[product.status] || 'bg-gray-100 text-gray-700'
                          }`}
                        >
                          {product.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{formatDate(product.last_checked_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex gap-2">
                          {product.status === 'update_available' && (
                            <button
                              onClick={() => triggerBuild(product.id)}
                              className="text-xs bg-[#06B6D4] text-white px-2 py-0.5 rounded hover:bg-[#0891B2]"
                            >
                              Build
                            </button>
                          )}
                          <Link
                            href={`/admin/forge/products/${product.id}`}
                            className="text-xs text-gray-500 hover:text-gray-700 underline"
                          >
                            Details
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Quick links */}
      <div className="px-6 pb-6 grid grid-cols-3 gap-4">
        <Link
          href="/admin/forge/builds"
          className="block p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow"
        >
          <div className="text-[#06B6D4] text-2xl mb-2">🔨</div>
          <div className="font-semibold">Build History</div>
          <div className="text-sm text-gray-500">View all builds and logs</div>
        </Link>
        <Link
          href="/admin/forge/rollouts"
          className="block p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow"
        >
          <div className="text-[#06B6D4] text-2xl mb-2">🚀</div>
          <div className="font-semibold">Rollout Manager</div>
          <div className="text-sm text-gray-500">Manage tenant upgrades</div>
        </Link>
        <Link
          href="/admin/forge/patches"
          className="block p-4 bg-white rounded-lg shadow hover:shadow-md transition-shadow"
        >
          <div className="text-[#06B6D4] text-2xl mb-2">🎨</div>
          <div className="font-semibold">Brand Patches</div>
          <div className="text-sm text-gray-500">Manage TinAI customizations</div>
        </Link>
      </div>
    </div>
  );
}
