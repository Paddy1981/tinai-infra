'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import type { InstanceImage, InstanceType } from '@/lib/instances-api'

// ── Framework colour helpers ─────────────────────────────────────────────────

function frameworkGradient(framework: string | null): string {
  const map: Record<string, string> = {
    pytorch:      'from-orange-600/20 to-orange-500/5',
    tensorflow:   'from-yellow-600/20 to-yellow-500/5',
    vllm:         'from-purple-600/20 to-purple-500/5',
    transformers: 'from-blue-600/20 to-blue-500/5',
    diffusers:    'from-pink-600/20 to-pink-500/5',
    jupyter:      'from-gray-600/20 to-gray-500/5',
    nemo:         'from-green-600/20 to-green-500/5',
    triton:       'from-green-600/20 to-green-500/5',
    rapids:       'from-green-700/20 to-green-500/5',
    'base-os':    'from-slate-600/20 to-slate-500/5',
  }
  return map[framework?.toLowerCase() ?? ''] ?? 'from-indigo-600/20 to-indigo-500/5'
}

function frameworkIconBg(framework: string | null): string {
  const map: Record<string, string> = {
    pytorch:      'bg-orange-500/20 text-orange-400',
    tensorflow:   'bg-yellow-500/20 text-yellow-400',
    vllm:         'bg-purple-500/20 text-purple-400',
    transformers: 'bg-blue-500/20 text-blue-400',
    diffusers:    'bg-pink-500/20 text-pink-400',
    jupyter:      'bg-gray-500/20 text-gray-400',
    nemo:         'bg-green-500/20 text-green-400',
    triton:       'bg-green-500/20 text-green-400',
    rapids:       'bg-green-600/20 text-green-400',
    'base-os':    'bg-slate-600/20 text-slate-400',
  }
  return map[framework?.toLowerCase() ?? ''] ?? 'bg-indigo-500/20 text-indigo-400'
}

function frameworkInitials(framework: string | null, name: string): string {
  if (framework) return framework.slice(0, 2).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

// ── Random name generator ────────────────────────────────────────────────────

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6)
}

function defaultInstanceName(framework: string | null): string {
  const base = framework ? framework.toLowerCase().replace(/[^a-z0-9]/g, '') : 'gpu'
  return `${base}-${randomSuffix()}`
}

// ── Chip component ───────────────────────────────────────────────────────────

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-slate-800 text-slate-400 border border-slate-700">
      {label}
    </span>
  )
}

// ── Image card ───────────────────────────────────────────────────────────────

