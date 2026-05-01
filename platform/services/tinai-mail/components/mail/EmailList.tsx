"use client";

import { Paperclip } from "lucide-react";

interface EmailSummary {
  id: string;
  from: { name?: string; email: string }[] | null;
  subject: string | null;
  preview: string;
  receivedAt: string;
  keywords: Record<string, boolean> | null;
  hasAttachment: boolean;
}

interface EmailListProps {
  emails: EmailSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}

function getInitials(from: EmailSummary["from"]): string {
  if (!from?.length) return "?";
  const name = from[0].name || from[0].email;
  const parts = name.split(/[\s@.]+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function getSenderName(from: EmailSummary["from"]): string {
  if (!from?.length) return "Unknown";
  return from[0].name || from[0].email;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: "short" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function EmailList({
  emails,
  selectedId,
  onSelect,
  loading,
}: EmailListProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--outline)] text-sm">
        Loading emails...
      </div>
    );
  }

  if (!emails.length) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--outline)] text-sm">
        No emails in this folder
      </div>
    );
  }

  return (
    <div className="overflow-y-auto h-full">
      {emails.map((email) => {
        const isUnread = !email.keywords?.["$seen"];
        const isSelected = email.id === selectedId;

        return (
          <button
            key={email.id}
            onClick={() => onSelect(email.id)}
            className={`w-full text-left px-4 py-3 border-b border-[var(--outline)]/10 transition-colors ${
              isSelected
                ? "bg-[var(--primary)]/8"
                : "hover:bg-[var(--primary)]/4"
            }`}
          >
            <div className="flex items-start gap-3">
              {/* Avatar */}
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold shrink-0 ${
                  isUnread
                    ? "bg-[var(--primary)] text-white"
                    : "bg-[var(--outline)]/15 text-[var(--outline)]"
                }`}
              >
                {getInitials(email.from)}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`text-sm truncate ${
                      isUnread ? "font-semibold text-[var(--on-surface)]" : "text-[var(--on-surface)]/70"
                    }`}
                  >
                    {getSenderName(email.from)}
                  </span>
                  <span className="text-xs text-[var(--outline)] shrink-0">
                    {formatDate(email.receivedAt)}
                  </span>
                </div>

                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-sm truncate ${
                      isUnread ? "font-medium text-[var(--on-surface)]" : "text-[var(--on-surface)]/60"
                    }`}
                  >
                    {email.subject || "(No subject)"}
                  </span>
                  {email.hasAttachment && (
                    <Paperclip className="w-3 h-3 text-[var(--outline)] shrink-0" />
                  )}
                </div>

                <p className="text-xs text-[var(--outline)] truncate mt-0.5">
                  {email.preview}
                </p>
              </div>

              {/* Unread dot */}
              {isUnread && (
                <div className="w-2 h-2 rounded-full bg-[var(--primary)] mt-1.5 shrink-0" />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
