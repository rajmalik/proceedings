import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="container-narrow section-padding flex flex-col items-center text-center">
      <p className="overline mb-2">404</p>
      <h1 className="text-headline-lg text-on-surface mb-2">Page not found</h1>
      <p className="text-body-md text-on-surface-variant mb-6 max-w-md">
        The page you’re looking for doesn’t exist or may have moved.
      </p>
      <Link href="/" className="btn-primary">Go to Search</Link>
    </div>
  )
}
