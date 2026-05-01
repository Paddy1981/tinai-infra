"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/docs", label: "Docs" },
  { href: "/explorer", label: "API Explorer" },
  { href: "/keys", label: "API Keys" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-50 border-b border-[var(--border)] bg-[var(--background)]/90 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-semibold text-white">
          <span className="text-[var(--accent)] text-lg">◈</span>
          <span>tinai</span>
          <span className="text-[var(--muted)] font-normal text-sm">/ dev</span>
        </Link>

        <div className="flex items-center gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                pathname.startsWith(l.href)
                  ? "bg-[var(--accent)]/10 text-[var(--accent-hover)]"
                  : "text-[var(--muted)] hover:text-white"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <a
            href="https://git.tinai.cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 px-3 py-1.5 rounded-md text-sm bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
          >
            Get Key
          </a>
        </div>
      </div>
    </nav>
  );
}
