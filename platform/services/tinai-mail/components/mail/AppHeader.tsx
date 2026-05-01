"use client";

import { useRouter } from "next/navigation";
import { Mail, LogOut } from "lucide-react";
import { ThemePicker } from "@/components/mail/ThemePicker";

export function AppHeader({ email }: { email: string }) {
  const router = useRouter();

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <header className="tinai-gradient px-4 py-2.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2.5">
        <div className="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center">
          <Mail className="w-4 h-4 text-white" />
        </div>
        <span className="text-white font-semibold text-lg">Tinai Mail</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-white/80 text-sm hidden sm:block">{email}</span>
        <ThemePicker />
        <button
          onClick={handleLogout}
          className="text-white/70 hover:text-white transition p-1.5 rounded-lg hover:bg-white/10"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
