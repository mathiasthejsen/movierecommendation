import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppProvider } from "@/components/AppProvider";
import { NewDataBanner } from "@/components/Chrome";
import { MatchSheetProvider } from "@/components/MatchSheet";
import { Nav } from "@/components/Nav";
import { BASE_PATH } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reel Picks — movie & TV recommendations",
  description: "Personal taste-matched movie and TV recommendations (1980+).",
  applicationName: "Reel Picks",
  appleWebApp: { capable: true, title: "Reel Picks", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: `${BASE_PATH}/icons/icon.svg`, type: "image/svg+xml" }, { url: `${BASE_PATH}/icons/icon-192.png`, sizes: "192x192" }],
    apple: [{ url: `${BASE_PATH}/icons/apple-touch-icon.png`, sizes: "180x180" }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#12121a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>
          <MatchSheetProvider>
            <main className="container">
              <NewDataBanner />
              {children}
            </main>
            <Nav />
          </MatchSheetProvider>
        </AppProvider>
      </body>
    </html>
  );
}
