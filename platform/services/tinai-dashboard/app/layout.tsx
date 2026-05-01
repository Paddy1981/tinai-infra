import type { Metadata } from 'next'
import './globals.css'
import AISidebar from './components/AISidebar'
import AppShell from './components/AppShell'
import { ProjectProvider } from './context/ProjectContext'
import { ThemeProvider } from './context/ThemeContext'

export const metadata: Metadata = {
  title: 'Tinai Cloud',
  description: 'India Sovereign Cloud Platform',
  icons: {
    icon: '/brand/tinai-app-icon.svg',
    apple: '/brand/tinai-app-icon.svg',
    shortcut: '/brand/tinai-app-icon.svg',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap"
        />
      </head>
      <body className="min-h-screen tech-grid">
        <ThemeProvider>
          <ProjectProvider>
            <AppShell>{children}</AppShell>
            <AISidebar />
          </ProjectProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
