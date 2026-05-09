const chandraIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
  <rect width="180" height="180" rx="40" fill="#0b0f1a"/>
  <circle cx="90" cy="90" r="58" fill="#7c5cff"/>
  <path d="M110 67c-7-8-17-13-29-13-22 0-40 17-40 39s18 39 40 39c13 0 24-6 31-15l-18-14c-3 4-8 7-14 7-10 0-18-8-18-18s8-18 18-18c6 0 11 3 14 7z" fill="#ffffff"/>
  <path d="M115 44c17 8 29 25 29 46 0 28-23 51-51 51" fill="none" stroke="#b8a9ff" stroke-width="10" stroke-linecap="round"/>
</svg>`;

export function createIconResponse() {
  return new Response(chandraIconSvg, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/svg+xml; charset=utf-8"
    }
  });
}
