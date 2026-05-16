import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Big Bolão — Admin',
  description: 'Admin panel for managing World Cup matches',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
