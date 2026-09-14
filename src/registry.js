/**
 * Registry — инфраструктура когов.
 *
 * cog экспортирует объект: { name, setup(registry) }
 *   registry.slash({ name, description, options?, guildOnly?, run })
 *   registry.prefix({ name, aliases?, run })
 *   registry.event('messageCreate', fn)            // discord.js имя события
 *   registry.componentP('customIdPrefix', fn)      // кнопки/селекты/модалки (startsWith)
 *   registry.component('customId', fn)             // точный customId
 */
export class Registry {
  constructor(client) {
    this.client = client;
    this.slashMap = new Map();
    this.prefixMap = new Map();
    this.eventsMap = new Map();
    this.components = [];
  }

  slash(spec) {
    if (!spec || !spec.name) throw new Error("slash: name обязателен");
    if (this.slashMap.has(spec.name)) {
      throw new Error(`Дубликат команды /${spec.name}`);
    }
    this.slashMap.set(spec.name, spec);
  }

  prefix(spec) {
    if (!spec || !spec.name) throw new Error("prefix: name обязателен");
    const names = [spec.name, ...(spec.aliases || [])];
    for (const n of names) {
      const key = String(n).toLowerCase();
      if (this.prefixMap.has(key)) throw new Error(`Дубликат префиксной команды !${n}`);
      this.prefixMap.set(key, spec);
      // также сохраняем оригинал для совместимости
      if (key !== n) this.prefixMap.set(String(n), spec);
    }
  }

  event(eventName, fn) {
    if (!this.eventsMap.has(eventName)) this.eventsMap.set(eventName, []);
    this.eventsMap.get(eventName).push(fn);
  }

  /** Точный customId */
  component(id, fn) {
    this.components.push({ id, fn, exact: true });
  }

  /** Префикс customId (startsWith) — для кнопок вида "vc_lock:123" */
  componentPrefix(prefix, fn) {
    this.components.push({ id: prefix, fn, exact: false });
  }

  /** Найти обработчик для interaction — longest prefix wins to avoid collisions */
  matchComponent(interaction) {
    const rawId = interaction.customId;
    if (rawId === null || rawId === undefined) return null;
    const id = String(rawId);
    if (typeof id !== "string") return null;
    const exact = this.components.find((c) => c.exact && String(c.id) === id);
    if (exact) return exact;
    let best = null;
    for (const c of this.components) {
      if (c.exact) continue;
      const cid = String(c.id);
      if (id.startsWith(cid)) {
        if (!best || cid.length > String(best.id).length) best = c;
      }
    }
    return best;
  }

  async emit(eventName, ...args) {
    const handlers = this.eventsMap.get(eventName);
    if (!handlers) return;
    const results = await Promise.allSettled(handlers.map((fn) => fn(...args)));
    for (const r of results) {
      if (r.status === "rejected") console.error(`Ошибка в событии ${eventName}:`, r.reason);
    }
  }

  getSlashPayload() {
    const out = [];
    for (const s of this.slashMap.values()) {
      const payload = {
        name: s.name,
        description: s.description || "",
        options: s.options || [],
      };
      if (s.defaultMemberPermissions !== undefined) payload.default_member_permissions = String(s.defaultMemberPermissions);
      else if (s.default_member_permissions !== undefined) payload.default_member_permissions = String(s.default_member_permissions);
      // deprecated default_permission no longer sent; map to default_member_permissions if present
      else if (s.defaultPermission !== undefined) {
        // если передано как бит или строка — конвертируем
        try { payload.default_member_permissions = String(s.defaultPermission); } catch {}
      }
      if (s.dmPermission !== undefined) payload.dm_permission = !!s.dmPermission;
      else if (s.dm_permission !== undefined) payload.dm_permission = !!s.dm_permission;
      out.push(payload);
    }
    return out;
  }

  findSlash(name) {
    return this.slashMap.get(name);
  }
}