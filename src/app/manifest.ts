import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");

// Web Share Target params are declared here; TypeScript's manifest type doesn't include them.
type ManifestWithShare = MetadataRoute.Manifest & {
  share_target?: { action: string; method: "GET"; params: { title?: string; text?: string; url?: string } };
};

export default function manifest(): ManifestWithShare {
  return {
    id: `${base}/`,
    name: "Reel Picks",
    short_name: "Reel Picks",
    description: "Personal movie & TV recommendations",
    start_url: `${base}/`,
    scope: `${base}/`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#12121a",
    theme_color: "#12121a",
    icons: [
      { src: `${base}/icons/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${base}/icons/icon-512.png`, sizes: "512x512", type: "image/png" },
      { src: `${base}/icons/icon-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    share_target: {
      action: `${base}/share/`,
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  };
}
