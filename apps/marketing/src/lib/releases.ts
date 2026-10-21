const REPO = "satslab/sora";

export const RELEASES_URL = `https://github.com/${REPO}/releases`;

const LATEST_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export async function fetchLatestRelease(): Promise<Release> {
  const key = "sora-stable-release";
  const cached = sessionStorage.getItem(key);
  if (cached) return JSON.parse(cached);

  const data: Release = await fetch(LATEST_API_URL).then((response) => response.json());
  if (data?.assets) sessionStorage.setItem(key, JSON.stringify(data));
  return data;
}
