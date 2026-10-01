export default {
  expo: {
name: "Meridian",
    slug: "meridian",
    owner: "krishmalik",
    version: "1.2.0",
    scheme: "meridian",
    orientation: "portrait",
    icon: "./assets/app-icon.png",
    userInterfaceStyle: "light",
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.krishmalik.meridian",
      buildNumber: "1",
      // Sign in with Apple (App Store Guideline 4.8). Injects the
      // com.apple.developer.applesignin entitlement on prebuild (CNG) — do NOT
      // hand-edit ios/*.entitlements, it is regenerated.
      usesAppleSignIn: true,
      googleServicesFile: process.env.GOOGLE_SERVICES_PLIST || "./config/GoogleService-Info.plist",
      infoPlist: {
        CFBundleURLTypes: [
          {
            CFBundleURLSchemes: [
              "com.googleusercontent.apps.971592620882-001kh4740otue78vp6c6fem3f7k4cadl"
            ]
          }
        ],
        ITSAppUsesNonExemptEncryption: false
      }
    },
    android: {
      package: "com.krishmalik.meridian",
      versionCode: 1,
      adaptiveIcon: {
        backgroundColor: "#FFFFFF",
        foregroundImage: "./assets/app-icon-android-foreground.png",
        monochromeImage: "./assets/app-icon-android-monochrome.png"
      },
      predictiveBackGestureEnabled: false
    },
    web: {
      favicon: "./assets/favicon.png"
    },
    plugins: [
      "expo-font",
      [
        "expo-splash-screen",
        {
          image: "./assets/splash-logo.png",
          imageWidth: 200,
          resizeMode: "contain",
          backgroundColor: "#AE0000"
        }
      ],
      "expo-web-browser",
      "expo-status-bar",
      [
        "@react-native-google-signin/google-signin",
        {
          iosUrlScheme: "com.googleusercontent.apps.971592620882-001kh4740otue78vp6c6fem3f7k4cadl"
        }
      ],
      "./plugins/withModularHeaders"
    ],
    extra: {
      eas: {
        projectId: "32aefb08-a393-4fae-966e-865bfee02758"
      }
    }
  }
};
