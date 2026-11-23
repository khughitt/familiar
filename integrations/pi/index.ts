// familiar's status line in pi's footer. pi loads this directory as an extension
// (index.ts entry point); docs/install.md#pi says how to install it. The wiring lives in
// statusline.js, tested against a fake pi; this file hands it pi-tui's width helper.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { commandFrom, installStatusline } from "./statusline.js";

export default function familiarStatusline(pi: ExtensionAPI) {
  installStatusline(pi, { truncateToWidth, command: commandFrom(process.env), env: process.env });
}
