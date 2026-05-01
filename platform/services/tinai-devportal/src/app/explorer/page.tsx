import type { Metadata } from "next";
import { ApiExplorer } from "./ApiExplorer";

export const metadata: Metadata = {
  title: "API Explorer",
  description: "Interactive API explorer for all Tinai APIs — try requests live.",
};

export default function ExplorerPage() {
  return (
    <div className="h-[calc(100vh-3.5rem)]">
      <ApiExplorer />
    </div>
  );
}
