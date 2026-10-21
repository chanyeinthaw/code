import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "SoraMarketing",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Stage;
    const site = yield* Cloudflare.Website.StaticSite("Website", {
      command: "node --run build",
      outdir: "dist",
      domain: stage === "prod" ? "sora.satslab.xyz" : undefined,
      workersDev: stage !== "prod",
      assets: { notFoundHandling: "404-page" },
    });
    return { url: site.url };
  }),
);
