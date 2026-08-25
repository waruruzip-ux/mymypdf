import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const siteUrl = productionHost
  ? `https://${productionHost}`
  : 'https://mypdf-editor.waruruzip.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: '마이PDF — PDF 여기서 편집해',
  description: 'PDF 병합, 구간 분할, 삭제와 추출을 서버 업로드 없이 브라우저에서 처리하세요.',
  alternates: { canonical: '/' },
  openGraph: {
    title: '마이PDF — PDF 여기서 편집해',
    description: 'PDF 병합, 구간 분할, 삭제와 추출을 서버 업로드 없이 브라우저에서 처리하세요.',
    siteName: '마이PDF',
    type: 'website',
    locale: 'ko_KR',
    url: '/',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: '마이PDF — PDF 여기서 편집해' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '마이PDF — PDF 여기서 편집해',
    description: 'PDF 병합, 구간 분할, 삭제와 추출을 서버 업로드 없이 브라우저에서 처리하세요.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
