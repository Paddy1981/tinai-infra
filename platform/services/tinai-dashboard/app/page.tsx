// Enhanced Interactive Landing Page with "Nuts & Bolts" Theme
// The T-logo bolt powers infrastructure - animations show TinAI as the foundation

'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'

const NAV_LINKS = [
  { href: '#features', label: 'Features' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#stack', label: 'Stack' },
  { href: '#community', label: 'Community' },
  { href: '/docs', label: 'Docs' },
]

const PRODUCT_CARDS = [
  {
    title: 'GPU Compute',
    slug: 'gpu-compute',
    badge: 'Platform',
    badgeColor: 'text-violet-400 bg-violet-950/50 border-violet-800/50',
    icon: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18',
    iconColor: 'text-violet-400',
    glowColor: 'from-violet-950/40',
    desc: 'Ready-to-use GPU environments, not bare metal. One-click Jupyter, VSCode, ComfyUI. Your workspace persists, your data stays in-region.',
    pills: ['Jupyter Lab', 'VSCode', 'ComfyUI', 'vLLM', 'Persistent storage', 'Pre-built images'],
  },
  {
    title: 'Tinai Mail',
    slug: 'tinai-mail',
    badge: 'Email',
    badgeColor: 'text-blue-400 bg-blue-950/50 border-blue-800/50',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    iconColor: 'text-blue-400',
    glowColor: 'from-blue-950/40',
    desc: 'Business email with your domain. Sovereign mail server, zero vendor lock-in. SMTP/IMAP standards, works with any client.',
    pills: ['Custom domain', 'IMAP/SMTP', 'Anti-spam', 'Webmail', 'Aliases', 'Mobile sync'],
  },
  {
    title: 'COLL',
    slug: 'coll',
    badge: 'Collaboration',
    badgeColor: 'text-emerald-400 bg-emerald-950/50 border-emerald-800/50',
    icon: 'M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z',
    iconColor: 'text-emerald-400',
    glowColor: 'from-emerald-950/40',
    desc: 'Team collaboration platform. Channels, DMs, file sharing, video calls. Open-source alternative to Slack, runs on your infrastructure.',
    pills: ['Channels', 'Direct messages', 'File sharing', 'Video calls', 'Integrations', 'Self-hosted'],
  },
  {
    title: 'Object Storage',
    slug: 'object-storage',
    badge: 'Storage',
    badgeColor: 'text-sky-400 bg-sky-950/50 border-sky-800/50',
    icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
    iconColor: 'text-sky-400',
    glowColor: 'from-sky-950/40',
    desc: 'S3-compatible MinIO buckets and managed PostgreSQL databases — both provisioned instantly, data in-region.',
    pills: ['S3-compatible', 'PostgreSQL', 'Auto backups', 'PITR', 'Geo-replication'],
  },
  {
    title: 'AI Inference',
    slug: 'ai-inference',
    badge: 'Inference',
    badgeColor: 'text-orange-400 bg-orange-950/50 border-orange-800/50',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    iconColor: 'text-orange-400',
    glowColor: 'from-orange-950/40',
    desc: 'Unified proxy for 10+ AI models with semantic caching, budget caps, and per-tenant rate limits built in.',
    pills: ['Claude', 'Sarvam', 'Gemini', 'Krutrim', 'Semantic cache', 'Budget caps'],
  },
  {
    title: 'Serverless Functions',
    slug: 'serverless-functions',
    badge: 'Functions',
    badgeColor: 'text-amber-400 bg-amber-950/50 border-amber-800/50',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    iconColor: 'text-amber-400',
    glowColor: 'from-amber-950/40',
    desc: 'Deploy functions that scale from zero. Powered by Knative — no servers to manage, no idle costs.',
    pills: ['Knative', 'Scale to zero', 'NATS events', 'Auto-scale'],
  },
  {
    title: 'Edge Compute',
    slug: 'edge-compute',
    badge: 'Edge',
    badgeColor: 'text-cyan-400 bg-cyan-950/50 border-cyan-800/50',
    icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    iconColor: 'text-cyan-400',
    glowColor: 'from-cyan-950/40',
    desc: 'Code that runs close to your users. 20+ Indian cities, <10ms latency. CDN + compute in one. API routing, personalization, edge rendering.',
    pills: ['20+ cities', '<10ms latency', 'CDN included', 'WebAssembly', 'V8 Isolates', 'Zero cold start'],
  },
  {
    title: 'AI Gateway',
    slug: 'ai-gateway',
    badge: 'Gateway',
    badgeColor: 'text-rose-400 bg-rose-950/50 border-rose-800/50',
    icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    iconColor: 'text-rose-400',
    glowColor: 'from-rose-950/40',
    desc: 'Central control plane for all AI traffic. Enforce policies, route by capability, audit every request.',
    pills: ['Multi-model routing', 'Rate limits', 'Audit logs', 'SSO'],
  },
  {
    title: 'Multi-tenant Platform',
    slug: 'multi-tenant-platform',
    badge: 'Tenants',
    badgeColor: 'text-indigo-400 bg-indigo-950/50 border-indigo-800/50',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    iconColor: 'text-indigo-400',
    glowColor: 'from-indigo-950/40',
    desc: 'Full tenant isolation with 4-tier quota enforcement, namespace-level network policies, and instant provisioning.',
    pills: ['Namespace isolation', 'Kyverno policies', 'Quota tiers', 'Tenant CLI'],
  },
]

// Animated T-mark with bolt/gear animations
function AnimatedTBolt({
  size = 32,
  className = '',
  variant = 'orange'
}: {
  size?: number;
  className?: string;
  variant?: 'orange' | 'white';
}) {
  const [rotation, setRotation] = useState(0)
  const [energyPulse, setEnergyPulse] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setRotation(r => r + 1)
      setEnergyPulse(p => (p + 1) % 100)
    }, 30)
    return () => clearInterval(interval)
  }, [])

  // Color scheme based on variant
  const colors = variant === 'white'
    ? {
        ring: '#FFFFFF',
        bolt: '#FFFFFF',
        gradient1: '#FFFFFF',
        gradient2: '#E5E5E5',
        glow: 'glowWhite',
      }
    : {
        ring: '#F97316',
        bolt: '#F97316',
        gradient1: '#F97316',
        gradient2: '#EA6C0A',
        glow: 'glow',
      }

  return (
    <div className={`relative ${className}`} style={{ width: size, height: size }}>
      {/* Energy rings */}
      <svg className="absolute inset-0 animate-spin-slow" viewBox="0 0 32 32">
        <circle cx="16" cy="16" r="14" fill="none" stroke={colors.ring} strokeWidth="0.5" opacity={0.2 + energyPulse / 200} />
        <circle cx="16" cy="16" r="12" fill="none" stroke={colors.ring} strokeWidth="0.5" opacity={0.3 + energyPulse / 200} />
      </svg>

      {/* Connecting bolts (infrastructure connections) */}
      {[0, 60, 120, 180, 240, 300].map((angle, i) => (
        <div
          key={i}
          className="absolute"
          style={{
            top: '50%',
            left: '50%',
            width: '2px',
            height: '8px',
            background: `linear-gradient(to bottom, ${colors.bolt}, transparent)`,
            transform: `translate(-50%, -50%) rotate(${angle + rotation / 2}deg) translateY(-${12 + Math.sin(energyPulse / 10 + i) * 2}px)`,
            opacity: 0.4 + Math.sin(energyPulse / 20 + i) * 0.2,
          }}
        />
      ))}

      {/* Main T-bolt logo */}
      <svg className="absolute inset-0" viewBox="0 0 32 32" fill="none">
        <defs>
          <linearGradient id={`boltGradient-${variant}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={colors.gradient1} />
            <stop offset="100%" stopColor={colors.gradient2} />
          </linearGradient>
          <filter id={colors.glow}>
            <feGaussianBlur stdDeviation="2" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path
          d="M 8,4 H 24 Q 29,4 29,9 V 14 H 20 V 28 Q 20,32 16,32 Q 12,32 12,28 V 14 H 3 V 9 Q 3,4 8,4 Z"
          fill={`url(#boltGradient-${variant})`}
          filter={`url(#${colors.glow})`}
        />
        {/* Bolt highlights */}
        <path
          d="M 10,6 H 22 Q 25,6 25,9 V 12 H 18 V 26 Q 18,29 16,29 Q 14,29 14,26 V 12 H 7 V 9 Q 7,6 10,6 Z"
          fill="#FFF"
          opacity={variant === 'white' ? 0.3 : 0.15}
        />
      </svg>

      {/* Particle effects */}
      {[...Array(6)].map((_, i) => (
        <div
          key={`particle-${i}`}
          className="absolute w-1 h-1 rounded-full bg-[#F97316]"
          style={{
            top: '50%',
            left: '50%',
            transform: `translate(-50%, -50%) rotate(${(rotation * 3 + i * 60)}deg) translateY(-${16 + Math.sin(energyPulse / 15 + i) * 4}px)`,
            opacity: 0.3 + Math.sin(energyPulse / 10 + i) * 0.3,
          }}
        />
      ))}
    </div>
  )
}

// Infrastructure foundation visual
function FoundationGrid() {
  return (
    <div className="absolute inset-0 opacity-30 pointer-events-none">
      <svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#F97316" strokeWidth="0.5" opacity="0.3" />
          </pattern>
          <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" fill="#F97316" opacity="0.2" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#dots)" />
        <rect width="100%" height="100%" fill="url(#grid)" />
      </svg>
    </div>
  )
}

// Scroll-triggered animation hook
function useScrollAnimation() {
  const [scrollY, setScrollY] = useState(0)

  useEffect(() => {
    const handleScroll = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  return scrollY
}

export default function EnhancedLandingPage() {
  const [isScrolled, setIsScrolled] = useState(false)
  const [hoveredCard, setHoveredCard] = useState<number | null>(null)
  const scrollY = useScrollAnimation()
  const heroRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  const parallaxOffset = scrollY * 0.5

  return (
    <div className="min-h-screen bg-[#07070F] text-[#EDE9E1] font-[Outfit,sans-serif] overflow-hidden">
      {/* Animated background layers */}
      <FoundationGrid />
      <div
        className="fixed inset-0 pointer-events-none z-0"
        style={{
          background: 'radial-gradient(ellipse 60% 40% at 50% 0%, rgba(249,115,22,0.08), transparent)',
          transform: `translateY(${parallaxOffset}px)`,
        }}
      />

      {/* Fixed header - becomes compact on scroll */}
      <header
        className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
          isScrolled
            ? 'bg-[#07070F]/95 backdrop-blur-xl border-b border-[#2A2844] py-3'
            : 'bg-transparent py-5'
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          {/* Logo with animation */}
          <a href="/" className="flex items-center gap-3 group">
            <div className={`transition-all duration-300 ${isScrolled ? 'w-8 h-8' : 'w-10 h-10'} rounded-xl bg-[#F97316] flex items-center justify-center shadow-[0_0_20px_rgba(249,115,22,0.4)] group-hover:shadow-[0_0_30px_rgba(249,115,22,0.6)]`}>
              <AnimatedTBolt size={isScrolled ? 16 : 20} variant="white" />
            </div>
            <div>
              <div className="flex items-center gap-1 leading-none">
                <span className="text-[#EDE9E1] font-bold text-lg tracking-tight">tinai</span>
                <span className="text-[#4A4760] text-sm font-light">.cloud</span>
              </div>
              <p className="text-[8px] text-[#4A4760] mt-0.5 font-medium uppercase tracking-widest">
                The Nuts & Bolts of Cloud
              </p>
            </div>
          </a>

          {/* Navigation */}
          <nav className="hidden lg:flex items-center gap-1">
            {NAV_LINKS.map(({ href, label }) => (
              <a
                key={href}
                href={href}
                className="px-4 py-2 rounded-lg text-sm text-[#8C89A4] hover:text-[#EDE9E1] hover:bg-[#14142A] transition-all duration-200"
              >
                {label}
              </a>
            ))}
          </nav>

          {/* CTA buttons */}
          <div className="flex items-center gap-3">
            <a
              href="/login"
              className="hidden sm:block px-4 py-2 rounded-lg text-sm text-[#8C89A4] hover:text-[#EDE9E1] transition-colors"
            >
              Sign in
            </a>
            <a
              href="/login?register=true"
              className="px-5 py-2 rounded-lg bg-[#F97316] hover:bg-[#EA6C0A] text-white text-sm font-semibold transition-all duration-200 shadow-[0_0_16px_rgba(249,115,22,0.3)] hover:shadow-[0_0_24px_rgba(249,115,22,0.5)] hover:-translate-y-px"
            >
              Get Started Free
            </a>
          </div>
        </div>
      </header>

      {/* Hero Section - Interactive "Building Blocks" Theme */}
      <section ref={heroRef} className="relative pt-32 pb-24 px-6" style={{ transform: `translateY(${parallaxOffset * -0.5}px)` }}>
        <div className="max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Left: Content */}
            <div className="space-y-6 z-10 relative">
              {/* Status badge with pulse */}
              <div className="inline-flex items-center gap-2 rounded-full border border-[#F97316]/30 bg-[#F97316]/10 backdrop-blur-sm px-4 py-2 text-sm text-[#F97316] font-medium">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#F97316] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#F97316]" />
                </span>
                Now Live · Powering India's Cloud Infrastructure
              </div>

              <h1 className="text-6xl sm:text-7xl font-bold tracking-tight text-[#EDE9E1] leading-[1.1]">
                The
                <br />
                <span className="relative inline-block">
                  <span className="bg-gradient-to-r from-[#F97316] via-[#FDBA74] to-[#F97316] bg-clip-text text-transparent animate-gradient-x">
                    Nuts & Bolts
                  </span>
                  <svg className="absolute -bottom-2 left-0 w-full h-3" viewBox="0 0 200 10" preserveAspectRatio="none">
                    <path d="M0,5 Q50,0 100,5 T200,5" fill="none" stroke="#F97316" strokeWidth="2" opacity="0.3" />
                  </svg>
                </span>
                <br />
                of Cloud
              </h1>

              <p className="text-2xl font-semibold text-[#8C89A4] mb-2">
                India&apos;s Sovereign Cloud Platform
              </p>
              <p className="text-base text-[#F97316] font-medium tracking-wide mb-4">
                Built on Open Source. Managed for India.
              </p>

              <p className="text-xl text-[#8C89A4] max-w-xl leading-relaxed">
                Ready-to-use GPU environments, managed infrastructure, AI inference, and serverless functions.
                <span className="text-[#F97316] font-semibold"> Plug and play, not bare metal.</span> Your data never leaves India.
              </p>

              {/* CTA buttons */}
              <div className="flex flex-wrap items-center gap-4 pt-4">
                <a
                  href="/login?register=true"
                  className="group inline-flex items-center gap-3 px-8 py-4 rounded-xl bg-[#F97316] hover:bg-[#EA6C0A] text-white font-bold text-base transition-all duration-200 shadow-[0_0_30px_rgba(249,115,22,0.4)] hover:shadow-[0_0_40px_rgba(249,115,22,0.6)] hover:-translate-y-1 hover:scale-105"
                >
                  Start Building
                  <svg className="w-5 h-5 group-hover:translate-x-1 transition-transform" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
                  </svg>
                </a>
                <a
                  href="/docs"
                  className="inline-flex items-center gap-3 px-8 py-4 rounded-xl border-2 border-[#2A2844] hover:border-[#F97316]/40 bg-[#0E0E1C]/60 backdrop-blur-sm hover:bg-[#14142A]/80 text-[#8C89A4] hover:text-[#EDE9E1] font-bold text-base transition-all duration-200 hover:-translate-y-1"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Read Docs
                </a>
              </div>

              {/* Trust indicators */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-6 text-xs text-[#4A4760]">
                {[
                  { icon: 'M5 13l4 4L19 7', text: 'No credit card required' },
                  { icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z', text: 'Free tier available' },
                  { icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z', text: 'Data stays in India' },
                  { icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z', text: 'Cancel anytime' },
                ].map(({ icon, text }) => (
                  <span key={text} className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-[#F97316]" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
                    </svg>
                    {text}
                  </span>
                ))}
              </div>
            </div>

            {/* Right: Interactive Infrastructure Visual */}
            <div className="relative h-[500px] hidden lg:block">
              {/* Central animated T-bolt */}
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                <AnimatedTBolt size={120} className="drop-shadow-[0_0_40px_rgba(249,115,22,0.6)]" />
              </div>

              {/* Orbiting "building blocks" */}
              {[
                { label: 'GPU', color: 'violet', angle: 0, radius: 140 },
                { label: 'Storage', color: 'sky', angle: 60, radius: 140 },
                { label: 'AI', color: 'orange', angle: 120, radius: 140 },
                { label: 'Functions', color: 'amber', angle: 180, radius: 140 },
                { label: 'Gateway', color: 'rose', angle: 240, radius: 140 },
                { label: 'Tenants', color: 'indigo', angle: 300, radius: 140 },
              ].map(({ label, color, angle, radius }, i) => (
                <div
                  key={label}
                  className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
                  style={{
                    transform: `translate(-50%, -50%) rotate(${angle + scrollY / 10}deg) translateY(-${radius}px) rotate(-${angle + scrollY / 10}deg)`,
                    animation: 'float 3s ease-in-out infinite',
                    animationDelay: `${i * 0.5}s`,
                  }}
                >
                  <div className={`px-4 py-2 rounded-lg bg-${color}-950/80 border border-${color}-800/60 backdrop-blur-sm`}>
                    <span className={`text-xs font-semibold text-${color}-400`}>{label}</span>
                  </div>
                  {/* Connection line to center */}
                  <div
                    className={`absolute top-1/2 left-1/2 w-0.5 bg-gradient-to-b from-${color}-500 to-transparent`}
                    style={{
                      height: `${radius}px`,
                      transform: `translate(-50%, -50%) rotate(${-angle - scrollY / 10 + 180}deg)`,
                      transformOrigin: 'top',
                      opacity: 0.3,
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features Section - Interactive Cards */}
      <section id="features" className="relative py-24 px-6 border-t border-[#2A2844]">
        <div className="max-w-7xl mx-auto">
          <div className="mb-16 text-center space-y-3">
            <p className="text-sm font-bold uppercase tracking-widest text-[#F97316]">Platform Components</p>
            <h2 className="text-5xl font-bold text-[#EDE9E1]">Everything you need to build</h2>
            <p className="text-[#8C89A4] text-lg max-w-2xl mx-auto">
              Nine core products, one platform, zero vendor lock-in. Built on open-source foundations.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {PRODUCT_CARDS.map((card, idx) => (
              <Link
                key={card.title}
                href={`/features/${card.slug}`}
                className={`relative overflow-hidden rounded-2xl border bg-[#0E0E1C] p-8 group cursor-pointer transition-all duration-500 block ${
                  hoveredCard === idx
                    ? 'border-[#F97316]/40 scale-105 shadow-[0_0_40px_rgba(249,115,22,0.2)]'
                    : 'border-[#2A2844] hover:border-[#F97316]/20'
                }`}
                onMouseEnter={() => setHoveredCard(idx)}
                onMouseLeave={() => setHoveredCard(null)}
                style={{
                  animation: `fadeInUp 0.6s ease-out ${idx * 0.1}s both`,
                }}
              >
                {/* Glow effect */}
                <div className={`absolute top-0 left-0 w-40 h-40 bg-gradient-to-br ${card.glowColor} to-transparent rounded-tl-2xl transition-opacity duration-500 ${hoveredCard === idx ? 'opacity-100' : 'opacity-40'}`} />

                {/* Content */}
                <div className="relative space-y-5">
                  <div className="flex items-start justify-between">
                    <div className="w-14 h-14 rounded-xl bg-[#14142A] flex items-center justify-center group-hover:scale-110 group-hover:rotate-6 transition-all duration-500">
                      <svg className={`w-7 h-7 ${card.iconColor}`} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" d={card.icon} />
                      </svg>
                    </div>
                    <span className={`text-xs font-semibold px-3 py-1 rounded-full border ${card.badgeColor}`}>
                      {card.badge}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-xl font-bold text-[#EDE9E1] mb-2 group-hover:text-[#F97316] transition-colors">
                      {card.title}
                    </h3>
                    <p className="text-sm text-[#8C89A4] leading-relaxed">
                      {card.desc}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2 pt-2">
                    {card.pills.map(pill => (
                      <span
                        key={pill}
                        className="text-xs text-[#4A4760] bg-[#14142A] border border-[#2A2844] rounded-lg px-3 py-1.5 font-mono group-hover:border-[#F97316]/20 group-hover:text-[#8C89A4] transition-all"
                      >
                        {pill}
                      </span>
                    ))}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="relative py-24 px-6 border-t border-[#2A2844]">
        <div className="max-w-5xl mx-auto">
          <div className="mb-16 text-center space-y-3">
            <p className="text-sm font-bold uppercase tracking-widest text-[#F97316]">Transparent Pricing</p>
            <h2 className="text-5xl font-bold text-[#EDE9E1]">Pay only for what you use</h2>
            <p className="text-[#8C89A4] text-lg">Simple pricing. No hidden fees. All in INR.</p>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            {[
              { label: 'GPU Instances', price: '₹89/hr', unit: 'RTX 4090 · 24 GB VRAM', icon: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18', color: 'violet', extra: 'A100 from ₹280/hr · H100 from ₹520/hr' },
              { label: 'Object Storage', price: '₹2/GB-mo', unit: 'MinIO S3-compatible', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4', color: 'sky', extra: 'PostgreSQL from ₹8/GB-month' },
              { label: 'AI Inference', price: '₹0.01/1K', unit: 'Sarvam 2B · fastest', icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z', color: 'orange', extra: 'Claude Sonnet from ₹2.40/1K tokens' },
            ].map(p => (
              <div
                key={p.label}
                className={`rounded-2xl border border-${p.color}-800/40 bg-${p.color}-950/10 backdrop-blur-sm p-8 space-y-5 hover:scale-105 hover:shadow-[0_0_30px_rgba(249,115,22,0.15)] transition-all duration-300 cursor-pointer`}
              >
                <div className="w-12 h-12 rounded-xl bg-[#14142A] flex items-center justify-center">
                  <svg className={`w-6 h-6 text-${p.color}-400`} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d={p.icon} />
                  </svg>
                </div>
                <div>
                  <p className="text-xs text-[#4A4760] uppercase tracking-wider font-bold mb-2">{p.label}</p>
                  <p className={`text-3xl font-bold text-${p.color}-400`}>
                    <span className="text-sm font-normal text-[#4A4760]">From </span>{p.price}
                  </p>
                  <p className="text-xs text-[#8C89A4] mt-1">{p.unit}</p>
                </div>
                <p className="text-xs text-[#8C89A4] border-t border-[#2A2844]/60 pt-4">{p.extra}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Powered by Open Source Section */}
      <section id="open-source" className="relative py-24 px-6 border-t border-[#2A2844]">
        <div className="max-w-7xl mx-auto">
          <div className="mb-16 text-center space-y-3">
            <p className="text-sm font-bold uppercase tracking-widest text-[#F97316]">Transparency</p>
            <h2 className="text-5xl font-bold text-[#EDE9E1]">Powered by Open Source</h2>
            <p className="text-[#8C89A4] text-lg max-w-3xl mx-auto">
              We build on the shoulders of giants. Tinai customizes and manages battle-tested open-source projects for Indian data sovereignty — so you don&apos;t have to.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
            {[
              {
                category: 'Compute',
                icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2',
                color: 'violet',
                components: ['k3s', 'Knative'],
                value: 'Managed Kubernetes with GPU scheduling, serverless scale-to-zero',
              },
              {
                category: 'Storage',
                icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
                color: 'sky',
                components: ['PostgreSQL (CloudNativePG)', 'MinIO', 'Redis'],
                value: 'HA Postgres with point-in-time recovery, S3-compatible storage on Indian infrastructure',
              },
              {
                category: 'Security',
                icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
                color: 'emerald',
                components: ['Kyverno', 'HashiCorp Vault', 'Falco'],
                value: 'Policy-as-code enforcement, automated secret rotation, eBPF runtime threat detection',
              },
              {
                category: 'Git & CI/CD',
                icon: 'M13 7h8m0 0v8m0-8l-8 8-4-4-6 6',
                color: 'orange',
                components: ['Forgejo', 'Woodpecker CI'],
                value: 'Self-hosted git with zero-config builds — git push to deploy',
              },
              {
                category: 'Observability',
                icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
                color: 'amber',
                components: ['Prometheus', 'Grafana', 'Loki'],
                value: 'Integrated dashboards, 30-day log retention, alerting',
              },
            ].map((item) => (
              <div
                key={item.category}
                className={`rounded-2xl border border-${item.color}-800/40 bg-[#0E0E1C] p-8 space-y-4 hover:border-[#F97316]/30 hover:shadow-[0_0_30px_rgba(249,115,22,0.1)] transition-all duration-300`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-[#14142A] flex items-center justify-center">
                    <svg className={`w-6 h-6 text-${item.color}-400`} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                    </svg>
                  </div>
                  <h3 className="text-xl font-bold text-[#EDE9E1]">{item.category}</h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {item.components.map((comp) => (
                    <span
                      key={comp}
                      className={`text-xs text-${item.color}-400 bg-${item.color}-950/50 border border-${item.color}-800/50 rounded-lg px-3 py-1.5 font-mono`}
                    >
                      {comp}
                    </span>
                  ))}
                </div>
                <div className="border-t border-[#2A2844]/60 pt-4">
                  <p className="text-xs text-[#4A4760] uppercase tracking-wider font-bold mb-1">What Tinai adds</p>
                  <p className="text-sm text-[#8C89A4] leading-relaxed">{item.value}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Built on Tinai — Dogfooding Section */}
      <section id="built-on-tinai" className="relative py-24 px-6 border-t border-[#2A2844]">
        <div className="max-w-7xl mx-auto">
          <div className="mb-16 text-center space-y-3">
            <p className="text-sm font-bold uppercase tracking-widest text-[#F97316]">Dogfooding</p>
            <h2 className="text-5xl font-bold text-[#EDE9E1]">Built on Tinai</h2>
            <p className="text-[#8C89A4] text-lg max-w-2xl mx-auto">
              Every app we build runs on our own platform. No exceptions. No external cloud.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[
              { name: 'Larun', desc: 'AI-powered astronomical data analysis', tech: 'Python, TFLite' },
              { name: 'Larun SE', desc: 'Systems engineering (ECSS/DRD) tool', tech: 'Next.js, PostgreSQL' },
              { name: 'Larun Space', desc: 'Satellite tracking & orbital analysis', tech: 'JavaScript, PostGIS' },
              { name: 'LarunEng.com', desc: 'Engineering courses & certification exams', tech: 'Next.js, Prisma' },
              { name: 'COLL', desc: 'Team collaboration platform', tech: 'Next.js, LiveKit, WebSocket' },
              { name: 'Safety Forge', desc: 'HAZOP & SIL safety analysis', tech: 'TypeScript, Vite' },
              { name: 'SatTrack', desc: 'Real-time satellite visualization', tech: 'Three.js, WebGL' },
              { name: 'Astro Data', desc: 'Astronomy learning & discovery platform', tech: 'Next.js' },
              { name: 'Larun LMS', desc: 'Learning management system', tech: 'Next.js' },
              { name: 'LarunEng Website', desc: 'Engineering community hub', tech: 'JavaScript' },
            ].map((app) => (
              <div
                key={app.name}
                className="rounded-2xl border border-[#2A2844] bg-[#0E0E1C] p-6 space-y-3 hover:border-[#F97316]/30 hover:shadow-[0_0_20px_rgba(249,115,22,0.1)] transition-all duration-300"
              >
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-[#14142A] flex items-center justify-center">
                    <AnimatedTBolt size={14} />
                  </div>
                  <h3 className="text-base font-bold text-[#EDE9E1]">{app.name}</h3>
                </div>
                <p className="text-sm text-[#8C89A4] leading-relaxed">{app.desc}</p>
                <span className="inline-block text-xs text-[#4A4760] bg-[#14142A] border border-[#2A2844] rounded-lg px-3 py-1 font-mono">
                  {app.tech}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Enhanced Footer */}
      <footer className="relative border-t border-[#2A2844] py-16 px-6 mt-24">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-12 mb-12">
            {/* Brand */}
            <div className="lg:col-span-2 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#F97316] flex items-center justify-center shadow-[0_0_20px_rgba(249,115,22,0.4)]">
                  <AnimatedTBolt size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-1 leading-none">
                    <span className="text-[#EDE9E1] font-bold text-xl tracking-tight">tinai</span>
                    <span className="text-[#4A4760] text-base font-light">.cloud</span>
                  </div>
                  <p className="text-[9px] text-[#4A4760] mt-1 font-medium uppercase tracking-widest">
                    The Nuts & Bolts of Cloud
                  </p>
                </div>
              </div>
              <p className="text-sm text-[#8C89A4] max-w-xs leading-relaxed">
                India's sovereign cloud platform. GPU compute, AI inference, and serverless functions — all in one place.
              </p>
              <div className="flex items-center gap-2 pt-2">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#F97316] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[#F97316]" />
                </span>
                <a href="/status" className="text-xs text-[#F97316] hover:text-[#FDBA74] transition-colors">
                  All systems operational
                </a>
              </div>
            </div>

            {/* Product */}
            <div>
              <h4 className="text-sm font-bold text-[#EDE9E1] mb-4">Product</h4>
              <ul className="space-y-2.5 text-sm text-[#8C89A4]">
                {['Features', 'Pricing', 'Docs', 'API', 'CLI', 'Changelog'].map(item => (
                  <li key={item}>
                    <a href={`/${item.toLowerCase()}`} className="hover:text-[#EDE9E1] transition-colors">{item}</a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Company */}
            <div>
              <h4 className="text-sm font-bold text-[#EDE9E1] mb-4">Company</h4>
              <ul className="space-y-2.5 text-sm text-[#8C89A4]">
                {['About', 'Blog', 'Careers', 'Contact', 'Partners'].map(item => (
                  <li key={item}>
                    <a href={`/${item.toLowerCase()}`} className="hover:text-[#EDE9E1] transition-colors">{item}</a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Legal */}
            <div>
              <h4 className="text-sm font-bold text-[#EDE9E1] mb-4">Legal</h4>
              <ul className="space-y-2.5 text-sm text-[#8C89A4]">
                {['Privacy', 'Terms', 'Security', 'Compliance', 'Status'].map(item => (
                  <li key={item}>
                    <a href={`/${item.toLowerCase()}`} className="hover:text-[#EDE9E1] transition-colors">{item}</a>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Transparency note */}
          <div className="mb-8 text-center">
            <p className="text-xs text-[#4A4760] leading-relaxed max-w-2xl mx-auto">
              Tinai is proudly built on open-source software. We believe in transparency, Indian data sovereignty, and giving back to the community.
            </p>
          </div>

          {/* Bottom bar */}
          <div className="pt-8 border-t border-[#2A2844] flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[#4A4760]">
            <p>© 2026 tinai.cloud · India Sovereign PaaS · Built with 🧡 in India</p>
            <div className="flex items-center gap-5">
              {['GitHub', 'Twitter', 'Discord', 'LinkedIn'].map(social => (
                <a key={social} href={`https://${social.toLowerCase()}.com`} className="hover:text-[#8C89A4] transition-colors">
                  {social}
                </a>
              ))}
            </div>
          </div>
        </div>
      </footer>

      {/* Scroll to top button */}
      {isScrolled && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          className="fixed bottom-8 right-8 w-12 h-12 rounded-xl bg-[#F97316] hover:bg-[#EA6C0A] text-white flex items-center justify-center shadow-[0_0_24px_rgba(249,115,22,0.4)] hover:shadow-[0_0_32px_rgba(249,115,22,0.6)] transition-all duration-200 hover:-translate-y-1 z-50"
          aria-label="Scroll to top"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
          </svg>
        </button>
      )}

      <style jsx>{`
        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(30px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes float {
          0%, 100% { transform: translate(-50%, -50%) translateY(0); }
          50% { transform: translate(-50%, -50%) translateY(-10px); }
        }

        @keyframes gradient-x {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }

        .animate-gradient-x {
          background-size: 200% 200%;
          animation: gradient-x 3s ease infinite;
        }

        .animate-spin-slow {
          animation: spin 8s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
