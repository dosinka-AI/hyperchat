import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "HyperChat",
  description:
    "HyperChat is a real-time group chat service with servers, roles, channels, direct messages, read receipts, reactions and image sharing. A Blazar Software™ NRC product.",
  applicationName: "HyperChat",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "HyperChat",
  },
  keywords: [
    "HyperChat",
    "Blazar Software NRC",
    "group chat",
    "messaging",
    "servers",
    "channels",
    "direct messages",
  ],
  authors: [{ name: "Blazar Software™ NRC" }],
  openGraph: {
    title: "HyperChat",
    description:
      "Real-time group chat with servers, roles, channels, direct messages, read receipts, reactions and image sharing.",
    siteName: "HyperChat",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${archivo.variable} antialiased bg-background text-foreground`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
