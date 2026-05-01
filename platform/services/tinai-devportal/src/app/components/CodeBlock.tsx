// Server Component — Shiki runs at build/request time, output is sanitized HTML.
// dangerouslySetInnerHTML is safe here: we never pass user content to codeToHtml.
import { codeToHtml } from "shiki";

interface Props {
  code: string;
  lang: string;
  filename?: string;
}

export async function CodeBlock({ code, lang, filename }: Props) {
  const html = await codeToHtml(code.trim(), {
    lang,
    theme: "github-dark-dimmed",
  });

  return (
    <div className="rounded-lg overflow-hidden border border-[var(--border)]">
      {filename ? (
        <div className="flex items-center gap-2 px-4 py-2 bg-[#0d0d18] border-b border-[var(--border)] text-xs text-[var(--muted)]">
          <span className="text-[var(--accent)]">◈</span>
          {filename}
        </div>
      ) : null}
      <div
        className="text-sm [&>pre]:!bg-[#0d0d18] [&>pre]:p-4 [&>pre]:overflow-x-auto"
        // Safe: Shiki is a server-side syntax highlighter, not user-controlled input
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
