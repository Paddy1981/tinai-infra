import { listSatellites, getStacCollections, Satellite, SatellitesResponse } from '@/lib/api'
import GlobeViewer from './GlobeViewer'

function countryFlag(country: string): string {
  const c = country.toUpperCase()
  if (c === 'INDIA' || c === 'IN') return '🇮🇳'
  if (c === 'USA' || c === 'US') return '🇺🇸'
  if (c === 'EU' || c === 'EUROPE') return '🇪🇺'
  if (c === 'JAPAN' || c === 'JP') return '🇯🇵'
  return '🛰️'
}

function StatCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 flex flex-col gap-1">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-xl font-semibold text-slate-100">{value}</span>
    </div>
  )
}

export default async function SpacePage() {
  let satellitesData: SatellitesResponse = { total: 0, satellites: [] }
  let collections: any[] = []

  const [satResult, stacResult] = await Promise.allSettled([
    listSatellites(),
    getStacCollections(),
  ])

  if (satResult.status === 'fulfilled') {
    satellitesData = satResult.value
  }
  if (stacResult.status === 'fulfilled') {
    collections = stacResult.value.collections
  }

  const { satellites, error } = satellitesData

  const indiaCount = satellites.filter(s => {
    const c = s.country.toUpperCase()
    return c === 'INDIA' || c === 'IN'
  }).length

  const euCount = satellites.filter(s => {
    const c = s.country.toUpperCase()
    return c === 'EU' || c === 'EUROPE'
  }).length

  const otherCount = satellites.length - indiaCount - euCount

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">Space</h1>
        <p className="text-sm text-slate-400 mt-0.5">IN-SPACe Data Platform</p>
      </div>

      {/* 3D Globe — borrowed from sattrack-web Globe.gl pattern */}
      <GlobeViewer satellites={satellites} />

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Total Satellites" value={satellitesData.total} />
        <StatCard label="🇮🇳 India" value={indiaCount} />
        <StatCard label="🇪🇺 EU" value={euCount} />
        <StatCard label="Other" value={otherCount} />
      </div>

      {/* Tracked Satellites */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">Tracked Satellites</h2>

        {error && (
          <div className="rounded-md border border-amber-800 bg-amber-900/30 px-4 py-3 text-sm text-amber-300 mb-3">
            {error}
          </div>
        )}

        {satellites.length === 0 && !error ? (
          <p className="text-sm text-slate-500">
            No satellites yet — TLE ingestion CronJob runs every 6h once deployed.
          </p>
        ) : satellites.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">NORAD ID</th>
                <th className="pb-2 font-medium">Country</th>
                <th className="pb-2 font-medium">Last Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {satellites.map((sat: Satellite) => (
                <tr key={sat.id} className="text-slate-300">
                  <td className="py-2 font-mono text-xs">{sat.name}</td>
                  <td className="py-2 text-xs">{sat.norad_id}</td>
                  <td className="py-2 text-xs">
                    {countryFlag(sat.country)} {sat.country}
                  </td>
                  <td className="py-2 text-xs text-slate-400">
                    {new Date(sat.updated_at).toLocaleDateString('en-IN', {
                      day: '2-digit',
                      month: 'short',
                      year: 'numeric',
                      timeZone: 'UTC',
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      {/* STAC Collections */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">STAC Collections</h2>
        {collections.length === 0 ? (
          <p className="text-sm text-slate-500">No collections available.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Description</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {collections.map((col: any) => (
                <tr key={col.id} className="text-slate-300">
                  <td className="py-2 text-xs font-medium">{col.title}</td>
                  <td className="py-2 text-xs text-slate-400">{col.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer note */}
      <p className="text-xs text-slate-600 text-center">
        TLE data sourced from Celestrak · Updated every 6 hours
      </p>
    </div>
  )
}