function ImageCard({
  image,
  selected,
  onSelect,
}: {
  image: InstanceImage
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      className={`text-left rounded-lg border p-4 transition-all bg-gradient-to-br ${frameworkGradient(image.framework)} ${
        selected
          ? 'border-emerald-500 border-2 shadow-lg shadow-emerald-500/10'
          : 'border-slate-800 hover:border-slate-700'
      }`}
    >
      <div className="flex items-start gap-3 mb-3">
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${frameworkIconBg(image.framework)}`}>
          {frameworkInitials(image.framework, image.name)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium text-slate-100 text-sm truncate">{image.name}</p>
            <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400 border border-slate-700">
              {image.version}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{image.description}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {image.cuda_version && <Chip label={`CUDA ${image.cuda_version}`} />}
        {image.python_version && <Chip label={`Python ${image.python_version}`} />}
        {image.os_version && <Chip label={image.os_version} />}
      </div>
    </button>
  )
}

// ── Instance type card ───────────────────────────────────────────────────────

function TypeCard({
  type,
  selected,
  onSelect,
}: {
  type: InstanceType
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      onClick={onSelect}
      disabled={!type.is_available}
      className={`text-left rounded-lg border p-4 transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
        selected
          ? 'border-emerald-500 border-2 shadow-lg shadow-emerald-500/10 bg-emerald-950/10'
          : 'border-slate-800 hover:border-slate-700 bg-slate-900'
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2">
            {type.is_available ? (
              <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
            ) : (
              <span className="h-2 w-2 rounded-full bg-slate-600 shrink-0" />
            )}
            <p className="font-semibold text-slate-100 text-sm">{type.name}</p>
          </div>
          {type.gpu_model && (
            <p className="text-xs text-slate-400 mt-0.5 ml-4">
              {type.gpu_count}× {type.gpu_model}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-emerald-400 font-semibold text-sm">{type.price_formatted}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-400 ml-4">
        {type.vram_gb != null && (
          <span><span className="text-slate-500">VRAM</span> {type.vram_gb} GB</span>
        )}
        <span><span className="text-slate-500">RAM</span> {type.ram_gb} GB</span>
        <span><span className="text-slate-500">vCPU</span> {type.vcpu}</span>
        <span><span className="text-slate-500">Disk</span> {type.storage_gb} GB</span>
      </div>
    </button>
  )
}

// ── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: 'Choose Image' },
    { n: 2, label: 'Choose Type' },
    { n: 3, label: 'Configure' },
  ] as const

  return (
    <div className="flex items-center gap-0 mb-8">
      {steps.map((step, i) => (
        <div key={step.n} className="flex items-center">
          <div className="flex items-center gap-2">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold border transition-colors ${
                step.n < current
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : step.n === current
                  ? 'bg-emerald-600/20 border-emerald-500 text-emerald-400'
                  : 'bg-slate-800 border-slate-700 text-slate-500'
              }`}
            >
              {step.n < current ? (
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                step.n
              )}
            </div>
            <span
              className={`text-sm font-medium transition-colors ${
                step.n === current ? 'text-slate-200' : step.n < current ? 'text-slate-400' : 'text-slate-600'
              }`}
            >
              {step.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`mx-4 h-px w-12 ${step.n < current ? 'bg-emerald-700' : 'bg-slate-700'}`} />
          )}
        </div>
      ))}
    </div>
  )
}

// ── Category tabs ─────────────────────────────────────────────────────────────

type ImageCategory = 'all' | 'pre-built' | 'base-os' | 'custom'

const CATEGORY_TABS: { value: ImageCategory; label: string }[] = [
  { value: 'all',       label: 'All' },
  { value: 'pre-built', label: 'Pre-built' },
  { value: 'base-os',   label: 'Base OS' },
  { value: 'custom',    label: 'Custom Images' },
]

// ── Main page ────────────────────────────────────────────────────────────────

export default function NewInstancePage() {
  const router = useRouter()

  const [images, setImages] = useState<InstanceImage[]>([])
  const [types, setTypes] = useState<InstanceType[]>([])
  const [loadingImages, setLoadingImages] = useState(true)
  const [loadingTypes, setLoadingTypes] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)

  const [imageCategory, setImageCategory] = useState<ImageCategory>('all')
  const [selectedImage, setSelectedImage] = useState<InstanceImage | null>(null)
  const [selectedType, setSelectedType] = useState<InstanceType | null>(null)

  const [instanceName, setInstanceName] = useState('')
  const [volumeSize, setVolumeSize] = useState(50)
  const [launching, setLaunching] = useState(false)
  const [launchError, setLaunchError] = useState<string | null>(null)

  // Determine current wizard step
  const step: 1 | 2 | 3 = !selectedImage ? 1 : !selectedType ? 2 : 3

  // Fetch images on mount
  useEffect(() => {
    setLoadingImages(true)
    fetch('/api/v1/instances/images')
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json() as Promise<InstanceImage[]>
      })
      .then(setImages)
      .catch((e) => setFetchError(`Failed to load images: ${e.message}`))
      .finally(() => setLoadingImages(false))
  }, [])

  // Fetch types when user reaches step 2
  useEffect(() => {
    if (!selectedImage) return
    setLoadingTypes(true)
    fetch('/api/v1/instances/types')
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`)
        return r.json() as Promise<InstanceType[]>
      })
      .then(setTypes)
      .catch((e) => setFetchError(`Failed to load instance types: ${e.message}`))
      .finally(() => setLoadingTypes(false))
  }, [selectedImage])

  // Auto-generate name when image is selected
  const handleSelectImage = useCallback((img: InstanceImage) => {
    setSelectedImage(img)
    setSelectedType(null)
    setInstanceName(defaultInstanceName(img.framework))
  }, [])

  const filteredImages =
    imageCategory === 'all'
      ? images
      : images.filter((img) => img.category === imageCategory)

  const gpuTypes = types.filter((t) => t.category === 'gpu')
  const cpuTypes = types.filter((t) => t.category === 'cpu')

  const estimatedHourlyCost = selectedType
    ? (selectedType.price_per_hour_paise / 100).toFixed(2)
    : null

  async function handleLaunch() {
    if (!selectedImage || !selectedType) return
    setLaunching(true)
    setLaunchError(null)
    try {
      const res = await fetch('/api/v1/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: instanceName,
          image_slug: selectedImage.slug,
          instance_type_slug: selectedType.slug,
          volume_size_gb: volumeSize,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.detail ?? `Server error: ${res.status}`)
      }
      router.push('/instances')
    } catch (e) {
      setLaunchError((e as Error).message)
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <a href="/instances" className="text-slate-500 hover:text-slate-300 transition-colors">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </a>
        <h1 className="text-xl font-semibold">Launch GPU Instance</h1>
      </div>

      <StepIndicator current={step} />

      {fetchError && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-6">
          {fetchError}
        </div>
      )}

      {/* ── Step 1: Choose Image ────────────────────────────────────────── */}
      <section className="mb-10">
        <h2 className="text-base font-semibold text-slate-200 mb-1">1. Choose Image</h2>
        <p className="text-sm text-slate-500 mb-4">Select a pre-built framework environment or a base OS image</p>

        {/* Category tabs */}
        <div className="flex gap-1 mb-4 border-b border-slate-800 pb-0">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setImageCategory(tab.value)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                imageCategory === tab.value
                  ? 'border-emerald-500 text-emerald-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {loadingImages ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-slate-800 bg-slate-900 p-4 h-32 animate-pulse" />
            ))}
          </div>
        ) : filteredImages.length === 0 ? (
          <p className="text-slate-500 text-sm py-8 text-center">No images found in this category.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {filteredImages.map((img) => (
              <ImageCard
                key={img.id}
                image={img}
                selected={selectedImage?.id === img.id}
                onSelect={() => handleSelectImage(img)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Step 2: Choose Instance Type ────────────────────────────────── */}
      {selectedImage && (
        <section className="mb-10">
          <h2 className="text-base font-semibold text-slate-200 mb-1">2. Choose Instance Type</h2>
          <p className="text-sm text-slate-500 mb-4">Select GPU or CPU resources for your instance</p>

          {loadingTypes ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="rounded-lg border border-slate-800 bg-slate-900 p-4 h-28 animate-pulse" />
              ))}
            </div>
          ) : (
            <>
              {gpuTypes.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">GPU Instances</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {gpuTypes.map((t) => (
                      <TypeCard
                        key={t.id}
                        type={t}
                        selected={selectedType?.id === t.id}
                        onSelect={() => setSelectedType(t)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {cpuTypes.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">CPU Instances</h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {cpuTypes.map((t) => (
                      <TypeCard
                        key={t.id}
                        type={t}
                        selected={selectedType?.id === t.id}
                        onSelect={() => setSelectedType(t)}
                      />
                    ))}
                  </div>
                </div>
              )}
              {types.length === 0 && (
                <p className="text-slate-500 text-sm py-8 text-center">No instance types available.</p>
              )}
            </>
          )}
        </section>
      )}

      {/* ── Step 3: Configure & Launch ──────────────────────────────────── */}
      {selectedImage && selectedType && (
        <section>
          <h2 className="text-base font-semibold text-slate-200 mb-1">3. Configure &amp; Launch</h2>
          <p className="text-sm text-slate-500 mb-4">Name your instance and set persistent storage</p>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Config inputs */}
            <div className="lg:col-span-2 space-y-5">
              {/* Name */}
              <div>
                <label htmlFor="instance-name" className="block text-sm font-medium text-slate-300 mb-1.5">
                  Instance Name
                </label>
                <input
                  id="instance-name"
                  type="text"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  placeholder="e.g. pytorch-a8x2"
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
                />
                <p className="text-xs text-slate-500 mt-1">Lowercase letters, numbers, and hyphens only</p>
              </div>

              {/* Volume size */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="volume-size" className="text-sm font-medium text-slate-300">
                    Persistent Volume
                  </label>
                  <span className="text-sm font-semibold text-emerald-400">{volumeSize} GB</span>
                </div>
                <input
                  id="volume-size"
                  type="range"
                  min={50}
                  max={500}
                  step={50}
                  value={volumeSize}
                  onChange={(e) => setVolumeSize(Number(e.target.value))}
                  className="w-full accent-emerald-500"
                />
                <div className="flex justify-between text-xs text-slate-600 mt-1">
                  <span>50 GB</span>
                  <span>500 GB</span>
                </div>
              </div>

              {/* Launch error */}
              {launchError && (
                <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
                  {launchError}
                </div>
              )}

              {/* Launch button */}
              <button
                onClick={handleLaunch}
                disabled={launching || !instanceName.trim()}
                className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-emerald-700 disabled:cursor-not-allowed px-4 py-3 text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2"
              >
                {launching ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Launching…
                  </>
                ) : (
                  'Launch Instance'
                )}
              </button>
            </div>

            {/* Summary panel */}
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 h-fit">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Summary</h3>
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-slate-500 mb-0.5">Image</p>
                  <p className="text-sm text-slate-200 font-medium">{selectedImage.name}</p>
                  <p className="text-xs text-slate-500">{selectedImage.version}</p>
                </div>
                <div className="border-t border-slate-800 pt-3">
                  <p className="text-xs text-slate-500 mb-0.5">Instance Type</p>
                  <p className="text-sm text-slate-200 font-medium">{selectedType.name}</p>
                  {selectedType.gpu_model && (
                    <p className="text-xs text-slate-500">
                      {selectedType.gpu_count}× {selectedType.gpu_model} · {selectedType.vram_gb}GB VRAM
                    </p>
                  )}
                </div>
                <div className="border-t border-slate-800 pt-3">
                  <p className="text-xs text-slate-500 mb-0.5">Storage</p>
                  <p className="text-sm text-slate-200">{volumeSize} GB</p>
                </div>
                <div className="border-t border-slate-800 pt-3">
                  <div className="flex items-baseline justify-between">
                    <p className="text-xs text-slate-500">Estimated cost</p>
                    <p className="text-lg font-bold text-emerald-400">{selectedType.price_formatted}</p>
                  </div>
                  {estimatedHourlyCost && (
                    <p className="text-xs text-slate-600 text-right">
                      ₹{estimatedHourlyCost}/hr · billed per minute
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
