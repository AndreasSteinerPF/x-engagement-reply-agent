import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kestrel — X Engagement Reply Agent",
  description:
    "Polls watched X authors, matches posts against Soofi article content via the hosted investors-mcp MCP, drafts prompt-driven replies, and prepares Asana approval tasks.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="font-sans">
        <main className="mx-auto max-w-5xl px-5 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-5 pb-10 pt-4 text-xs text-stone-500">
          Kestrel · standalone X Engagement Reply Agent
        </footer>
      </body>
    </html>
  );
}
