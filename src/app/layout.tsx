import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import AntiDebug from "@/components/hyperchat/AntiDebug";

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800", "900"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Hyperion",
  description:
    "Hyperion is a real-time group chat service with servers, roles, channels, direct messages, read receipts, reactions and image sharing.",
  applicationName: "Hyperion",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Hyperion",
  },
  keywords: [
    "Hyperion",
    "group chat",
    "messaging",
    "servers",
    "channels",
    "direct messages",
  ],
  openGraph: {
    title: "Hyperion",
    description:
      "Real-time group chat with servers, roles, channels, direct messages, read receipts, reactions and image sharing.",
    siteName: "Hyperion",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  // cover: lets the PWA shell read env(safe-area-inset-*) so the composer
  // and drawers clear the home indicator on notched phones
  viewportFit: "cover",
  // android chrome: the on-screen keyboard resizes the layout viewport, so
  // the composer rides up with it instead of hiding underneath
  interactiveWidget: "resizes-content",
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
        <AntiDebug />
        <Toaster />
      </body>
    </html>
  );
}
