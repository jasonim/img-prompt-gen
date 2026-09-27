import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "枝句 · 生图词库收录器",
  description: "枝句 Chrome 扩展的安装、使用与隐私说明。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
