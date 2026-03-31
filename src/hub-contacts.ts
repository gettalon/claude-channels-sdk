/**
 * hub-contacts.ts — Contact registry for ChannelHub.
 * Extracted from hub.ts (lines 1565–1667).
 */
import type { ChannelHub, ContactEntry, ContactChannel } from "./hub.js";

/** Install contact registry methods onto the ChannelHub prototype. */
export function installContacts(Hub: typeof ChannelHub): void {

  /**
   * Register a contact name with a channel endpoint.
   * If the contact already exists, the channel is added/updated (no duplicates by type+id).
   */
  Hub.prototype.registerContact = function(this: ChannelHub, name: string, channelType: string, id: string, url?: string): { ok: boolean } {
    const resolvedUrl = url ?? `${channelType}://${id}`;
    const existing = this.contacts.get(name);
    if (existing) {
      const idx = existing.channels.findIndex(c => c.type === channelType && c.id === id);
      if (idx >= 0) {
        existing.channels[idx].url = resolvedUrl;
      } else {
        existing.channels.push({ type: channelType, id, url: resolvedUrl });
      }
    } else {
      this.contacts.set(name, { name, channels: [{ type: channelType, id, url: resolvedUrl }] });
    }
    (this as any).persistContacts().catch(() => {});
    process.stderr.write(`[${this.name}] Contact registered: ${name} -> ${channelType}:${id}\n`);
    return { ok: true };
  };

  /**
   * Remove a contact by name.
   */
  Hub.prototype.removeContact = function(this: ChannelHub, name: string): { ok: boolean; error?: string } {
    if (!this.contacts.has(name)) return { ok: false, error: `Contact "${name}" not found` };
    this.contacts.delete(name);
    (this as any).persistContacts().catch(() => {});
    process.stderr.write(`[${this.name}] Contact removed: ${name}\n`);
    return { ok: true };
  };

  /**
   * Resolve a name-or-id to the contact's preferred channel + id.
   * Returns the first channel entry of the matching contact, or undefined.
   * Lookup order: exact name match, then scan channel ids.
   */
  Hub.prototype.resolveContact = function(this: ChannelHub, nameOrId: string): { contact: ContactEntry; channel: ContactChannel } | undefined {
    // 1. Exact name match
    const byName = this.contacts.get(nameOrId);
    if (byName && byName.channels.length > 0) {
      // Prefer a non-agent channel if available (e.g. telegram over agent)
      const nonAgent = byName.channels.find(c => c.type !== "agent");
      return { contact: byName, channel: nonAgent ?? byName.channels[0] };
    }
    // 2. Scan channel ids (e.g. "938185675" finds the contact that has that telegram id)
    //    Prefer non-agent channel types to avoid routing loops where the hub's own
    //    agent contact shadows real channel transports (e.g. Telegram groups).
    let agentFallback: { contact: ContactEntry; channel: ContactChannel } | undefined;
    for (const entry of this.contacts.values()) {
      for (const ch of entry.channels) {
        if (ch.id === nameOrId) {
          if (ch.type !== "agent") return { contact: entry, channel: ch };
          if (!agentFallback) agentFallback = { contact: entry, channel: ch };
        }
      }
    }
    return agentFallback;
  };

  /** List all registered contacts. */
  Hub.prototype.listContacts = function(this: ChannelHub): ContactEntry[] {
    return [...this.contacts.values()];
  };

  /**
   * Auto-register a contact from an incoming message.
   * Called internally when a chat/reply arrives with a `from` user name
   * and a known channel context (chat_id + transport type).
   */
  (Hub.prototype as any).autoRegisterContact = function(this: ChannelHub, userName: string, chatId: string, channelType: string, url?: string): void {
    if (!userName || userName === "unknown" || userName === "system" || userName === "host") return;
    // Don't auto-register known agents as contacts with type "agent" —
    // this prevents the hub's own agent (e.g. "talon") from shadowing real
    // channel contacts when resolving by chat_id.
    if (channelType === "agent" && this.findAgent(userName)) return;
    const existing = this.contacts.get(userName);
    if (existing) {
      // Only add if this channel endpoint is not already recorded
      const has = existing.channels.some(c => c.type === channelType && c.id === chatId);
      if (has) return;
      existing.channels.push({ type: channelType, id: chatId, url: url ?? `${channelType}://${chatId}` });
    } else {
      this.contacts.set(userName, { name: userName, channels: [{ type: channelType, id: chatId, url: url ?? `${channelType}://${chatId}` }] });
    }
    // Also register in unified target registry
    if ((this as any).registerTarget) {
      (this as any).registerTarget(userName, channelType, chatId, "user");
    }
    (this as any).persistContacts().catch(() => {});
    process.stderr.write(`[${this.name}] Contact auto-registered: ${userName} -> ${channelType}:${chatId}\n`);
  };

  /** Persist contacts to settings.json under the `contacts` key. */
  (Hub.prototype as any).persistContacts = async function(this: ChannelHub): Promise<void> {
    const contactsObj: Record<string, { name: string; channels: Array<{ type: string; id: string; url: string }> }> = {};
    for (const [name, entry] of this.contacts) {
      contactsObj[name] = { name: entry.name, channels: entry.channels };
    }
    const settings = await this.loadSettings();
    settings.contacts = contactsObj;
    await this.saveSettings(settings);
  };

  /** Restore contacts from settings.json (called in autoSetup). */
  (Hub.prototype as any).restoreContacts = async function(this: ChannelHub): Promise<void> {
    const settings = await this.loadSettings();
    if (settings.contacts) {
      for (const [name, entry] of Object.entries(settings.contacts)) {
        if (!this.contacts.has(name)) {
          this.contacts.set(name, { name: entry.name, channels: entry.channels ?? [] });
        }
      }
      if (this.contacts.size > 0) {
        process.stderr.write(`[${this.name}] Restored ${this.contacts.size} contact(s) from settings\n`);
      }
    }
  };
}
