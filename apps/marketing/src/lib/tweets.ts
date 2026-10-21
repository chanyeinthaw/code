export type Tweet = {
  name: string;
  handle: string;
  content: string;
};

// Fictional character posts; portraits: https://www.tvmaze.com/shows/143/silicon-valley/cast
export const tweets = [
  {
    name: "Richard Hendricks",
    handle: "richardhendricks",
    content:
      "I put all my agents in Sora. Now the only thing spiraling out of control is the company.",
  },
  {
    name: "Gilfoyle",
    handle: "gilfoyle",
    content:
      "It runs locally. It is open source. I have exhausted my reasons to complain. For now.",
  },
  {
    name: "Dinesh Chugtai",
    handle: "dinesh",
    content: "My agent shipped before Gilfoyle’s. That is the only benchmark that matters.",
  },
  {
    name: "Jared Dunn",
    handle: "jareddunn",
    content: "One surface for all your agents. A healthy working environment is so important.",
  },
  {
    name: "Gavin Belson",
    handle: "gavinbelson",
    content: "We are announcing Hooli Sora. It is exactly this, but with a mandatory keynote.",
  },
  {
    name: "Monica Hall",
    handle: "monicahall",
    content: "Free, open source, and no token markup. Finally, a pitch deck I can get through.",
  },
  {
    name: "Big Head",
    handle: "bighead",
    content: "I left the agents running and went to get food. Apparently we shipped something.",
  },
  {
    name: "Erlich Bachman",
    handle: "erlichbachman",
    content: "This is not a coding app. This is an incubator. My ten percent is non-negotiable.",
  },
  {
    name: "Jian-Yang",
    handle: "jianyang",
    content: "Erlich, your app has six terminals. Mine has one Sora. Very efficient.",
  },
  {
    name: "Laurie Bream",
    handle: "lauriebream",
    content: "I have reviewed the unit economics. Zero dollars is an acceptable acquisition cost.",
  },
  {
    name: "Russ Hanneman",
    handle: "russhanneman",
    content: "This thing ships. This thing absolutely ships.",
  },
  {
    name: "Jack Barker",
    handle: "jackbarker",
    content: "We should put Sora in a box. Enterprise customers love a box.",
  },
  {
    name: "Peter Gregory",
    handle: "petergregory",
    content: "Sora. Yes. I see. Carry on.",
  },
] satisfies Tweet[];
