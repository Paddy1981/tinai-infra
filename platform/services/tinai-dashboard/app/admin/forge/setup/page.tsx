'use client';

import { useState } from 'react';
import Link from 'next/link';

interface ChecklistItem {
  id: string;
  label: string;
  completed: boolean;
}

export default function SetupPage() {
  const [checklist, setChecklist] = useState<ChecklistItem[]>([
    { id: 'kubectl', label: 'kubectl context configured and pointing to cluster', completed: false },
    { id: 'registry', label: 'Container registry credentials configured', completed: false },
    { id: 'cnpg', label: 'CloudNativePG database ready', completed: false },
    { id: 'namespace', label: 'tinai-forge namespace exists', completed: false },
  ]);

  function toggleChecklist(id: string) {
    setChecklist(checklist.map(item =>
      item.id === id ? { ...item, completed: !item.completed } : item
    ));
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
  }

  const allChecked = checklist.every(item => item.completed);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-[#0F172A] text-white px-6 py-4">
        <div>
          <h1 className="text-2xl font-bold text-[#06B6D4]">Forge Setup Guide</h1>
          <p className="text-gray-400 text-sm">Deploy TinAI Forge to your cluster</p>
        </div>
      </div>

      {/* Prerequisites */}
      <div className="px-6 py-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Prerequisites Checklist</h2>
        <div className="bg-white rounded-lg shadow p-6 max-w-2xl">
          <div className="space-y-3">
            {checklist.map(item => (
              <label key={item.id} className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={item.completed}
                  onChange={() => toggleChecklist(item.id)}
                  className="w-5 h-5 text-[#06B6D4] rounded focus:ring-[#06B6D4]"
                />
                <span className={item.completed ? 'line-through text-gray-400' : 'text-gray-700'}>
                  {item.label}
                </span>
              </label>
            ))}
          </div>

          {allChecked && (
            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-800">
              ✓ All prerequisites met. Ready to deploy!
            </div>
          )}
        </div>
      </div>

      {/* Deployment Steps */}
      <div className="px-6 py-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Deployment Steps</h2>

        <div className="space-y-6 max-w-4xl">
          {/* Step 1: Namespace */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start gap-4">
              <div className="bg-[#06B6D4] text-white rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold">
                1
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#0F172A] mb-2">Create Namespace</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Create a dedicated namespace for the Forge service:
                </p>
                <div className="relative bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm mb-3 overflow-x-auto">
                  <code>kubectl create namespace tinai-forge</code>
                  <button
                    onClick={() => copyToClipboard('kubectl create namespace tinai-forge')}
                    className="absolute top-2 right-2 bg-[#06B6D4] text-white px-2 py-1 rounded text-xs hover:bg-[#0891B2]"
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Step 2: Registry Secret */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start gap-4">
              <div className="bg-[#06B6D4] text-white rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold">
                2
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#0F172A] mb-2">Create Registry Secret</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Create a secret for pulling Forge container images:
                </p>
                <div className="relative bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm mb-3 overflow-x-auto">
                  <code>kubectl create secret docker-registry tinai-registry \<br/>
                    &nbsp;&nbsp;--docker-server=registry.tinai.io \<br/>
                    &nbsp;&nbsp;--docker-username=YOUR_USERNAME \<br/>
                    &nbsp;&nbsp;--docker-password=YOUR_PASSWORD \<br/>
                    &nbsp;&nbsp;-n tinai-forge</code>
                  <button
                    onClick={() => copyToClipboard(`kubectl create secret docker-registry tinai-registry \\\n  --docker-server=registry.tinai.io \\\n  --docker-username=YOUR_USERNAME \\\n  --docker-password=YOUR_PASSWORD \\\n  -n tinai-forge`)}
                    className="absolute top-2 right-2 bg-[#06B6D4] text-white px-2 py-1 rounded text-xs hover:bg-[#0891B2]"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-sm text-gray-600">
                  Replace YOUR_USERNAME and YOUR_PASSWORD with your registry credentials.
                </p>
              </div>
            </div>
          </div>

          {/* Step 3: ConfigMap */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start gap-4">
              <div className="bg-[#06B6D4] text-white rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold">
                3
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#0F172A] mb-2">Apply Configuration</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Create and apply the Forge service configuration:
                </p>
                <div className="relative bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm mb-3 overflow-x-auto">
                  <code>cat &lt;&lt;EOF | kubectl apply -f -<br/>
                    apiVersion: v1<br/>
                    kind: ConfigMap<br/>
                    metadata:<br/>
                    &nbsp;&nbsp;name: tinai-forge-config<br/>
                    &nbsp;&nbsp;namespace: tinai-forge<br/>
                    data:<br/>
                    &nbsp;&nbsp;FORGE_DATABASE_URL: "postgresql://user:password@cloudnativepg:5432/tinai"<br/>
                    &nbsp;&nbsp;FORGE_LOG_LEVEL: "info"<br/>
                    &nbsp;&nbsp;FORGE_WORKERS: "4"<br/>
                    EOF</code>
                  <button
                    onClick={() => copyToClipboard(`cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: tinai-forge-config
  namespace: tinai-forge
data:
  FORGE_DATABASE_URL: "postgresql://user:password@cloudnativepg:5432/tinai"
  FORGE_LOG_LEVEL: "info"
  FORGE_WORKERS: "4"
EOF`)}
                    className="absolute top-2 right-2 bg-[#06B6D4] text-white px-2 py-1 rounded text-xs hover:bg-[#0891B2]"
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Step 4: Deploy */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start gap-4">
              <div className="bg-[#06B6D4] text-white rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold">
                4
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#0F172A] mb-2">Deploy Forge Service</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Deploy the TinAI Forge service to the cluster:
                </p>
                <div className="relative bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm mb-3 overflow-x-auto">
                  <code>kubectl apply -f https://releases.tinai.io/forge/latest/forge-deployment.yaml -n tinai-forge</code>
                  <button
                    onClick={() => copyToClipboard('kubectl apply -f https://releases.tinai.io/forge/latest/forge-deployment.yaml -n tinai-forge')}
                    className="absolute top-2 right-2 bg-[#06B6D4] text-white px-2 py-1 rounded text-xs hover:bg-[#0891B2]"
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Step 5: Verify */}
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-start gap-4">
              <div className="bg-[#06B6D4] text-white rounded-full w-8 h-8 flex items-center justify-center flex-shrink-0 font-bold">
                5
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-[#0F172A] mb-2">Verify Deployment</h3>
                <p className="text-sm text-gray-600 mb-3">
                  Verify that the Forge service is running:
                </p>
                <div className="relative bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm mb-3 overflow-x-auto">
                  <code>kubectl get pods -n tinai-forge</code>
                  <button
                    onClick={() => copyToClipboard('kubectl get pods -n tinai-forge')}
                    className="absolute top-2 right-2 bg-[#06B6D4] text-white px-2 py-1 rounded text-xs hover:bg-[#0891B2]"
                  >
                    Copy
                  </button>
                </div>
                <p className="text-sm text-gray-600 mb-3">
                  Check the logs:
                </p>
                <div className="relative bg-gray-900 text-gray-100 p-4 rounded-lg font-mono text-sm mb-3 overflow-x-auto">
                  <code>kubectl logs -n tinai-forge -l app=tinai-forge -f</code>
                  <button
                    onClick={() => copyToClipboard('kubectl logs -n tinai-forge -l app=tinai-forge -f')}
                    className="absolute top-2 right-2 bg-[#06B6D4] text-white px-2 py-1 rounded text-xs hover:bg-[#0891B2]"
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Environment Variables */}
      <div className="px-6 py-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Configuration Reference</h2>
        <div className="bg-white rounded-lg shadow overflow-hidden max-w-4xl">
          <table className="w-full text-sm">
            <thead className="bg-[#0F172A] text-white">
              <tr>
                <th className="px-4 py-3 text-left">Environment Variable</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-left">Default</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_DATABASE_URL</td>
                <td className="px-4 py-3 text-gray-600">PostgreSQL connection string</td>
                <td className="px-4 py-3 text-gray-500">-</td>
              </tr>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_API_KEY</td>
                <td className="px-4 py-3 text-gray-600">API key for dashboard authentication</td>
                <td className="px-4 py-3 text-gray-500">-</td>
              </tr>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_LOG_LEVEL</td>
                <td className="px-4 py-3 text-gray-600">Logging level (debug, info, warn, error)</td>
                <td className="px-4 py-3 text-gray-500">info</td>
              </tr>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_WORKERS</td>
                <td className="px-4 py-3 text-gray-600">Number of worker threads</td>
                <td className="px-4 py-3 text-gray-500">4</td>
              </tr>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_CHECK_INTERVAL</td>
                <td className="px-4 py-3 text-gray-600">Version check interval in hours</td>
                <td className="px-4 py-3 text-gray-500">6</td>
              </tr>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_BUILD_TIMEOUT</td>
                <td className="px-4 py-3 text-gray-600">Build timeout in minutes</td>
                <td className="px-4 py-3 text-gray-500">30</td>
              </tr>
              <tr className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs">FORGE_REGISTRY_URL</td>
                <td className="px-4 py-3 text-gray-600">Container registry for pushing built images</td>
                <td className="px-4 py-3 text-gray-500">registry.tinai.io</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Next Steps */}
      <div className="px-6 pb-6">
        <div className="bg-green-50 border border-green-200 rounded-lg p-6 max-w-2xl">
          <h3 className="font-semibold text-green-900 mb-3">Once Deployed</h3>
          <p className="text-green-800 text-sm mb-4">
            After the Forge service is running, you can:
          </p>
          <ul className="text-green-800 text-sm space-y-2 mb-4">
            <li>✓ Return to the Forge Dashboard to see products and versions</li>
            <li>✓ Enable automated version checking</li>
            <li>✓ Set up automated builds for new versions</li>
            <li>✓ Configure rollout strategies for tenant upgrades</li>
            <li>✓ Apply TinAI brand patches to white-label instances</li>
          </ul>
          <Link
            href="/admin/forge"
            className="inline-block bg-green-600 text-white px-4 py-2 rounded text-sm hover:bg-green-700 transition-colors"
          >
            Go to Forge Dashboard →
          </Link>
        </div>
      </div>
    </div>
  );
}
