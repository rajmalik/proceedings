import type { Metadata } from 'next'
import { Inter, Lora } from 'next/font/google'
import './globals.css'
import TopAppBar from '@/components/TopAppBar'
import MobileBottomNav from '@/components/MobileBottomNav'
import { Providers } from '@/components/Providers'
import AiAssist from '@/components/AiAssist'
import { AI_ASSIST_ENABLED } from '@/lib/flags'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

const lora = Lora({
  subsets: ['latin'],
  variable: '--font-lora',
  display: 'swap',
})

export const metadata: Metadata = {
  metadataBase: new URL('https://meridianjourney.ai'),
  title: {
    default: 'Meridian | Your Immigration Journey Starts Here',
    template: '%s | Meridian',
  },
  description: 'Navigate your immigration journey with confidence. AI-powered guidance, community support, and real experiences from people like you.',
  keywords: ['immigration', 'visa', 'green card', 'H-1B', 'immigration guide', 'USCIS', 'immigration assistant', 'USA visits/migration journey'],
  authors: [{ name: 'Meridian' }],
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://meridianjourney.ai',
    siteName: 'Meridian',
    title: 'Meridian | Your Immigration Journey Starts Here',
    description: 'Navigate your immigration journey with confidence. AI-powered guidance and community support.',
    images: [
      {
        url: '/og-image.jpg',
        width: 1200,
        height: 630,
        alt: 'Meridian - Immigration Journey',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Meridian | Your Immigration Journey Starts Here',
    description: 'Navigate your immigration journey with confidence.',
    images: ['/og-image.jpg'],
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className={`${inter.variable} ${lora.variable}`}>
      <head>
        {/* Material Symbols for icons */}
        <link
          href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans min-h-screen flex flex-col bg-surface text-on-surface">
        <Providers>
          <TopAppBar />
          <main className="flex-grow pb-16 md:pb-0">
            {children}
          </main>
          <MobileBottomNav />
          {/* AI Assist — a collapsible floating chatbot on EVERY page (bottom-right),
              so the conversation can be resumed from anywhere. Flag-gated. */}
          {AI_ASSIST_ENABLED && <AiAssist />}
          {/* Footer - shown on desktop, hidden on mobile due to bottom nav */}
          <footer className="hidden md:block w-full py-8 px-margin-desktop bg-surface-container-low border-t border-outline-variant">
            <div className="max-w-7xl mx-auto">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
                {/* Brand Column */}
                <div className="col-span-1">
                  <div className="text-headline-md font-semibold text-primary font-serif mb-2">Meridian</div>
                  <p className="text-body-md text-on-surface-variant">
                    Your immigration journey starts here.
                  </p>
                </div>

                {/* Product Column */}
                <div className="col-span-1">
                  <div className="text-label-md font-semibold text-on-surface mb-3">Product</div>
                  <div className="space-y-2">
                    <a href="/" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      AI Assistant
                    </a>
                    <a href="/find" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      Find Experiences
                    </a>
                  </div>
                </div>

                {/* Legal Column */}
                <div className="col-span-1">
                  <div className="text-label-md font-semibold text-on-surface mb-3">Legal</div>
                  <div className="space-y-2">
                    <a href="/disclaimer" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      Disclaimer
                    </a>
                    <a href="/terms" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      Terms of Service
                    </a>
                    <a href="/privacy" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      Privacy Policy
                    </a>
                  </div>
                </div>

                {/* Support Column */}
                <div className="col-span-1">
                  <div className="text-label-md font-semibold text-on-surface mb-3">Support</div>
                  <div className="space-y-2">
                    <a href="/support" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      Help Center
                    </a>
                    <a href="mailto:support@meridianjourney.ai" className="block text-body-md text-on-surface-variant hover:text-primary transition-colors">
                      Contact Us
                    </a>
                  </div>
                </div>
              </div>

              <div className="pt-6 border-t border-outline-variant text-center">
                <p className="text-caption text-on-surface-variant">
                  © 2024 Krishes Inc. All rights reserved. Meridian is not a law firm or government agency. Information provided is for guidance only and does not constitute legal advice.
                </p>
              </div>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  )
}
