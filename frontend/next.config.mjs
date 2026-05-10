import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/*": [
      "../node_modules/pdf-lib/**/*",
      "../node_modules/pdf-parse/**/*",
      "../node_modules/pdfjs-dist/**/*"
    ]
  },
  typescript: {
    ignoreBuildErrors: process.env.NEXT_IGNORE_TYPECHECK === "1"
  },
  typedRoutes: true,
  turbopack: {
    root: projectRoot
  }
};

export default nextConfig;
