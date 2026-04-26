import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "research-bot",
  description: "Niche SaaS opportunity research",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
        <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-3">
            <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
              research-bot
            </Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/" className="hover:underline">opportunities</Link>
              <Link href="/queue" className="hover:underline">queue</Link>
            </nav>
          </div>
        </header>
        <main className="flex-1 w-full">{children}</main>
      </body>
    </html>
  );
}
