import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  ...nextVitals,
  {
    ignores: [".next/**", "frontend/.next/**", "node_modules/**", "out/**", "frontend/out/**"],
    settings: {
      next: {
        rootDir: "frontend/"
      }
    }
  }
];

export default eslintConfig;
