import type { ReactNode } from "react";

export const metadata = {
  title: "Kith",
  description: "A private memory system for the people in your life.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0A1512",
};

/**
 * Phase 0 shell. Deliberately not the design system: this exists so the
 * deployed URL proves sign-in works, and it gets replaced wholesale when the
 * prototype is ported. The only thing borrowed is the ground and text color,
 * so a working deploy does not look like a broken one on a phone.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          background: "#0A1512",
          color: "#F1EADC",
          font: "16px/1.5 system-ui, sans-serif",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        {children}
      </body>
    </html>
  );
}
