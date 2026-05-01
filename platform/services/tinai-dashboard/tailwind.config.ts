import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brand — Tinai Saffron
        'primary':                  '#F97316',
        'primary-container':        '#C2410C',
        'on-primary':               '#FDBA74',
        // Surfaces — Night palette
        'surface':                  '#07070F',
        'surface-dim':              '#07070F',
        'surface-bright':           '#1C1C38',
        'surface-container-lowest': '#0E0E1C',
        'surface-container-low':    '#14142A',
        'surface-container':        '#1C1C38',
        'surface-container-high':   '#242440',
        'surface-container-highest':'#2C2C4A',
        'surface-variant':          '#1C1C38',
        // Text
        'on-surface':               '#EDE9E1',
        'on-surface-variant':       '#8C89A4',
        // Outline
        'outline':                  '#4A4760',
        'outline-variant':          '#2A2844',
        // Semantic
        'background':               '#07070F',
        'on-background':            '#EDE9E1',
        'error':                    '#F87171',
        'secondary':                '#A78BFA',
        'tertiary':                 '#34D399',
      },
      fontFamily: {
        headline: ['Outfit', 'sans-serif'],
        body:     ['Outfit', 'sans-serif'],
        label:    ['Outfit', 'sans-serif'],
        mono:     ['JetBrains Mono', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '0.25rem',
        lg:      '0.5rem',
        xl:      '0.75rem',
        '2xl':   '1rem',
        full:    '9999px',
      },
      animation: {
        'spin-slow': 'spin 8s linear infinite',
      },
    },
  },
  plugins: [],
}

export default config
