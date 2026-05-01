import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./components/Nav";

export const metadata: Metadata = {
  title: { default: "Tinai Developer Portal", template: "%s | Tinai" },
  description:
    "Build with India's sovereign AI platform. APIs for agriculture, education, language, and skills — built for Bharat.",
  metadataBase: new URL("https://dev.tinai.cloud"),
  openGraph: {
    siteName: "Tinai Developer Portal",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen">
        <Nav />
        <main>{children}</main>
        <footer className="border-t border-[var(--border)] mt-24 py-10">
          <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-[var(--muted)]">
            <span>© 2025 Tinai Technologies Pvt Ltd · Made in Bharat</span>
            <div className="flex gap-6">
              <a href="/docs" className="hover:text-white transition-colors">Docs</a>
              <a href="/explorer" className="hover:text-white transition-colors">API Explorer</a>
              <a href="https://git.tinai.cloud" className="hover:text-white transition-colors">Forgejo</a>
              <a href="mailto:dev@tinai.cloud" className="hover:text-white transition-colors">Contact</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
