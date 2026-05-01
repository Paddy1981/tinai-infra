'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface ProductDetail {
  id: string;
  name: string;
  tinai_name: string;
  current_version: string;
  latest_version: string;
  patch_version: string;
  status: string;
  description: string;
  repository_url: string;
  documentation_url: string;
  last_checked_at: string;
  next_check_at: string;
  check_interval_hours: number;
}

interface Build {
  id: string;
  version: string;
  status: string;
  started_at: string;
}

// Mock product detail
const getMockProduct = (id: string): ProductDetail => {
  const products: Record<string, ProductDetail> = {
    grafana: {
      id: 'grafana',
      name: 'Grafana',
      tinai_name: 'TinAI Insights',
      current_version: 'v11.3.0',
      latest_version: 'v11.3.0',
      patch_version: '1.0.0',
      status: 'current',
      description: 'Metrics visualization and dashboarding platform',
      repository_url: 'https://github.com/grafana/grafana',
      documentation_url: 'https://grafana.com/docs',
      last_checked_at: new Date(Date.now() - 3600000).toISOString(),
      next_check_at: new Date(Date.now() + 18000000).toISOString(),
      check_interval_hours: 6,
    },
  };
  return products[id] || products.grafana;
};

const MOCK_BUILDS: Build[] = [
  { id: 'build-1', version: 'v11.3.0', status: 'passed', started_at: new Date(Date.now() - 86400000).toISOString() },
  { id: 'build-2', version: 'v11.2.0', status: 'passed', started_at: new Date(Date.now() - 172800000).toISOString() },
];

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString();
}

export default function ProductDetailPage() {
  const params = useParams();
  const productId = params.id as string;

  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [builds, setBuilds] = useState<Build[]>(MOCK_BUILDS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setProduct(getMockProduct(productId));
    setLoading(false);
  }, [productId]);

  if (loading) {
    return <div className="flex items-center justify-center min-h-screen">Loading...</div>;
  }

  if (!product) {
    return <div className="flex items-center justify-center min-h-screen">Product not found</div>;
  }

  const updateAvailable = product.latest_version !== product.current_version;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#0F172A] text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Link href="/admin/forge" className="text-[#06B6D4] hover:text-[#0891B2]">
                Forge
              </Link>
              <span className="text-gray-400">/</span>
              <span>{product.tinai_name}</span>
            </div>
            <h1 className="text-2xl font-bold text-[#06B6D4]">{product.tinai_name}</h1>
            <p className="text-gray-400 text-sm">{product.name}</p>
          </div>
          {updateAvailable && (
            <button className="bg-yellow-600 text-white px-4 py-2 rounded text-sm hover:bg-yellow-700 transition-colors">
              Build Update
            </button>
          )}
        </div>
      </div>

      {/* Overview */}
      <div className="px-6 py-6 grid grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">Running Version</div>
          <div className="font-mono font-bold text-[#0F172A]">{product.current_version}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">Latest Upstream</div>
          <div className={`font-mono font-bold ${updateAvailable ? 'text-yellow-600' : 'text-green-600'}`}>
            {product.latest_version}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">Patch Version</div>
          <div className="font-mono font-bold text-[#06B6D4]">v{product.patch_version}</div>
        </div>
        <div className="bg-white rounded-lg shadow p-4">
          <div className="text-xs text-gray-500 uppercase mb-1">Last Checked</div>
          <div className="text-sm text-[#0F172A]">{new Date(product.last_checked_at).toLocaleDateString()}</div>
        </div>
      </div>

      {/* Content */}
      <div className="px-6 pb-6 grid grid-cols-3 gap-6">
        {/* Main content */}
        <div className="col-span-2 space-y-6">
          {/* Description */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="font-semibold text-[#0F172A] mb-3">About</h2>
            <p className="text-gray-600 text-sm mb-4">{product.description}</p>
            <div className="space-y-2">
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Repository</div>
                <a
                  href={product.repository_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#06B6D4] hover:text-[#0891B2] text-sm break-all"
                >
                  {product.repository_url}
                </a>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Documentation</div>
                <a
                  href={product.documentation_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#06B6D4] hover:text-[#0891B2] text-sm"
                >
                  View Documentation →
                </a>
              </div>
            </div>
          </div>

          {/* Recent Builds */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="font-semibold text-[#0F172A] mb-4">Recent Builds</h2>
            <div className="space-y-3">
              {builds.map((build) => (
                <div key={build.id} className="flex items-center justify-between p-3 bg-gray-50 rounded">
                  <div>
                    <div className="font-mono text-sm font-semibold text-[#0F172A]">{build.version}</div>
                    <div className="text-xs text-gray-500">{new Date(build.started_at).toLocaleString()}</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`px-2 py-1 rounded text-xs font-medium ${
                      build.status === 'passed'
                        ? 'bg-green-100 text-green-800'
                        : build.status === 'failed'
                        ? 'bg-red-100 text-red-800'
                        : 'bg-blue-100 text-blue-800'
                    }`}>
                      {build.status}
                    </span>
                    <button className="text-xs text-[#06B6D4] hover:text-[#0891B2] underline">
                      View
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Configuration */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="font-semibold text-[#0F172A] mb-4">Configuration</h2>
            <div className="space-y-3 text-sm">
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Check Interval</div>
                <div className="text-[#0F172A]">{product.check_interval_hours}h</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 uppercase mb-1">Next Check</div>
                <div className="text-[#0F172A]">{formatDate(product.next_check_at)}</div>
              </div>
              <button className="w-full mt-3 text-xs px-3 py-2 bg-[#06B6D4] text-white rounded hover:bg-[#0891B2] transition-colors">
                Check Now
              </button>
            </div>
          </div>

          {/* Status */}
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="font-semibold text-[#0F172A] mb-4">Status</h2>
            <div className="space-y-3">
              {updateAvailable ? (
                <div className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                  <div className="font-semibold text-yellow-800 text-sm mb-2">Update Available</div>
                  <p className="text-xs text-yellow-700 mb-3">
                    {product.latest_version} is now available. Click Build Update above to get started.
                  </p>
                </div>
              ) : (
                <div className="p-3 bg-green-50 border border-green-200 rounded">
                  <div className="font-semibold text-green-800 text-sm">Up to Date</div>
                  <p className="text-xs text-green-700 mt-1">
                    Running the latest version from upstream.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
