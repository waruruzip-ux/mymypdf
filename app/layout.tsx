import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: '마이PDF — 내 기기에서 안전하게 PDF 편집',
  description: 'PDF 병합, 페이지별 분할, 삭제와 추출을 서버 업로드 없이 브라우저에서 처리하세요.',
  openGraph: {
    title: '마이PDF — 내 기기에서 안전하게 PDF 편집',
    description: 'PDF 병합, 페이지별 분할, 삭제와 추출을 서버 업로드 없이 브라우저에서 처리하세요.',
    siteName: '마이PDF',
    type: 'website',
    locale: 'ko_KR',
  },
  twitter: {
    card: 'summary_large_image',
    title: '마이PDF — 내 기기에서 안전하게 PDF 편집',
    description: 'PDF 병합, 페이지별 분할, 삭제와 추출을 서버 업로드 없이 브라우저에서 처리하세요.',
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
