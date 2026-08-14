import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Demeter Console",
  description: "Soteria Demeter — Liquid / Triton agent console",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={jetbrainsMono.variable}>
      <body className="min-h-screen flex flex-col bg-console-bg text-demeter-blue font-mono">
        <header className="flex-none border-b border-console-border bg-console-panel/90 backdrop-blur-sm">
          <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
            <div className="flex items-center gap-2 text-xs text-demeter-blue-soft/80">
              <span className="inline-block h-2 w-2 rounded-full bg-demeter-blue shadow-[0_0_8px_#347ded]" />
              <span className="tracking-widest uppercase">soteria@demeter</span>
            </div>
            <h1 className="text-sm font-semibold tracking-[0.2em] uppercase text-demeter-blue">
              Demeter Console
            </h1>
            <div className="text-xs text-demeter-blue-muted tabular-nums">v0.1</div>
          </div>
        </header>

        <main className="relative flex flex-1 flex-col items-center justify-center px-4 py-6">
          <div
            className="pointer-events-none absolute inset-0 opacity-30"
            style={{
              backgroundImage:
                "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(52,125,237,0.1), transparent 60%)",
            }}
          />
          <div className="relative z-10 w-full max-w-3xl">{children}</div>
        </main>

        <footer className="flex-none border-t border-console-border py-3 text-center text-xs text-demeter-blue-muted">
          <p>© {new Date().getFullYear()} Soteria Labs · Base mainnet</p>
        </footer>
      </body>
    </html>
  );
}
