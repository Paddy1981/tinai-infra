'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Patch {
  id: string;
  name: string;
  description: string;
  version: string;
  created_at: string;
  tenants_applied: number;
  status: 'active' | 'archived' | 'draft';
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-800',
  archived: 'bg-gray-100 text-gray-800',
  draft: 'bg-yellow-100 text-yellow-800',
};

// Mock patches data
const MOCK_PATCHES: Patch[] = [
  {
    id: 'patch-001',
    name: 'TinAI Logo & Colors',
    description: 'Custom TinAI branding applied to all interfaces',
    version: '1.0.0',
    created_at: new Date(Date.now() - 604800000).toISOString(),
    tenants_applied: 85,
    status: 'active',
  },
  {
    id: 'patch-002',
    name: 'Custom Auth Branding',
    description: 'White-labeled authentication screens with custom CSS',
    version: '2.0.0',
    created_at: new Date(Date.now() - 432000000).toISOString(),
    tenants_applied: 62,
    status: 'active',
  },
  {
    id: 'patch-003',
    name: 'Email Templates',
    description: 'Customized email notifications with TinAI branding',
    version: '1.1.0',
    created_at: new Date(Date.now() - 259200000).toISOString(),
    tenants_applied: 100,
    status: 'active',
  },
  {
    id: 'patch-004',
    name: 'Dashboard Customizations',
    description: 'Custom dashboard theme and layout',
    version: '1.0.0',
    created_at: new Date(Date.now() - 172800000).toISOString(),
    tenants_applied: 0,
    status: 'draft',
  },
];

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
}

export default function PatchesPage() {
  const [patches, setPatches] = useState<Patch[]>(MOCK_PATCHES);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    fetchPatches();
  }, []);

  async function fetchPatches() {
    setLoading(true);
    try {
      const res = await fetch('/api/forge/patches');
      if (res.ok) {
        const data = await res.json();
        setPatches(data.patches || MOCK_PATCHES);
      }
    } catch {
      // Use mock data
    } finally {
      setLoading(false);
    }
  }

  const filteredPatches = filter === 'all'
    ? patches
    : patches.filter(p => p.status === filter);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#0F172A] text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#06B6D4]">Brand Patches</h1>
            <p className="text-gray-400 text-sm">Manage TinAI customizations and branding</p>
          </div>
          <button
            onClick={fetchPatches}
            className="bg-[#06B6D4] text-white px-4 py-2 rounded text-sm hover:bg-[#0891B2] transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 border-b border-blue-200 px-6 py-4">
        <p className="text-sm text-blue-800">
          Patches are TinAI branding customizations applied to white-label instances.
          Changes are automatically deployed to selected tenants during the next rollout.
        </p>
      </div>

      {/* Filter tabs */}
      <div className="bg-white border-b px-6 py-3 flex gap-4">
        {['all', 'active', 'draft', 'archived'].map(status => (
          <button
            key={status}
            onClick={() => setFilter(status)}
            className={`text-sm font-medium px-3 py-2 rounded transition-colors ${
              filter === status
                ? 'bg-[#06B6D4] text-white'
                : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
            {status === 'all' ? ` (${patches.length})` : ` (${patches.filter(p => p.status === status).length})`}
          </button>
        ))}
      </div>

      {/* Patches grid */}
      <div className="px-6 py-6">
        <div className="grid grid-cols-3 gap-4">
          {filteredPatches.length === 0 ? (
            <div className="col-span-3 text-center py-12 text-gray-500">
              No patches found
            </div>
          ) : (
            filteredPatches.map((patch) => (
              <div key={patch.id} className="bg-white rounded-lg shadow hover:shadow-md transition-shadow overflow-hidden">
                <div className="p-4 border-b border-gray-100">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="font-semibold text-[#0F172A]">{patch.name}</h3>
                    <span className={`px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_COLORS[patch.status]}`}>
                      {patch.status}
                    </span>
                  </div>
                  <p className="text-sm text-gray-600">{patch.description}</p>
                </div>

                <div className="p-4 space-y-3">
                  <div>
                    <div className="text-xs text-gray-500 mb-1">Version</div>
                    <div className="font-mono text-sm font-semibold text-[#0F172A]">v{patch.version}</div>
                  </div>

                  <div>
                    <div className="text-xs text-gray-500 mb-1">Applied to Tenants</div>
                    <div className="text-sm font-semibold text-[#0F172A]">{patch.tenants_applied}</div>
                  </div>

                  <div>
                    <div className="text-xs text-gray-500 mb-1">Created</div>
                    <div className="text-sm text-gray-600">{formatDate(patch.created_at)}</div>
                  </div>
                </div>

                <div className="p-4 border-t border-gray-100 flex gap-2">
                  <button className="flex-1 text-xs text-[#06B6D4] hover:text-[#0891B2] underline">
                    View
                  </button>
                  <button className="flex-1 text-xs text-[#06B6D4] hover:text-[#0891B2] underline">
                    Edit
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Create new patch card */}
      <div className="px-6 pb-6">
        <button className="w-full max-w-sm mx-auto block p-6 bg-white rounded-lg shadow hover:shadow-md transition-shadow border-2 border-dashed border-gray-300 text-center hover:border-[#06B6D4]">
          <div className="text-3xl mb-2">➕</div>
          <div className="font-semibold text-[#0F172A]">Create New Patch</div>
          <div className="text-xs text-gray-500 mt-1">Add custom branding or configuration</div>
        </button>
      </div>
    </div>
  );
}
