import type { ExpoConfig } from "expo/config";

/** Keep fork identity and signing overrides separate from upstream's app configuration. */
export function withPulseMobileConfig(
  config: ExpoConfig,
  env: Record<string, string | undefined>,
): ExpoConfig {
  const development = env.APP_VARIANT === "development";
  const bundleIdentifier =
    env.T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID ||
    (development ? "com.chanyeinthaw.pulse.dev" : "com.chanyeinthaw.pulse");
  return {
    ...config,
    version: env.APP_VERSION ?? "0.0.0",
    name: development ? "Pulse Dev" : "Pulse",
    slug: "pulse",
    scheme: development ? "pulse-dev" : "pulse",
    updates: { ...config.updates, enabled: false },
    plugins:
      env.T3CODE_IOS_PERSONAL_TEAM === "1"
        ? ["./plugins/withPulsePersonalTeamSigning.cjs", ...(config.plugins ?? [])]
        : config.plugins,
    ios: {
      ...config.ios,
      bundleIdentifier,
      ...(env.PULSE_IOS_TEAM_ID ? { appleTeamId: env.PULSE_IOS_TEAM_ID } : {}),
      associatedDomains: [],
      entitlements: {
        ...config.ios?.entitlements,
        "keychain-access-groups": [`$(AppIdentifierPrefix)${bundleIdentifier}`],
      },
      infoPlist: {
        ...config.ios?.infoPlist,
        NSLocalNetworkUsageDescription:
          "Allow Pulse to connect to your hub on your local network or tailnet.",
      },
    },
    android: { ...config.android, package: bundleIdentifier },
    extra: { ...config.extra, clerk: {}, relay: {} },
  };
}
