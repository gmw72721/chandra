const chandraIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="74%">
      <stop offset="0%" stop-color="#171348"/>
      <stop offset="54%" stop-color="#080d2b"/>
      <stop offset="100%" stop-color="#030712"/>
    </radialGradient>
    <linearGradient id="crescent" x1="62" x2="118" y1="39" y2="154">
      <stop offset="0%" stop-color="#f5ddff"/>
      <stop offset="42%" stop-color="#a56dff"/>
      <stop offset="100%" stop-color="#5b2cff"/>
    </linearGradient>
    <linearGradient id="edge" x1="48" x2="126" y1="43" y2="58">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#c7a4ff"/>
    </linearGradient>
    <radialGradient id="star" cx="46%" cy="38%" r="70%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#a986ff"/>
    </radialGradient>
  </defs>
  <rect width="180" height="180" rx="38" fill="url(#bg)"/>
  <path d="M130.6 55.1C111.1 34.3 77.2 30 51.9 46.5 20.4 67 13.9 111.6 38.4 139.7c24.4 28 68 29.2 94.1 3.8-28.8 9.1-61.3-1.5-77.6-28.4C37.5 86.2 48.2 48 77.4 31.4c18.9-10.7 40.8-8.6 53.2 23.7Z" fill="url(#crescent)"/>
  <path d="M48.2 99.8c1.1-22.7 14.8-43.7 36.2-55.9 17-9.7 36.2-11.1 52.4-4.8-19.7-18-51.3-20.9-75-5.5-30.3 19.6-38.1 62-17.5 91.7 9.2 13.3 22.9 22.2 37.8 25.9-20.6-10.2-35-29.7-33.9-51.4Z" fill="#e7c8ff" opacity=".5"/>
  <path d="M51 91.5c6.9-29.2 35.2-53.5 70.2-49.9 5.4.5 10.5 1.7 15.4 3.4-17.9-15-47.3-16.2-70.3-1-23.8 15.8-34.6 45.1-26.5 71.9 1.9-8.8 5.5-17.2 11.2-24.4Z" fill="url(#edge)" opacity=".92"/>
  <path d="M100.7 79.6c-1.1 15.6-8.9 23.7-24.3 25.1 15.3 1.3 23.1 9.4 24.3 25.1 1.2-15.7 9-23.8 24.3-25.1-15.4-1.4-23.2-9.5-24.3-25.1Z" fill="url(#star)"/>
  <path d="M112.7 86.2c14.4 3.7 24 16.3 24 32.1 0 15.7-9.6 28.3-24 32" fill="none" stroke="#7d4dff" stroke-width="4" stroke-linecap="round"/>
  <circle cx="117.9" cy="83.3" r="4.4" fill="#ead9ff"/>
  <circle cx="136.9" cy="118.3" r="4.4" fill="#ead9ff"/>
  <circle cx="117.9" cy="153.1" r="4.4" fill="#ead9ff"/>
</svg>`;

export function createIconResponse() {
  return new Response(chandraIconSvg, {
    headers: {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/svg+xml; charset=utf-8"
    }
  });
}
