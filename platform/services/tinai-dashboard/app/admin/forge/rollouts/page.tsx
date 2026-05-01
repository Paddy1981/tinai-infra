'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { forgeApi, ForgeRollout } from '@/lib/forge-api';

const STRATEGY_ICONS: Record<string, string> = {
  bigbang: '⚡',
  rolling: '📈',
  canary: '🕊️',
};

const STATUS_COLORS: Record<string, string> = {
  in_progress: 'bg-blue-100 text-blue-800',
  paused: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  rolled_back: 'bg-orange-100 text-orange-800',
  failed: 'bg-red-100 text-red-800',
  partially_completed: 'bg-purple-100 text-purple-800',
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

export default function RolloutsPage() {
  const [rollouts, setRollouts] = useState<ForgeRollout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewRolloutForm, setShowNewRolloutForm] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'pause' | 'rollback'; rolloutId: string } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [formData, setFormData] = useState({ product_id: '', strategy: 'rolling' });

  useEffect(() => {
    fetchRollouts();
    const hasRunning = rollouts.some((r) => r.status === 'in_progress');
    if (hasRunning) {
      const interval = setInterval(fetchRollouts, 10000);
      return () => clearInterval(interval);
    }
  }, []);

  async function fetchRollouts() {
    setLoading(true);
    setError(null);
    try {
      const data = await forgeApi.getRollouts();
      setRollouts(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch rollouts');
    } finally {
      setLoading(false);
    }
  }

  async function startRollout() {
    if (!formData.product_id) return;
    setActionLoading(true);
    try {
      await forgeApi.startRollout(formData.product_id, formData.strategy);
      await fetchRollouts();
      setShowNewRolloutForm(false);
      setFormData({ product_id: '', strategy: 'rolling' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start rollout');
    } finally {
      setActionLoading(false);
    }
  }

  async function handleAction() {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      if (confirmAction.type === 'pause') {
        await forgeApi.pauseRollout(confirmAction.rolloutId);
      } else if (confirmAction.type === 'rollback') {
        await forgeApi.rollbackRollout(confirmAction.rolloutId);
      }
      await fetchRollouts();
      setShowConfirmModal(false);
      setConfirmAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to perform action');
    } finally {
      setActionLoading(false);
    }
  }

  const activeRollouts = rollouts.filter((r) => r.status === 'in_progress');
  const historicalRollouts = rollouts.filter((r) => r.status !== 'in_progress');

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#0F172A] text-white px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#06B6D4]">Rollout Manager</h1>
            <p className="text-gray-400 text-sm">Manage tenant upgrades</p>
          </div>
          <div className="flex items-center gap-4">
            <button
              onClick={fetchRollouts}
              disabled={loading}
              className="bg-gray-700 text-white px-4 py-2 rounded text-sm hover:bg-gray-600 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Refreshing...' : 'Refresh'}
            </button>
            <button
              onClick={() => setShowNewRolloutForm(true)}
              className="bg-[#06B6D4] text-white px-4 py-2 rounded text-sm hover:bg-[#0891B2] transition-colors"
            >
              Start New Rollout
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
                onClick={fetchRollouts}
                className="inline-block mt-2 text-sm text-red-800 underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Active Rollouts */}
      {!loading && activeRollouts.length > 0 && (
        <div className="px-6 py-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Active Rollouts</h2>
          <div className="space-y-4">
            {activeRollouts.map((rollout) => (
              <div key={rollout.id} className="bg-white rounded-lg shadow p-6">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{STRATEGY_ICONS[rollout.strategy]}</span>
                    <div>
                      <h3 className="font-semibold text-[#0F172A]">{rollout.product_id}</h3>
                      <p className="text-sm text-gray-500">
                        {rollout.strategy.charAt(0).toUpperCase() + rollout.strategy.slice(1)} rollout (v{rollout.from_version} → v{rollout.to_version})
                      </p>
                    </div>
                  </div>
                  <span className={`px-3 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[rollout.status]}`}>
                    {rollout.status}
                  </span>
                </div>

                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div>
                    <div className="text-sm text-gray-500">Progress</div>
                    <div className="text-lg font-semibold text-[#0F172A]">
                      {rollout.completed_tenants}/{rollout.total_tenants} tenants
                    </div>
                    <div className="mt-2 w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-[#06B6D4] h-2 rounded-full transition-all"
                        style={{
                          width: `${(rollout.completed_tenants / rollout.total_tenants) * 100}%`,
                        }}
                      ></div>
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">Failed</div>
                    <div
                      className={`text-lg font-semibold ${rollout.failed_tenants > 0 ? 'text-red-600' : 'text-green-600'}`}
                    >
                      {rollout.failed_tenants}/{rollout.total_tenants}
                    </div>
                  </div>
                  <div>
                    <div className="text-sm text-gray-500">Started</div>
                    <div className="text-lg font-semibold text-[#0F172A]">
                      {formatDate(rollout.started_at)}
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setConfirmAction({ type: 'pause', rolloutId: rollout.id });
                      setShowConfirmModal(true);
                    }}
                    disabled={actionLoading}
                    className="text-sm px-3 py-1 bg-yellow-100 text-yellow-800 rounded hover:bg-yellow-200 disabled:opacity-50 transition-colors"
                  >
                    Pause Rollout
                  </button>
                  <button
                    onClick={() => {
                      setConfirmAction({ type: 'rollback', rolloutId: rollout.id });
                      setShowConfirmModal(true);
                    }}
                    disabled={actionLoading}
                    className="text-sm px-3 py-1 bg-red-100 text-red-800 rounded hover:bg-red-200 disabled:opacity-50 transition-colors"
                  >
                    Rollback
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historical Rollouts */}
      {!loading && (
        <div className="px-6 py-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {activeRollouts.length > 0 ? 'Completed Rollouts' : 'Rollout History'}
          </h2>
          <div className="bg-white rounded-lg shadow overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#0F172A] text-white">
                <tr>
                  <th className="px-4 py-3 text-left">Product</th>
                  <th className="px-4 py-3 text-left">Version</th>
                  <th className="px-4 py-3 text-left">Strategy</th>
                  <th className="px-4 py-3 text-left">Progress</th>
                  <th className="px-4 py-3 text-left">Failed</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Duration</th>
                  <th className="px-4 py-3 text-left">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {historicalRollouts.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      {rollouts.length === 0
                        ? 'No rollouts yet — start one to upgrade tenants'
                        : 'No completed rollouts yet'}
                    </td>
                  </tr>
                ) : (
                  historicalRollouts.map((rollout) => {
                    const durationMs =
                      new Date(rollout.completed_at || new Date()).getTime() -
                      new Date(rollout.started_at).getTime();
                    const durationHours = Math.floor(durationMs / 3600000);
                    const durationMins = Math.floor((durationMs % 3600000) / 60000);

                    return (
                      <tr key={rollout.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-[#0F172A]">{rollout.product_id}</td>
                        <td className="px-4 py-3 font-mono text-xs">
                          v{rollout.from_version} → v{rollout.to_version}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-lg">{STRATEGY_ICONS[rollout.strategy]}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="w-24 bg-gray-200 rounded-full h-2">
                              <div
                                className="bg-[#06B6D4] h-2 rounded-full"
                                style={{
                                  width: `${(rollout.completed_tenants / rollout.total_tenants) * 100}%`,
                                }}
                              ></div>
                            </div>
                            <span className="text-xs text-gray-600">
                              {Math.round((rollout.completed_tenants / rollout.total_tenants) * 100)}%
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={rollout.failed_tenants > 0 ? 'text-red-600 font-semibold' : 'text-green-600'}
                          >
                            {rollout.failed_tenants}/{rollout.total_tenants}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium ${
                              STATUS_COLORS[rollout.status] || 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {rollout.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {durationHours}h {durationMins}m
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            href={`/admin/forge/rollouts/${rollout.id}`}
                            className="text-xs text-[#06B6D4] hover:text-[#0891B2] underline"
                          >
                            Details
                          </Link>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* New Rollout Form Modal */}
      {showNewRolloutForm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-xl font-bold text-[#0F172A] mb-4">Start New Rollout</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Product</label>
                <input
                  type="text"
                  value={formData.product_id}
                  onChange={(e) => setFormData({ ...formData, product_id: e.target.value })}
                  placeholder="e.g., grafana, prometheus"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Rollout Strategy</label>
                <select
                  value={formData.strategy}
                  onChange={(e) => setFormData({ ...formData, strategy: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#06B6D4]"
                >
                  <option value="canary">Canary (5% of tenants first)</option>
                  <option value="rolling">Rolling (gradual rollout)</option>
                  <option value="bigbang">Big Bang (all tenants at once)</option>
                </select>
              </div>

              <div className="text-sm text-gray-600 bg-blue-50 p-3 rounded">
                <strong>Strategy Details:</strong>
                <ul className="list-disc list-inside mt-1">
                  {formData.strategy === 'canary' && (
                    <li>Start with 5% of tenants, monitor for 1h, then expand</li>
                  )}
                  {formData.strategy === 'rolling' && <li>Roll out gradually over time</li>}
                  {formData.strategy === 'bigbang' && <li>Upgrade all tenants immediately</li>}
                </ul>
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setShowNewRolloutForm(false)}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={startRollout}
                disabled={!formData.product_id || actionLoading}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-[#06B6D4] rounded-lg hover:bg-[#0891B2] disabled:opacity-50 transition-colors"
              >
                {actionLoading ? 'Starting...' : 'Start Rollout'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && confirmAction && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <h2 className="text-xl font-bold text-[#0F172A] mb-2">
              {confirmAction.type === 'pause' ? 'Pause Rollout?' : 'Rollback Rollout?'}
            </h2>
            <p className="text-gray-600 text-sm mb-6">
              {confirmAction.type === 'pause'
                ? 'This will pause the current rollout. You can resume it later.'
                : 'This will roll back all upgraded tenants to their previous version. This action cannot be undone.'}
            </p>

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowConfirmModal(false);
                  setConfirmAction(null);
                }}
                className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleAction}
                disabled={actionLoading}
                className={`flex-1 px-4 py-2 text-sm font-medium text-white rounded-lg ${
                  confirmAction.type === 'pause'
                    ? 'bg-yellow-600 hover:bg-yellow-700'
                    : 'bg-red-600 hover:bg-red-700'
                } disabled:opacity-50 transition-colors`}
              >
                {actionLoading ? 'Processing...' : confirmAction.type === 'pause' ? 'Pause' : 'Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
