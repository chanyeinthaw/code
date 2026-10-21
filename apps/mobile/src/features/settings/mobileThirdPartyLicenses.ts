import {
  decodeThirdPartyLicenseManifest,
  type ThirdPartyLicenseManifest,
} from "@satslab/shared/thirdPartyLicenses";

let cachedManifest: ThirdPartyLicenseManifest | undefined;

export function getMobileThirdPartyLicenses(): ThirdPartyLicenseManifest {
  if (cachedManifest) return cachedManifest;
  const generatedManifest: unknown = require("@satslab/mobile-third-party-licenses");
  cachedManifest = decodeThirdPartyLicenseManifest(generatedManifest);
  return cachedManifest;
}
