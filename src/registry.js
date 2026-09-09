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
    if (this.slashMap.has(spec.name)) throw new Error(`Дубликат команды /${spec.name}`);
    this.slashMap.set(spec.name, spec);
  }

  prefix(spec) {
    if (!spec || !spec.name) throw new Error("prefix: name обязателен");
    const names = [spec.name, ...(spec.aliases || [])];
    for (const n of names) {
      if (this.prefixMap.has(n)) throw new Error(`Дубликат префиксной команды !${n}`);
      this.prefixMap.set(n, spec);
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

  /** Найти обработчик для interaction */
  matchComponent(interaction) {
    const id = interaction.customId;
    if (id === null || id === undefined) return null;
    const exact = this.components.find((c) => c.exact && c.id === id);
    if (exact) return exact;
    return this.components.find((c) => !c.exact && id.startsWith(c.id)) || null;
  }

  async emit(eventName, ...args) {
    const handlers = this.eventsMap.get(eventName);
    if (!handlers) return;
    for (const fn of handlers) {
      try {
        await fn(...args);
      } catch (err) {
        console.error(`Ошибка в событии ${eventName}:`, err);
      }
    }
  }

  getSlashPayload() {
    const out = [];
    for (const s of this.slashMap.values()) {
      out.push({
        name: s.name,
        description: s.description || "",
        options: s.options || [],
        default_permission: s.defaultPermission,
      });
    }
    return out;
  }

  findSlash(name) {
    return this.slashMap.get(name);
  }
}