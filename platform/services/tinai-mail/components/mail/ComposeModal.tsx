"use client";

import { useState } from "react";
import { X, Send, Loader2, ChevronDown, ChevronUp } from "lucide-react";

interface ComposeProps {
  onClose: () => void;
  onSent: () => void;
  initialTo?: string;
  initialSubject?: string;
  initialBody?: string;
}

export function ComposeModal({
  onClose,
  onSent,
  initialTo = "",
  initialSubject = "",
  initialBody = "",
}: ComposeProps) {
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  async function handleSend() {
    if (!to.trim()) {
      setError("Please add at least one recipient");
      return;
    }

    setSending(true);
    setError("");

    try {
      const res = await fetch("/api/jmap/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: to
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          cc: cc
            ? cc
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          bcc: bcc
            ? bcc
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
          subject,
          body,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to send");
        return;
      }

      onSent();
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end sm:items-center justify-center z-50">
      <div className="bg-white w-full sm:max-w-2xl sm:rounded-2xl rounded-t-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--outline)]/10">
          <h3 className="font-semibold text-[var(--on-surface)]">
            New Message
          </h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--outline)]/10 text-[var(--outline)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Fields */}
        <div className="px-5 py-3 space-y-2 border-b border-[var(--outline)]/10">
          {error && (
            <div className="bg-red-50 text-[var(--error)] px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-sm text-[var(--outline)] w-10 shrink-0">
              To
            </label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="flex-1 text-sm py-1.5 px-2 rounded border border-transparent focus:border-[var(--primary)]/30 focus:outline-none bg-transparent"
            />
            <div className="flex gap-1">
              {!showCc && (
                <button
                  onClick={() => setShowCc(true)}
                  className="text-xs text-[var(--primary)] hover:underline"
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  onClick={() => setShowBcc(true)}
                  className="text-xs text-[var(--primary)] hover:underline"
                >
                  Bcc
                </button>
              )}
            </div>
          </div>

          {showCc && (
            <div className="flex items-center gap-2">
              <label className="text-sm text-[var(--outline)] w-10 shrink-0">
                Cc
              </label>
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                className="flex-1 text-sm py-1.5 px-2 rounded border border-transparent focus:border-[var(--primary)]/30 focus:outline-none bg-transparent"
              />
            </div>
          )}

          {showBcc && (
            <div className="flex items-center gap-2">
              <label className="text-sm text-[var(--outline)] w-10 shrink-0">
                Bcc
              </label>
              <input
                type="text"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                className="flex-1 text-sm py-1.5 px-2 rounded border border-transparent focus:border-[var(--primary)]/30 focus:outline-none bg-transparent"
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <label className="text-sm text-[var(--outline)] w-10 shrink-0">
              Subj
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="flex-1 text-sm py-1.5 px-2 rounded border border-transparent focus:border-[var(--primary)]/30 focus:outline-none bg-transparent"
            />
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 px-5 py-3 overflow-y-auto">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Write your message..."
            className="w-full h-64 text-sm resize-none focus:outline-none bg-transparent"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--outline)]/10">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-[var(--outline)] hover:text-[var(--on-surface)] transition"
          >
            Discard
          </button>
          <button
            onClick={handleSend}
            disabled={sending}
            className="tinai-gradient text-white font-medium px-5 py-2 rounded-lg hover:opacity-90 transition disabled:opacity-50 flex items-center gap-2 text-sm"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Sending...
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                Send
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
