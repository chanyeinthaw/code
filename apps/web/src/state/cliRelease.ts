import { useAtomValue } from "@effect/atom-react";
import {
  cliReleaseTagUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  type CliReleaseChannel,
} from "@satslab/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { useEnvironmentQuery } from "./query";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * Servers install updates from the GitHub release, so a version is installable once that
 * release is published. Draft releases answer 404 here, which keeps half-uploaded ones out.
 */
export const cliReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(
    Effect.gen(function* () {
      const response = yield* HttpClient.get(cliReleaseTagUrl(version));
      if (response.status === 404) return false;
      const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
        Effect.flatMap((ok) => ok.json),
      );
      return typeof body === "object" && body !== null && "tag_name" in body
        ? body.tag_name === `v${version}` && !("draft" in body && body.draft === true)
        : false;
    }).pipe(
      // Tracing headers would make the browser send a CORS preflight, which GitHub's API rejects.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`cli-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("cli-release-published:none"),
);

export function useCliReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? cliReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
  }),
);

// Server discovery must keep working when the desktop app updater is disabled.
export const latestCliReleaseAtom = Atom.family((channel: CliReleaseChannel) =>
  Atom.make(
    Effect.gen(function* () {
      for (let page = 1; ; page++) {
        const response = yield* HttpClient.get(cliReleaseIndexPageUrl(page));
        const releases = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(ReleaseIndex)),
        );
        const version = newestCliReleaseVersion(releases, channel);
        if (version !== undefined) return version;
        if (releases.length < 100) return null;
      }
    }).pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`cli-latest-release:${channel}`),
  ),
);

export function useLatestCliRelease(channel: CliReleaseChannel) {
  return useEnvironmentQuery(latestCliReleaseAtom(channel));
}
