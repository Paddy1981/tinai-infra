'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { forgeApi, ForgeBuild } from '@/lib/forge-api';

const STATUS_COLORS: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-800',
  building: 'bg-blue-100 text-blue-800',
  success: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

function formatDuration(seconds?: number): string {
  if (!seconds || seconds === 0) return 'pending';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

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

function StatusSpinner() {
  return (
    <div className="inline-block w-4 h-4 border-2 border-blue-200 border-t-blue-800 rounded-full animate-spin"></div>
  );
}

export default function BuildsPage() {
  const [builds, setBuilds] = useState<ForgeBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [loadingLogs, setLoadingLogs] = useState<string | null>(null);

  useEffect(() => {
    fetchBuilds();
    const hasBuilding = builds.some((b) => b.status === 'building');
    if (hasBuilding) {
      const interval = setInterval(fetchBuilds, 15000);
      return () => clearInterval(interval);
    }
  }, []);

  async function fetchBuilds() {
    setLoading(true);
    setError(null);
    try {
      const data = await forgeApi.getBuilds({ limit: 50 });
      setBuilds(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch builds');
    } finally {
      setLoading(false);
    }
  }

  async function fetchLogs(buildId: string) {
    setLoadingLogs(buildId);
    try {
      const response = await fetch(`/api/forge/builds/${buildId}/logs`);
      if (response.ok) {
        const text = await response.text();
        setLogs((prev) => ({ ...prev, [buildId]: text }));
      }
    } catch (err) {
      setLogs((prev) => ({
        ...prev,
        [buildId]: 'Failed to load logs: ' + (err instanceof Error ? err.message : 'Unknown error'),
      }));
    } finally {
      setLoadingLogs(null);
    }
  }

  function toggleLogs(buildId: string) {
    if (expandedLogs === buildId) {
      setExpandedLogs(null);
    } else {
      setExpandedLogs(buildId);
      if (!logs[buildId]) {
        fetchLogs(buildId);
      }
    }
  }

  const filteredBuilds =
    filter === 'all' ? builds : builds.filter((b) => b.status === filter);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#0F172A] text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#06B6D4]">Build History</h1>
            <p className="text-gray-400 text-sm">View and manage all builds</p>
          </div>
          <button
            onClick={fetchBuilds}
            disabled={loading}
            className="bg-[#06B6D4] text-white px-4 py-2 rounded text-sm hover:bg-[#0891B2] disabled:opacity-50 transition-colors"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
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
                onClick={fetchBuilds}
                className="inline-block mt-2 text-sm text-red-800 underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Filter tabs */}
      {!loading && (
        <div className="bg-white border-b px-6 py-3 flex gap-4">
          {['all', 'building', 'success', 'failed'].map((status) => (
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
              {status === 'all'
                ? ` (${builds.length})`
                : ` (${builds.filter((b) => b.status === status).length})`}
            </button>
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="px-6 py-6">
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <div className="h-96 bg-gray-100 animate-pulse flex items-center justify-center">
              <div className="text-gray-500">Loading builds...</div>
            </div>
          </div>
        </div>
      )}

      {/* Builds table */}
      {!loading && (
        <div className="px-6 py-6">
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#0F172A] text-white">
                <tr>
                  <th className="px-4 py-3 text-left">ID</th>
                  <th className="px-4 py-3 text-left">Product</th>
                  <th className="px-4 py-3 text-left">Version</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Duration</th>
                  <th className="px-4 py-3 text-left">Started</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredBuilds.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      {builds.length === 0
                        ? 'No builds yet — trigger one from the Overview page'
                        : 'No builds match this filter'}
                    </td>
                  </tr>
                ) : (
                  filteredBuilds.map((build) => (
                    <tbody key={build.id}>
                      <tr className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">{build.id.slice(0, 8)}</td>
                        <td className="px-4 py-3 font-medium text-[#0F172A]">{build.product_id}</td>
                        <td className="px-4 py-3 font-mono text-xs bg-gray-50 rounded">{build.version}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            {build.status === 'building' && <StatusSpinner />}
                            <span
                              className={`px-2 py-1 rounded-full text-xs font-medium ${
                                STATUS_COLORS[build.status] || 'bg-gray-100 text-gray-700'
                              }`}
                            >
                              {build.status.replace('_', ' ')}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {formatDuration(build.duration_seconds)}
                        </td>
                        <td className="px-4 py-3 text-gray-600">{formatDate(build.started_at)}</td>
                        <td className="px-4 py-3">
                          <div className="flex gap-2">
                            <button
                              onClick={() => toggleLogs(build.id)}
                              className="text-xs text-[#06B6D4] hover:text-[#0891B2] underline"
                            >
                              {expandedLogs === build.id ? 'Hide' : 'View'} Logs
                            </button>
                            <Link
                              href={`/admin/forge/builds/${build.id}`}
                              className="text-xs text-gray-500 hover:text-gray-700 underline"
                            >
                              Details
                            </Link>
                          </div>
                        </td>
                      </tr>
                      {expandedLogs === build.id && (
                        <tr>
                          <td colSpan={7} className="px-4 py-4 bg-gray-50 border-t border-gray-100">
                            <div className="space-y-2">
                              <div className="text-xs font-semibold text-gray-700">Build Logs</div>
                              {loadingLogs === build.id ? (
                                <div className="text-gray-500 text-xs">Loading logs...</div>
                              ) : (
                                <div className="bg-gray-900 text-gray-100 p-3 rounded font-mono text-xs max-h-64 overflow-y-auto whitespace-pre-wrap">
                                  {logs[build.id] || 'No logs available'}
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Stats */}
      {!loading && (
        <div className="px-6 pb-6">
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-2xl font-bold text-[#0F172A]">{builds.length}</div>
              <div className="text-xs text-gray-500 mt-1">Total Builds</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-2xl font-bold text-green-600">
                {builds.filter((b) => b.status === 'success').length}
              </div>
              <div className="text-xs text-gray-500 mt-1">Successful</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-2xl font-bold text-red-600">
                {builds.filter((b) => b.status === 'failed').length}
              </div>
              <div className="text-xs text-gray-500 mt-1">Failed</div>
            </div>
            <div className="bg-white p-4 rounded-lg shadow">
              <div className="text-2xl font-bold text-blue-600">
                {builds.filter((b) => b.status === 'building' || b.status === 'queued').length}
              </div>
              <div className="text-xs text-gray-500 mt-1">In Progress</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
