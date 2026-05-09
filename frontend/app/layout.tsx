import type { Metadata } from "next";
import { AuthProvider } from "@/components/AuthProvider";
import "katex/dist/katex.min.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Chandra",
  description: "Teacher-guided AI tutoring for classrooms",
  icons: {
    apple: [
      { url: "/apple-touch-icon.png" },
      { url: "/apple-touch-icon-precomposed.png" }
    ],
    icon: "/favicon.ico"
  }
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
