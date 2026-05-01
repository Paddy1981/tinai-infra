"use client";

import {
  Inbox,
  Send,
  FileEdit,
  Trash2,
  AlertOctagon,
  Folder,
} from "lucide-react";

interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
}

const ROLE_ICONS: Record<string, any> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileEdit,
  trash: Trash2,
  junk: AlertOctagon,
};

const ROLE_ORDER = ["inbox", "drafts", "sent", "trash", "junk"];

function sortMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return [...mailboxes].sort((a, b) => {
    const aIdx = a.role ? ROLE_ORDER.indexOf(a.role) : ROLE_ORDER.length;
    const bIdx = b.role ? ROLE_ORDER.indexOf(b.role) : ROLE_ORDER.length;
    if (aIdx !== bIdx) return aIdx - bIdx;
    return a.name.localeCompare(b.name);
  });
}

interface FolderListProps {
  mailboxes: Mailbox[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function FolderList({
  mailboxes,
  selectedId,
  onSelect,
}: FolderListProps) {
  const sorted = sortMailboxes(mailboxes);

  return (
    <nav className="py-2">
      {sorted.map((mb) => {
        const Icon = (mb.role && ROLE_ICONS[mb.role]) || Folder;
        const isActive = mb.id === selectedId;

        return (
          <button
            key={mb.id}
            onClick={() => onSelect(mb.id)}
            className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
              isActive
                ? "bg-[var(--primary)]/10 text-[var(--primary)] font-medium"
                : "text-[var(--on-surface)]/70 hover:bg-[var(--primary)]/5"
            }`}
          >
            <Icon className="w-4 h-4 shrink-0" />
            <span className="truncate flex-1 text-left">{mb.name}</span>
            {mb.unreadEmails > 0 && (
              <span className="text-xs font-semibold bg-[var(--primary)] text-white rounded-full px-1.5 py-0.5 min-w-[20px] text-center">
                {mb.unreadEmails}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
