// Archived: this was the marketing homepage at "/" before Search/Home
// consolidation (features/ui-changes-1). "/" now renders UnifiedSearch
// directly. Kept here, unrouted, to reuse when the "What We Do" page is
// built in a future release — deliberately NOT scrubbed of "visa
// experiences"/"community" copy or repointed off /community, since it's
// dormant until that rebuild.
import Link from 'next/link'

export default function LandingPage() {
  return (
    <div className="flex flex-col">
      {/* Hero Section */}
      <section className="relative bg-gradient-to-b from-primary-container to-surface py-20 md:py-32">
        <div className="max-w-6xl mx-auto px-4 md:px-margin-desktop">
          <div className="text-center max-w-3xl mx-auto">
            <h1 className="text-display-lg md:text-[52px] font-bold text-on-surface leading-tight mb-6 font-serif">
              Your immigration journey starts here
            </h1>
            <p className="text-body-lg md:text-xl text-on-surface-variant mb-10 max-w-2xl mx-auto">
              Navigate the complex world of US immigration with confidence. Get AI-powered guidance,
              connect with a supportive community, and learn from real experiences.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                href="/search"
                className="inline-flex items-center justify-center gap-2 bg-primary text-on-primary px-8 py-4 rounded-full text-body-lg font-semibold hover:bg-primary/90 transition-colors"
              >
                Get Started
                <span className="material-symbols-outlined">arrow_forward</span>
              </Link>
              <Link
                href="/community"
                className="inline-flex items-center justify-center gap-2 bg-surface border border-outline-variant text-on-surface px-8 py-4 rounded-full text-body-lg font-semibold hover:bg-surface-container transition-colors"
              >
                Join Community
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-20 bg-surface">
        <div className="max-w-6xl mx-auto px-4 md:px-margin-desktop">
          <div className="text-center mb-16">
            <h2 className="text-headline-lg md:text-[32px] font-semibold text-on-surface mb-4 font-serif">
              Everything you need for your journey
            </h2>
            <p className="text-body-lg text-on-surface-variant max-w-2xl mx-auto">
              Meridian combines AI technology with community wisdom to give you the support you deserve.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {/* Feature 1 */}
            <div className="bg-surface-container-low rounded-2xl p-8 border border-outline-variant hover:shadow-lg transition-shadow">
              <div className="w-14 h-14 bg-primary-container rounded-xl flex items-center justify-center mb-6">
                <span className="material-symbols-outlined text-primary text-3xl">smart_toy</span>
              </div>
              <h3 className="text-headline-md font-semibold text-on-surface mb-3">AI Immigration Assistant</h3>
              <p className="text-body-md text-on-surface-variant">
                Ask questions and get instant, helpful responses based on real immigration experiences and official guidelines.
              </p>
            </div>

            {/* Feature 2 */}
            <div className="bg-surface-container-low rounded-2xl p-8 border border-outline-variant hover:shadow-lg transition-shadow">
              <div className="w-14 h-14 bg-primary-container rounded-xl flex items-center justify-center mb-6">
                <span className="material-symbols-outlined text-primary text-3xl">groups</span>
              </div>
              <h3 className="text-headline-md font-semibold text-on-surface mb-3">Supportive Community</h3>
              <p className="text-body-md text-on-surface-variant">
                Connect with others on similar journeys. Share experiences, ask questions, and find encouragement.
              </p>
            </div>

            {/* Feature 3 */}
            <div className="bg-surface-container-low rounded-2xl p-8 border border-outline-variant hover:shadow-lg transition-shadow">
              <div className="w-14 h-14 bg-primary-container rounded-xl flex items-center justify-center mb-6">
                <span className="material-symbols-outlined text-primary text-3xl">travel_explore</span>
              </div>
              <h3 className="text-headline-md font-semibold text-on-surface mb-3">Real Experiences</h3>
              <p className="text-body-md text-on-surface-variant">
                Browse thousands of visa experiences from people who&apos;ve been through the process. Learn what to expect.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works Section */}
      <section className="py-20 bg-surface-container-low">
        <div className="max-w-6xl mx-auto px-4 md:px-margin-desktop">
          <div className="text-center mb-16">
            <h2 className="text-headline-lg md:text-[32px] font-semibold text-on-surface mb-4 font-serif">
              How Meridian helps you
            </h2>
          </div>

          <div className="grid md:grid-cols-4 gap-8">
            <div className="text-center">
              <div className="w-12 h-12 bg-primary text-on-primary rounded-full flex items-center justify-center mx-auto mb-4 text-xl font-bold">
                1
              </div>
              <h3 className="text-body-lg font-semibold text-on-surface mb-2">Ask a question</h3>
              <p className="text-body-md text-on-surface-variant">
                Type your immigration question in plain English
              </p>
            </div>

            <div className="text-center">
              <div className="w-12 h-12 bg-primary text-on-primary rounded-full flex items-center justify-center mx-auto mb-4 text-xl font-bold">
                2
              </div>
              <h3 className="text-body-lg font-semibold text-on-surface mb-2">Get guidance</h3>
              <p className="text-body-md text-on-surface-variant">
                Receive helpful information based on real experiences
              </p>
            </div>

            <div className="text-center">
              <div className="w-12 h-12 bg-primary text-on-primary rounded-full flex items-center justify-center mx-auto mb-4 text-xl font-bold">
                3
              </div>
              <h3 className="text-body-lg font-semibold text-on-surface mb-2">Explore experiences</h3>
              <p className="text-body-md text-on-surface-variant">
                Read stories from others with similar visa situations
              </p>
            </div>

            <div className="text-center">
              <div className="w-12 h-12 bg-primary text-on-primary rounded-full flex items-center justify-center mx-auto mb-4 text-xl font-bold">
                4
              </div>
              <h3 className="text-body-lg font-semibold text-on-surface mb-2">Connect & share</h3>
              <p className="text-body-md text-on-surface-variant">
                Join the community and help others on their journey
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Visa Types Section */}
      <section className="py-20 bg-surface">
        <div className="max-w-6xl mx-auto px-4 md:px-margin-desktop">
          <div className="text-center mb-12">
            <h2 className="text-headline-lg md:text-[32px] font-semibold text-on-surface mb-4 font-serif">
              We cover all visa categories
            </h2>
            <p className="text-body-lg text-on-surface-variant">
              Whether you&apos;re on a work visa, student visa, or pursuing a green card
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-3">
            {['H-1B', 'H-4', 'L-1', 'O-1', 'EB-1', 'EB-2', 'EB-3', 'F-1', 'OPT', 'PERM', 'I-140', 'I-485', 'Green Card', 'Citizenship'].map((visa) => (
              <span
                key={visa}
                className="px-4 py-2 bg-surface-container rounded-full text-body-md text-on-surface-variant border border-outline-variant"
              >
                {visa}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-primary">
        <div className="max-w-4xl mx-auto px-4 md:px-margin-desktop text-center">
          <h2 className="text-headline-lg md:text-[32px] font-semibold text-on-primary mb-4 font-serif">
            Ready to start your journey?
          </h2>
          <p className="text-body-lg text-on-primary/80 mb-8 max-w-2xl mx-auto">
            Join thousands of immigrants who use Meridian to navigate their path to their American dream.
          </p>
          <Link
            href="/signup"
            className="inline-flex items-center justify-center gap-2 bg-surface text-primary px-8 py-4 rounded-full text-body-lg font-semibold hover:bg-surface-container-lowest transition-colors"
          >
            Create Free Account
            <span className="material-symbols-outlined">arrow_forward</span>
          </Link>
        </div>
      </section>

      {/* Trust Section */}
      <section className="py-16 bg-surface-container-low border-t border-outline-variant">
        <div className="max-w-6xl mx-auto px-4 md:px-margin-desktop">
          <div className="grid md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="text-display-lg font-bold text-primary mb-2">10k+</div>
              <p className="text-body-md text-on-surface-variant">Visa experiences shared</p>
            </div>
            <div>
              <div className="text-display-lg font-bold text-primary mb-2">50k+</div>
              <p className="text-body-md text-on-surface-variant">Questions answered</p>
            </div>
            <div>
              <div className="text-display-lg font-bold text-primary mb-2">5k+</div>
              <p className="text-body-md text-on-surface-variant">Community members</p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
