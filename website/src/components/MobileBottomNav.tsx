'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const navItems = [
  { href: '/', label: 'Home', icon: 'home' },
  { href: '/find', label: 'Groups', icon: 'diversity_3' },
  { href: '/news', label: 'News', icon: 'newspaper' },
  { href: '/discussions', label: 'Discussions', icon: 'forum' },
  { href: '/post', label: 'Post', icon: 'edit_square' },
];

export default function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-2 py-1 md:hidden bg-surface-container border-t border-outline-variant">
      {navItems.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all ${
              isActive
                ? 'bg-primary-container text-on-primary-container scale-95'
                : 'text-on-surface-variant hover:text-primary'
            }`}
          >
            <span className="material-symbols-outlined text-[24px]">
              {item.icon}
            </span>
            <span className="text-caption mt-0.5">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
