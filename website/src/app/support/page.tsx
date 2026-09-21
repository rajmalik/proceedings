import { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Support & Help Center',
  description: 'Get help with Meridian. Find answers to common questions, contact support, and learn how to use our immigration guidance platform.',
}

const faqs = [
  {
    question: 'What is Meridian?',
    answer: 'Meridian is an AI-powered immigration guidance platform that helps you navigate your US immigration journey. We combine AI technology with community wisdom to provide helpful information and connect you with others on similar paths.',
  },
  {
    question: 'Is Meridian a law firm?',
    answer: 'No, Meridian is not a law firm and does not provide legal advice. We provide general information and guidance based on community experiences. For legal advice, please consult with a licensed immigration attorney.',
  },
  {
    question: 'How accurate is the AI assistant?',
    answer: 'Our AI assistant provides information based on real immigration experiences and publicly available guidelines. While we strive for accuracy, immigration laws change frequently. Always verify important information with official USCIS sources or an immigration attorney.',
  },
  {
    question: 'Is my information secure?',
    answer: 'Yes, we take your privacy seriously. We use industry-standard encryption and security practices to protect your data. Read our Privacy Policy for more details about how we handle your information.',
  },
  {
    question: 'Can I share my immigration experience?',
    answer: 'Absolutely! We encourage community members to share their experiences to help others. You can post your journey, timeline, and tips anonymously or with your profile. Your contributions help make the immigration process less daunting for everyone.',
  },
  {
    question: 'How do I delete my account?',
    answer: 'You can delete your account by going to your Profile settings and selecting "Delete Account." If you need assistance, contact us at support@meridianjourney.ai.',
  },
  {
    question: 'Is Meridian free to use?',
    answer: 'Yes, Meridian offers free access to our AI assistant, community features, and experience database. We may introduce premium features in the future, but core functionality will remain free.',
  },
  {
    question: 'How can I report inappropriate content?',
    answer: 'If you see content that violates our community guidelines, please use the report button on the post or contact us at support@meridianjourney.ai. We review all reports promptly.',
  },
]

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <section className="bg-gradient-to-b from-primary-container to-surface py-16">
        <div className="max-w-4xl mx-auto px-4 md:px-margin-desktop text-center">
          <h1 className="text-display-lg font-bold text-on-surface mb-4 font-serif">
            Help Center
          </h1>
          <p className="text-body-lg text-on-surface-variant max-w-2xl mx-auto">
            Find answers to common questions or get in touch with our support team.
          </p>
        </div>
      </section>

      {/* Contact Cards */}
      <section className="py-12">
        <div className="max-w-4xl mx-auto px-4 md:px-margin-desktop">
          <div className="grid md:grid-cols-2 gap-6">
            {/* Email Support */}
            <div className="bg-surface-container-low rounded-2xl p-6 border border-outline-variant">
              <div className="w-12 h-12 bg-primary-container rounded-xl flex items-center justify-center mb-4">
                <span className="material-symbols-outlined text-primary text-2xl">mail</span>
              </div>
              <h2 className="text-headline-md font-semibold text-on-surface mb-2">Email Support</h2>
              <p className="text-body-md text-on-surface-variant mb-4">
                Have a question or need help? Our support team typically responds within 24 hours.
              </p>
              <a
                href="mailto:support@meridianjourney.ai"
                className="inline-flex items-center gap-2 text-primary font-medium hover:underline"
              >
                support@meridianjourney.ai
                <span className="material-symbols-outlined text-lg">arrow_forward</span>
              </a>
            </div>

            {/* Browse postings */}
            <div className="bg-surface-container-low rounded-2xl p-6 border border-outline-variant">
              <div className="w-12 h-12 bg-primary-container rounded-xl flex items-center justify-center mb-4">
                <span className="material-symbols-outlined text-primary text-2xl">search</span>
              </div>
              <h2 className="text-headline-md font-semibold text-on-surface mb-2">Browse Postings</h2>
              <p className="text-body-md text-on-surface-variant mb-4">
                Search real USA visits/migration journey shared by people who&apos;ve been through the process.
              </p>
              <Link
                href="/"
                className="inline-flex items-center gap-2 text-primary font-medium hover:underline"
              >
                Search postings
                <span className="material-symbols-outlined text-lg">arrow_forward</span>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* FAQs */}
      <section className="py-12 bg-surface-container-low">
        <div className="max-w-4xl mx-auto px-4 md:px-margin-desktop">
          <h2 className="text-headline-lg font-semibold text-on-surface mb-8 text-center font-serif">
            Frequently Asked Questions
          </h2>

          <div className="space-y-4">
            {faqs.map((faq, index) => (
              <details
                key={index}
                className="bg-surface-container-lowest rounded-xl border border-outline-variant group"
              >
                <summary className="flex items-center justify-between cursor-pointer p-5 text-body-lg font-medium text-on-surface list-none">
                  {faq.question}
                  <span className="material-symbols-outlined text-on-surface-variant transition-transform group-open:rotate-180">
                    expand_more
                  </span>
                </summary>
                <div className="px-5 pb-5 text-body-md text-on-surface-variant">
                  {faq.answer}
                </div>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Additional Resources */}
      <section className="py-12">
        <div className="max-w-4xl mx-auto px-4 md:px-margin-desktop">
          <h2 className="text-headline-lg font-semibold text-on-surface mb-8 text-center font-serif">
            Additional Resources
          </h2>

          <div className="grid md:grid-cols-3 gap-6">
            <Link
              href="/disclaimer"
              className="bg-surface-container-low rounded-xl p-5 border border-outline-variant hover:border-primary transition-colors group"
            >
              <span className="material-symbols-outlined text-primary text-2xl mb-3 block">gavel</span>
              <h3 className="text-body-lg font-semibold text-on-surface mb-1 group-hover:text-primary transition-colors">
                Legal Disclaimer
              </h3>
              <p className="text-body-md text-on-surface-variant">
                Important information about our service
              </p>
            </Link>

            <Link
              href="/privacy"
              className="bg-surface-container-low rounded-xl p-5 border border-outline-variant hover:border-primary transition-colors group"
            >
              <span className="material-symbols-outlined text-primary text-2xl mb-3 block">shield</span>
              <h3 className="text-body-lg font-semibold text-on-surface mb-1 group-hover:text-primary transition-colors">
                Privacy Policy
              </h3>
              <p className="text-body-md text-on-surface-variant">
                How we protect your data
              </p>
            </Link>

            <Link
              href="/terms"
              className="bg-surface-container-low rounded-xl p-5 border border-outline-variant hover:border-primary transition-colors group"
            >
              <span className="material-symbols-outlined text-primary text-2xl mb-3 block">description</span>
              <h3 className="text-body-lg font-semibold text-on-surface mb-1 group-hover:text-primary transition-colors">
                Terms of Service
              </h3>
              <p className="text-body-md text-on-surface-variant">
                Rules and guidelines for using Meridian
              </p>
            </Link>
          </div>
        </div>
      </section>

      {/* Still Need Help */}
      <section className="py-12 bg-primary">
        <div className="max-w-4xl mx-auto px-4 md:px-margin-desktop text-center">
          <h2 className="text-headline-lg font-semibold text-on-primary mb-4 font-serif">
            Still need help?
          </h2>
          <p className="text-body-lg text-on-primary/80 mb-6">
            Our support team is here to assist you with any questions or concerns.
          </p>
          <a
            href="mailto:support@meridianjourney.ai"
            className="inline-flex items-center justify-center gap-2 bg-surface text-primary px-6 py-3 rounded-full text-body-lg font-semibold hover:bg-surface-container-lowest transition-colors"
          >
            <span className="material-symbols-outlined">mail</span>
            Contact Support
          </a>
        </div>
      </section>
    </div>
  )
}
