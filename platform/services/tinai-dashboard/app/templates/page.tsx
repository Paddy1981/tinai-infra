import { listTemplates, ServiceTemplate } from '@/lib/features-api'

const CATEGORIES = ['All', 'Database', 'Cache', 'Storage', 'Messaging', 'Email', 'Starter']

function CategoryBadge({ category }: { category: string }) {
  const styles: Record<string, string> = {
    Database: 'bg-blue-900/40 text-blue-400 border-blue-800',
    Cache: 'bg-purple-900/40 text-purple-400 border-purple-800',
    Storage: 'bg-amber-900/40 text-amber-400 border-amber-800',
    Messaging: 'bg-pink-900/40 text-pink-400 border-pink-800',
    Email: 'bg-cyan-900/40 text-cyan-400 border-cyan-800',
    Starter: 'bg-emerald-900/40 text-emerald-400 border-emerald-800',
  }
  const cls = styles[category] ?? 'bg-slate-800 text-slate-400 border-slate-700'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs border ${cls}`}>
      {category}
    </span>
  )
}

function TemplateCard({ t }: { t: ServiceTemplate }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 flex flex-col gap-3 hover:border-slate-700 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl leading-none">{t.icon}</span>
          <div>
            <p className="text-sm font-medium text-slate-100">{t.name}</p>
            <CategoryBadge category={t.category} />
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-400 flex-1">{t.description}</p>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="font-mono">{t.image}</span>
        <span>:{t.port}</span>
      </div>
      <a
        href={`/templates/${t.id}/deploy`}
        className="mt-auto block w-full text-center rounded-md bg-slate-800 border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 hover:border-slate-600 transition-colors"
      >
        Deploy
      </a>
    </div>
  )
}

export default async function TemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string }>
}) {
  const { category } = await searchParams
  const activeCategory = category ?? 'All'

  let templates: ServiceTemplate[] = []
  let error: string | null = null

  try {
    templates = await listTemplates()
  } catch (e) {
    error = (e as Error).message
  }

  const filtered =
    activeCategory === 'All'
      ? templates
      : templates.filter(t => t.category === activeCategory)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">Templates</h1>
        <p className="text-sm text-slate-400 mt-1">One-click service deployment</p>
      </div>

      {/* Category filter tabs */}
      <div className="flex gap-1 flex-wrap">
        {CATEGORIES.map(cat => (
          <a
            key={cat}
            href={cat === 'All' ? '/templates' : `/templates?category=${cat}`}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              activeCategory === cat
                ? 'bg-emerald-900/40 text-emerald-400 border border-emerald-800'
                : 'text-slate-400 border border-slate-800 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            {cat}
          </a>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {!error && filtered.length === 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-8 text-center">
          <p className="text-slate-500 text-sm">
            {templates.length === 0
              ? 'No templates available — API may not be running yet.'
              : `No templates in "${activeCategory}" category.`}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map(t => (
          <TemplateCard key={t.id} t={t} />
        ))}
      </div>
    </div>
  )
}
