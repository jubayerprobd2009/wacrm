import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { APP_LOGO_PATH } from "@/lib/branding";

// Replaces the default Next.js favicon with the client's brand logo
// (public/brand/logo.png), matching the sidebar logo in
// `src/components/layout/sidebar.tsx`. Next.js renders this at build
// time and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).
//
// Reads the logo file from disk (nodejs runtime, not edge) since
// ImageResponse needs raw image bytes and the edge runtime has no fs
// access to read a bundled public asset at render time.

export const runtime = "nodejs";
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default async function Icon() {
  const logoPath = path.join(process.cwd(), "public", APP_LOGO_PATH);
  const logoData = await readFile(logoPath);
  const logoSrc = `data:image/png;base64,${logoData.toString("base64")}`;

  return new ImageResponse(
    (
      <img
        src={logoSrc}
        width={size.width}
        height={size.height}
        alt=""
        style={{ borderRadius: 6 }}
      />
    ),
    { ...size },
  );
}
