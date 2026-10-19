import { expect, it } from "vite-plus/test";
import { isSidebarUtilityPage } from "./mainAppLocation";

it("keeps dedicated bot settings from replacing the remembered conversation", () => {
  expect(isSidebarUtilityPage("/bots/settings/environment/bot")).toBe(true);
  expect(isSidebarUtilityPage("/bots/environment/root")).toBe(false);
  expect(isSidebarUtilityPage("/bots/environment/subagent")).toBe(false);
  expect(isSidebarUtilityPage("/bots")).toBe(false);
});
