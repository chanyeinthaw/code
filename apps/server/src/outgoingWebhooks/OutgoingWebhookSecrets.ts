const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** Secret store names (files, so only filename-safe characters). */
export const endpointSecretName = (webhookId: string) =>
  `outgoing-webhook-${encode(webhookId)}-url`;
export const headerSecretName = (webhookId: string, headerName: string) =>
  `outgoing-webhook-${encode(webhookId)}-header-${encode(headerName.toLowerCase())}`;
