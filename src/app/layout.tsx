import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Kith",
  description: "A private memory system for the people in your life.",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent" as const, title: "Kith" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#0A1512",
};

/**
 * Fonts come straight from Google Fonts, as in the prototype. React 19 hoists
 * these <link>s into <head>, and loading them at runtime keeps the build free
 * of a network dependency it would otherwise fail on.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          precedence="default"
          href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Fraunces:ital,opsz,wght@0,9..144,300..700;1,9..144,300..700&family=Schibsted+Grotesk:wght@400..800&display=swap"
        />
        {children}
      </body>
    </html>
  );
}
