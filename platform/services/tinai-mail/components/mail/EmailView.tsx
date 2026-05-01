"use client";

import { useEffect, useState } from "react";
import {
  Reply,
  Forward,
  Trash2,
  Mail,
  MailOpen,
  ArrowLeft,
  Loader2,
} from "lucide-react";

interface EmailDetail {
  id: string;
  from: { name?: string; email: string }[] | null;
  to: { name?: string; email: string }[] | null;
  cc: { name?: string; email: string }[] | null;
  bcc: { name?: string; email: string }[] | null;
  subject: string | null;
  receivedAt: string;
  sentAt: string | null;
  keywords: Record<string, boolean> | null;
  hasAttachment: boolean;
  bodyValues: Record<string, { value: string }>;
  htmlBody: { partId: string }[];
  textBody: { partId: string }[];
}

interface EmailViewProps {
  emailId: string | null;
  onReply: (email: EmailDetail) => void;
  onForward: (email: EmailDetail) => void;
  onBack: () => void;
}

function formatAddr(addr: { name?: string; email: string }): string {
  return addr.name ? `${addr.name} <${addr.email}>` : addr.email;
}

/** Strip dangerous HTML elements and attributes to prevent XSS */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[\s\S]*?>/gi, '')
    .replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    .replace(/href\s*=\s*["']?\s*javascript:/gi, 'href="')
    .replace(/src\s*=\s*["']?\s*javascript:/gi, 'src="')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<input[\s\S]*?>/gi, '')
    .replace(/<button[\s\S]*?<\/button>/gi, '')
}

function formatFullDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EmailView({
  emailId,
  onReply,
  onForward,
  onBack,
}: EmailViewProps) {
  const [email, setEmail] = useState<EmailDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!emailId) {
      setEmail(null);
      return;
    }

    setLoading(true);
    setError("");

    fetch(`/api/jmap/emails/${emailId}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setEmail(data.email);
        }
      })
      .catch(() => setError("Failed to load email"))
      .finally(() => setLoading(false));
  }, [emailId]);

  if (!emailId) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--outline)] text-sm">
        Select an email to read
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-[var(--primary)]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--error)] text-sm">
        {error}
      </div>
    );
  }

  if (!email) return null;

  // Get body HTML or text
  let bodyHtml = "";
  let bodyText = "";

  if (email.htmlBody?.length && email.bodyValues) {
    const partId = email.htmlBody[0].partId;
    bodyHtml = email.bodyValues[partId]?.value || "";
  }
  if (email.textBody?.length && email.bodyValues) {
    const partId = email.textBody[0].partId;
    bodyText = email.bodyValues[partId]?.value || "";
  }

  async function handleDelete() {
    try {
      const res = await fetch(`/api/jmap/emails/${emailId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permanent: false }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || "Delete failed");
        return;
      }
      onBack();
    } catch {
      alert("Failed to delete email");
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Action bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-[var(--outline)]/10 shrink-0">
        <button
          onClick={onBack}
          className="p-2 rounded-lg hover:bg-[var(--primary)]/5 text-[var(--outline)] sm:hidden"
          title="Back"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => onReply(email)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-[var(--primary)]/5 text-[var(--on-surface)]/70 text-sm"
        >
          <Reply className="w-4 h-4" />
          Reply
        </button>
        <button
          onClick={() => onForward(email)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-[var(--primary)]/5 text-[var(--on-surface)]/70 text-sm"
        >
          <Forward className="w-4 h-4" />
          Forward
        </button>
        <button
          onClick={handleDelete}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-red-50 text-[var(--on-surface)]/70 text-sm"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </button>
      </div>

      {/* Email header */}
      <div className="px-6 py-4 border-b border-[var(--outline)]/10 shrink-0">
        <h2 className="text-lg font-semibold text-[var(--on-surface)] mb-3">
          {email.subject || "(No subject)"}
        </h2>

        <div className="space-y-1.5 text-sm">
          <div className="flex gap-2">
            <span className="text-[var(--outline)] w-12 shrink-0">From</span>
            <span className="text-[var(--on-surface)]">
              {email.from?.map(formatAddr).join(", ") || "Unknown"}
            </span>
          </div>
          <div className="flex gap-2">
            <span className="text-[var(--outline)] w-12 shrink-0">To</span>
            <span className="text-[var(--on-surface)]/70">
              {email.to?.map(formatAddr).join(", ") || ""}
            </span>
          </div>
          {email.cc?.length ? (
            <div className="flex gap-2">
              <span className="text-[var(--outline)] w-12 shrink-0">Cc</span>
              <span className="text-[var(--on-surface)]/70">
                {email.cc.map(formatAddr).join(", ")}
              </span>
            </div>
          ) : null}
          <div className="flex gap-2">
            <span className="text-[var(--outline)] w-12 shrink-0">Date</span>
            <span className="text-[var(--on-surface)]/70">
              {formatFullDate(email.receivedAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {bodyHtml ? (
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(bodyHtml) }}
          />
        ) : (
          <pre className="whitespace-pre-wrap text-sm text-[var(--on-surface)]/80 font-sans">
            {bodyText}
          </pre>
        )}
      </div>
    </div>
  );
}
