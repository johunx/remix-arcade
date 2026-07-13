import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Remix Arcade",
  description: "Play, create, remix, and publish tiny games.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
