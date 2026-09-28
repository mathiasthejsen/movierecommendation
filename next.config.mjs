// Guard against leaking server-side secrets into the public static bundle.
// Only NEXT_PUBLIC_* values are inlined into the client, so refuse to build if
// one of them looks like a secret.
const SECRETISH = /SECRET|SERVICE_ROLE|PASSWORD|PRIVATE|TMDB_API_KEY|TMDB_READ_TOKEN|REDDIT/i;
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("NEXT_PUBLIC_") || !value) continue;
  if (SECRETISH.test(key)) {
    throw new Error(`Refusing to build: ${key} looks like a secret and would be shipped to the browser.`);
  }
  if (value.startsWith("sb_secret_")) {
    throw new Error(`Refusing to build: ${key} contains a Supabase secret key. Use the anon/publishable key.`);
  }
  const parts = value.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload.role === "service_role") {
        throw new Error(`Refusing to build: ${key} is a Supabase service_role key. Use the anon key.`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Refusing")) throw err;
    }
  }
}

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
};

export default nextConfig;
