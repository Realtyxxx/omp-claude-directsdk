/** Claude CLI supplies authentication; OMP owns the transcript and tools. */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createProviderConfig, PROVIDER_ID } from "../../src/provider.js";

export default function (pi: ExtensionAPI) {
  // Catalog refresh can finish before any session exists; hold its warnings
  // until a session can show them instead of writing over the TUI.
  const pending: string[] = [];
  let notify: ((message: string) => void) | undefined;
  const report = (message: string): void => {
    if (notify) notify(message);
    else pending.push(message);
  };
  pi.on("session_start", (_event, context) => {
    const sink = context.hasUI
      ? (message: string) => context.ui.notify(message, "warning")
      : (message: string) => { console.error(message); };
    notify = sink;
    for (const message of pending.splice(0)) sink(message);
  });
  pi.registerProvider(PROVIDER_ID, createProviderConfig(report));
}
