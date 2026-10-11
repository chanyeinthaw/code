const { withEntitlementsPlist } = require("expo/config-plugins");

/** Register first so this runs after plugins that add paid-team capabilities. */
module.exports = function withPulsePersonalTeamSigning(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    delete modConfig.modResults["com.apple.developer.associated-domains"];
    delete modConfig.modResults["com.apple.developer.applesignin"];
    delete modConfig.modResults["com.apple.security.application-groups"];
    return modConfig;
  });
};
