import fs from 'fs';
import path from 'path';

/**
 * Screen registration is duplicated across five sibling stacks (Home, News,
 * Discussions, Find, Profile) because React Navigation has no shared-routes
 * primitive here. That makes "added the screen to four of the five" the
 * characteristic bug: navigation works everywhere the author happened to test
 * and throws "The action 'NAVIGATE' was not handled" on the fifth.
 *
 * Asserted against the source rather than by rendering: mounting the real
 * navigator pulls in gesture-handler, reanimated and the whole screen tree,
 * which is a lot of machinery to prove a registration list is consistent.
 */
const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'MainNavigator.tsx'), 'utf8',
);

/** Screen names registered inside each `function <Name>Stack() { … }` block. */
function stacks(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const blocks = SOURCE.split(/\nfunction\s+/).slice(1);
  for (const block of blocks) {
    const name = block.slice(0, block.indexOf('('));
    if (!name.endsWith('Stack')) continue;
    out[name] = [...block.matchAll(/<Stack\.Screen\s+name="([^"]+)"/g)].map((m) => m[1]);
  }
  return out;
}

describe('MainNavigator — screen registration', () => {
  const TAB_STACKS = ['DiscussionsStack', 'FindStack', 'HomeStack', 'NewsStack', 'ProfileStack'];

  it('finds the five tab stacks plus the separate onboarding stack', () => {
    expect(Object.keys(stacks()).sort())
      .toEqual([...TAB_STACKS, 'OnboardingStack'].sort());
  });

  it('registers GroupAttributes in every stack that can reach GroupChat', () => {
    // "View all data" is pushed from the group screen, so it has to exist in
    // the same stack — this is the one that catches a four-of-five edit.
    const missing = Object.entries(stacks())
      .filter(([, screens]) => screens.includes('GroupChat') && !screens.includes('GroupAttributes'))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('registers GroupChat in every TAB stack, so a group is reachable from any tab', () => {
    const missing = TAB_STACKS.filter((name) => !(stacks()[name] || []).includes('GroupChat'));
    expect(missing).toEqual([]);
  });

  it('leaves the onboarding stack free of group screens', () => {
    // Onboarding is a pre-account flow with its own linear stack — pulling
    // group screens into it would let a half-onboarded user reach a cohort.
    const onboarding = stacks().OnboardingStack || [];
    expect(onboarding.filter((s) => s.startsWith('Group'))).toEqual([]);
  });

  it('registers Post in every stack that launches it (Home FAB + Discussions "Start a discussion")', () => {
    // DiscussionsScreen's "Start a discussion" does navigate('Post', { kind }),
    // so Post must live in the Discussions stack too — else it throws at runtime.
    for (const name of ['HomeStack', 'DiscussionsStack']) {
      expect(stacks()[name] || []).toContain('Post');
    }
  });

  it('never registers the same screen name twice in one stack', () => {
    // A duplicate silently shadows the first registration.
    const dupes = Object.entries(stacks())
      .map(([name, screens]) => [name, screens.filter((s, i) => screens.indexOf(s) !== i)] as const)
      .filter(([, d]) => d.length);
    expect(dupes).toEqual([]);
  });

  it('imports every component it registers', () => {
    // A name registered against an undefined import renders a blank screen
    // rather than failing at build time.
    const components = [...SOURCE.matchAll(/<Stack\.Screen\s+name="[^"]+"\s+component=\{(\w+)\}/g)]
      .map((m) => m[1]);
    const unimported = [...new Set(components)].filter(
      (c) => !new RegExp(`\\b${c}\\b`).test(SOURCE.slice(0, SOURCE.indexOf('function '))),
    );
    expect(unimported).toEqual([]);
  });
});
