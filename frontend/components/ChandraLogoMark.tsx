export function ChandraLogoMark({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`chandra-logo-mark ${className}`.trim()}
      focusable="false"
      viewBox="0 0 180 180"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        {/* Soft shadow filter for the entire squircle logo mark */}
        <filter id="squircle-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="6" stdDeviation="8" floodColor="#11261a" floodOpacity="0.06" />
        </filter>

        {/* Luminous outer glow filter for the leaf-green crescent moon */}
        <filter id="moon-glow" x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feComponentTransfer in="blur" result="glow">
            <feFuncA type="linear" slope="0.4" />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>

        {/* Luminous gradient spanning from bright lime down to rich grass green */}
        <linearGradient id="leaf-gradient" x1="40" x2="140" y1="35" y2="145" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#a5ea5a" />    {/* Top glowing tip */}
          <stop offset="35%" stopColor="#78ce41" />   {/* Mid leaf green */}
          <stop offset="70%" stopColor="#48a42b" />   {/* Rich grass green */}
          <stop offset="100%" stopColor="#2e7e17" />  {/* Deep meadow green shadow */}
        </linearGradient>

        {/* Inner glow highlight gradient to simulate 3D curvature */}
        <linearGradient id="inner-highlight" x1="50" x2="130" y1="40" y2="120" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#cff69d" stopOpacity="0.8" />
          <stop offset="50%" stopColor="#81d547" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#48a42b" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Warm-White Squircle Base matching the logo upload */}
      <rect
        width="172"
        height="172"
        x="4"
        y="4"
        rx="40"
        fill="#ffffff"
        stroke="#e6e2d8"
        strokeWidth="1"
        filter="url(#squircle-shadow)"
      />

      {/* Luminous outer glow backdrop circle */}
      <circle cx="82" cy="94" r="54" fill="#a5ea5a" opacity="0.08" filter="url(#moon-glow)" />

      {/* Main leaf-green crescent moon */}
      <path
        className="chandra-logo-crescent"
        d="M130.6 55.1C111.1 34.3 77.2 30 51.9 46.5 20.4 67 13.9 111.6 38.4 139.7c24.4 28 68 29.2 94.1 3.8-28.8 9.1-61.3-1.5-77.6-28.4C37.5 86.2 48.2 48 77.4 31.4c18.9-10.7 40.8-8.6 53.2 23.7Z"
        fill="url(#leaf-gradient)"
        filter="url(#moon-glow)"
      />

      {/* Highlight curve path to add realistic depth and shape definition */}
      <path
        d="M51 91.5c6.9-29.2 35.2-53.5 70.2-49.9 5.4.5 10.5 1.7 15.4 3.4-17.9-15-47.3-16.2-70.3-1-23.8 15.8-34.6 45.1-26.5 71.9 1.9-8.8 5.5-17.2 11.2-24.4Z"
        fill="url(#inner-highlight)"
        opacity="0.85"
      />
    </svg>
  );
}
