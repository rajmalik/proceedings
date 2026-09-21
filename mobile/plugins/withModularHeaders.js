const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCOPED_MODULAR_HEADER_PODS = ['GoogleUtilities', 'RecaptchaInterop', 'AppCheckCore'];

/**
 * Config plugin to fix the Swift pod module dependency issue with
 * GoogleUtilities/RecaptchaInterop/AppCheckCore (transitive deps of Google
 * Sign-In) needing modular headers to build as static libs.
 *
 * Scoped `pod '...', :modular_headers => true` per pod, NOT a global
 * `use_modular_headers!` — the global form double-modularizes the Expo pod
 * and produces a Swift "ambiguous implicit access level for import of
 * 'Expo'" build error.
 */
const withModularHeaders = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (config) => {
      const podfilePath = path.join(config.modRequest.platformProjectRoot, 'Podfile');

      if (fs.existsSync(podfilePath)) {
        let podfileContent = fs.readFileSync(podfilePath, 'utf8');

        const podLines = SCOPED_MODULAR_HEADER_PODS
          .filter((name) => !podfileContent.includes(`pod '${name}', :modular_headers => true`))
          .map((name) => `  pod '${name}', :modular_headers => true\n`)
          .join('');

        if (podLines) {
          // Insert right after the target block opens, before use_expo_modules!
          podfileContent = podfileContent.replace(
            /^(target ['"][^'"]+['"] do\n)/m,
            `$1${podLines}`
          );

          fs.writeFileSync(podfilePath, podfileContent);
        }
      }

      return config;
    },
  ]);
};

module.exports = withModularHeaders;
