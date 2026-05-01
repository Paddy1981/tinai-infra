"use client";

import { useEffect, useState, useCallback } from "react";
import { PenSquare, RefreshCw, Search, X } from "lucide-react";
import { FolderList } from "@/components/mail/FolderList";
import { EmailList } from "@/components/mail/EmailList";
import { EmailView } from "@/components/mail/EmailView";
import { ComposeModal } from "@/components/mail/ComposeModal";

interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
}

interface EmailSummary {
  id: string;
  from: { name?: string; email: string }[] | null;
  subject: string | null;
  preview: string;
  receivedAt: string;
  keywords: Record<string, boolean> | null;
  hasAttachment: boolean;
}

export default function MailPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [selectedMailbox, setSelectedMailbox] = useState<string | null>(null);
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [loadingEmails, setLoadingEmails] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [composeDefaults, setComposeDefaults] = useState<{
    to?: string;
    subject?: string;
    body?: string;
  }>({});
  const [mobileView, setMobileView] = useState<
    "folders" | "list" | "detail"
  >("folders");
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<EmailSummary[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchActive, setSearchActive] = useState(false);

  // Load mailboxes on mount
  useEffect(() => {
    fetchMailboxes();
  }, []);

  async function fetchMailboxes() {
    try {
      const res = await fetch("/api/jmap/mailboxes");
      const data = await res.json();
      if (data.mailboxes) {
        setMailboxes(data.mailboxes);
        // Auto-select inbox
        const inbox = data.mailboxes.find(
          (m: Mailbox) => m.role === "inbox"
        );
        if (inbox && !selectedMailbox) {
          setSelectedMailbox(inbox.id);
        }
      }
    } catch (err) {
      console.error("Failed to load mailboxes:", err);
    }
  }

  // Load emails when mailbox changes
  useEffect(() => {
    if (!selectedMailbox) return;
    fetchEmails(selectedMailbox);
  }, [selectedMailbox]);

  async function fetchEmails(mailboxId: string) {
    setLoadingEmails(true);
    try {
      const res = await fetch(
        `/api/jmap/emails?mailboxId=${encodeURIComponent(mailboxId)}`
      );
      const data = await res.json();
      if (data.emails) {
        setEmails(data.emails);
      }
    } catch (err) {
      console.error("Failed to load emails:", err);
    } finally {
      setLoadingEmails(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await fetchMailboxes();
    if (selectedMailbox) {
      await fetchEmails(selectedMailbox);
    }
    setRefreshing(false);
  }

  function handleSelectMailbox(id: string) {
    setSelectedMailbox(id);
    setSelectedEmail(null);
    setMobileView("list");
  }

  function handleSelectEmail(id: string) {
    setSelectedEmail(id);
    setMobileView("detail");
  }

  function handleReply(email: any) {
    const fromAddr = email.from?.[0]?.email || "";
    const reSubject = email.subject?.startsWith("Re:")
      ? email.subject
      : `Re: ${email.subject || ""}`;

    let quotedBody = "";
    if (email.textBody?.length && email.bodyValues) {
      const partId = email.textBody[0].partId;
      const text = email.bodyValues[partId]?.value || "";
      quotedBody = `\n\n--- Original Message ---\n${text}`;
    }

    setComposeDefaults({
      to: fromAddr,
      subject: reSubject,
      body: quotedBody,
    });
    setShowCompose(true);
  }

  function handleForward(email: any) {
    const fwdSubject = email.subject?.startsWith("Fwd:")
      ? email.subject
      : `Fwd: ${email.subject || ""}`;

    let quotedBody = "";
    if (email.textBody?.length && email.bodyValues) {
      const partId = email.textBody[0].partId;
      const text = email.bodyValues[partId]?.value || "";
      quotedBody = `\n\n--- Forwarded Message ---\nFrom: ${email.from?.map((f: any) => f.email).join(", ") || "?"}\nSubject: ${email.subject || ""}\n\n${text}`;
    }

    setComposeDefaults({
      to: "",
      subject: fwdSubject,
      body: quotedBody,
    });
    setShowCompose(true);
  }

  function handleComposeSent() {
    setShowCompose(false);
    setComposeDefaults({});
    if (selectedMailbox) {
      fetchEmails(selectedMailbox);
    }
    fetchMailboxes();
  }

  function handleBack() {
    if (mobileView === "detail") {
      setMobileView("list");
      setSelectedEmail(null);
    } else if (mobileView === "list") {
      setMobileView("folders");
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setIsSearching(true);
    setSearchActive(true);
    try {
      const params = new URLSearchParams({ q });
      if (selectedMailbox) {
        params.set("mailboxId", selectedMailbox);
      }
      const res = await fetch(`/api/jmap/search?${params.toString()}`);
      const data = await res.json();
      if (data.emails) {
        setSearchResults(data.emails);
      }
    } catch (err) {
      console.error("Search failed:", err);
    } finally {
      setIsSearching(false);
    }
  }

  function clearSearch() {
    setSearchQuery("");
    setSearchResults([]);
    setSearchActive(false);
  }

  return (
    <div className="flex h-full bg-white">
      {/* Folder sidebar */}
      <aside
        className={`w-56 border-r border-[var(--outline)]/10 bg-[var(--surface)] shrink-0 flex flex-col ${
          mobileView === "folders" ? "block" : "hidden"
        } sm:block`}
      >
        <div className="p-3 flex items-center justify-between border-b border-[var(--outline)]/10">
          <button
            onClick={() => {
              setShowCompose(true);
              setComposeDefaults({});
            }}
            className="tinai-gradient text-white text-sm font-medium px-3 py-1.5 rounded-lg flex items-center gap-1.5 hover:opacity-90 transition"
          >
            <PenSquare className="w-3.5 h-3.5" />
            Compose
          </button>
          <button
            onClick={handleRefresh}
            className="p-1.5 rounded-lg hover:bg-[var(--primary)]/5 text-[var(--outline)]"
            title="Refresh"
          >
            <RefreshCw
              className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`}
            />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FolderList
            mailboxes={mailboxes}
            selectedId={selectedMailbox}
            onSelect={handleSelectMailbox}
          />
        </div>
      </aside>

      {/* Email list */}
      <div
        className={`w-80 border-r border-[var(--outline)]/10 shrink-0 flex flex-col ${
          mobileView === "list" ? "block" : "hidden"
        } sm:block`}
      >
        <div className="px-4 py-2.5 border-b border-[var(--outline)]/10 text-sm font-medium text-[var(--on-surface)]">
          {searchActive
            ? `Search results (${searchResults.length})`
            : (
              <>
                {mailboxes.find((m) => m.id === selectedMailbox)?.name || "Mail"}
                {emails.length > 0 && (
                  <span className="text-[var(--outline)] font-normal ml-2">
                    ({emails.length})
                  </span>
                )}
              </>
            )}
        </div>
        <form
          onSubmit={handleSearch}
          className="px-3 py-2 border-b border-[var(--outline)]/10 flex items-center gap-2"
        >
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--outline)]" />
            <input
              type="text"
              placeholder="Search emails..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-7 pr-7 py-1.5 text-sm rounded-lg border border-[var(--outline)]/20 bg-white focus:outline-none focus:border-[var(--primary)]/40"
            />
            {searchActive && (
              <button
                type="button"
                onClick={clearSearch}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--outline)] hover:text-[var(--on-surface)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </form>
        <div className="flex-1 overflow-hidden">
          <EmailList
            emails={searchActive ? searchResults : emails}
            selectedId={selectedEmail}
            onSelect={handleSelectEmail}
            loading={isSearching || loadingEmails}
          />
        </div>
      </div>

      {/* Email view */}
      <div
        className={`flex-1 min-w-0 ${
          mobileView === "detail" ? "block" : "hidden"
        } sm:block`}
      >
        <EmailView
          emailId={selectedEmail}
          onReply={handleReply}
          onForward={handleForward}
          onBack={handleBack}
        />
      </div>

      {/* Compose modal */}
      {showCompose && (
        <ComposeModal
          onClose={() => {
            setShowCompose(false);
            setComposeDefaults({});
          }}
          onSent={handleComposeSent}
          initialTo={composeDefaults.to}
          initialSubject={composeDefaults.subject}
          initialBody={composeDefaults.body}
        />
      )}
    </div>
  );
}
