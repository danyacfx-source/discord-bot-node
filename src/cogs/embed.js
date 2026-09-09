import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { log } from "../notify.js";

const HEX_RE = /^#?([0-9a-fA-F]{6})$/;

const COLOR_NAMES = {
  red: 0xe74c3c,
  orange: 0xe67e22,
  yellow: 0xf1c40f,
  green: 0x2ecc71,
  teal: 0x1abc9c,
  blue: 0x3498db,
  darkblue: 0x206694,
  purple: 0x9b59b6,
  pink: 0xe91e63,
  white: 0xffffff,
  gray: 0x95a5a6,
  dark: 0x2c2f33,
};

class EmbedDraft {
  constructor() {
    this.title = null;
    this.description = null;
    this.color = null;
    this.authorName = null;
    this.authorIcon = null;
    this.authorUrl = null;
    this.footerText = null;
    this.footerIcon = null;
    this.thumbnail = null;
    this.image = null;
    this.timestamp = false;
    this.fields = [];
    this.targetChannelId = null;
  }

  toEmbed() {
    const e = new EmbedBuilder();
    if (this.title) e.setTitle(this.title);
    if (this.description) e.setDescription(this.description);
    if (this.color !== null) e.setColor(this.color);
    if (this.authorName) {
      e.setAuthor({
        name: this.authorName,
        url: this.authorUrl || undefined,
        iconURL: this.authorIcon || undefined,
      });
    }
    if (this.footerText) {
      e.setFooter({
        text: this.footerText,
        iconURL: this.footerIcon || undefined,
      });
    }
    if (this.thumbnail) e.setThumbnail(this.thumbnail);
    if (this.image) e.setImage(this.image);
    if (this.timestamp) e.setTimestamp(new Date());
    for (const f of this.fields) {
      if (f.name && f.value != null) {
        e.addFields({ name: f.name, value: f.value, inline: f.inline });
      }
    }
    return e;
  }

  isEmpty() {
    return !(
      this.title ||
      this.description ||
      this.color !== null ||
      this.authorName ||
      this.footerText ||
      this.thumbnail ||
      this.image ||
      this.timestamp ||
      this.fields.length > 0
    );
  }
}

const drafts = new Map();
const MAX_DRAFTS = 200;

function getDraft(userId) {
  if (drafts.size > MAX_DRAFTS && !drafts.has(userId)) {
    const first = drafts.keys().next().value;
    if (first !== undefined) drafts.delete(first);
  }
  if (!drafts.has(userId)) drafts.set(userId, new EmbedDraft());
  return drafts.get(userId);
}

function render(draft, ownerUserId) {
  let embed;
  if (draft.isEmpty()) {
    embed = new EmbedBuilder()
      .setTitle("🎨 Конструктор эмбеда")
      .setDescription(
        "Эмбед пока пуст. Настраивайте его кнопками ниже — превью обновится автоматически."
      )
      .setColor(0x5865f2);
  } else {
    embed = draft.toEmbed();
  }

  const rows = [];

  // Row 0: title, desc, color, time
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("embed_title").setLabel("✏️ Заголовок").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("embed_desc").setLabel("📝 Описание").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("embed_color").setLabel("🎨 Цвет").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("embed_time").setLabel("🕒 Время").setStyle(ButtonStyle.Secondary)
    )
  );

  // Row 1: field, media, author, footer
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("embed_add_field").setLabel("🧩 Поле").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("embed_media").setLabel("🖼 Медиа").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("embed_author").setLabel("👤 Автор").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("embed_footer").setLabel("📌 Футер").setStyle(ButtonStyle.Secondary)
    )
  );

  // Row 2: reset, send
  rows.push(
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("embed_reset").setLabel("🗑 Сброс").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("embed_send").setLabel("🚀 Отправить").setStyle(ButtonStyle.Success)
    )
  );

  // Row 3: delete field select
  const fieldOptions =
    draft.fields.length > 0
      ? draft.fields.map((f, i) => ({
          label: (f.name || `Поле ${i + 1}`).slice(0, 60),
          value: String(i),
        }))
      : [{ label: "Нет полей", value: "0" }];
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("embed_delete_field")
        .setPlaceholder("🗑 Удалить поле...")
        .setMinValues(1)
        .setMaxValues(1)
        .setOptions(fieldOptions)
        .setDisabled(draft.fields.length === 0)
    )
  );

  // Row 4: target channel select
  rows.push(
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("embed_target_channel")
        .setPlaceholder("📨 Куда отправить...")
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(0)
    )
  );

  return { embed, rows };
}

function checkOwner(interaction, ownerUserId) {
  if (interaction.user.id !== ownerUserId) {
    interaction.reply({ content: "Это не ваш черновик.", ephemeral: true });
    return false;
  }
  return true;
}

const cog = {
  name: "EmbedBuilder",
  async setup(registry) {
    // Слеш-команда /embed
    registry.slash({
      name: "embed",
      description: "Конструктор эмбеда",
      guildOnly: true,
      options: [],
      async run(interaction) {
        const draft = getDraft(interaction.user.id);
        const { embed, rows } = render(draft, interaction.user.id);
        await interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
      },
    });

    // --- Модалки ---
    registry.componentPrefix("embed_title_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const val = interaction.fields.getTextInputValue("embed_title_input");
      draft.title = val.trim() || null;
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.componentPrefix("embed_desc_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const val = interaction.fields.getTextInputValue("embed_desc_input");
      draft.description = val.trim() || null;
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.componentPrefix("embed_color_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const raw = interaction.fields.getTextInputValue("embed_color_input").trim().toLowerCase();
      if (!raw) {
        draft.color = null;
      } else if (COLOR_NAMES[raw] !== undefined) {
        draft.color = COLOR_NAMES[raw];
      } else {
        const m = raw.match(HEX_RE);
        if (m) {
          draft.color = parseInt(m[1], 16);
        } else {
          await interaction.reply({ content: "Неверный цвет. Примеры: `#ff0000`, `red`, `3498DB`.", ephemeral: true });
          return;
        }
      }
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.componentPrefix("embed_author_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const name = interaction.fields.getTextInputValue("embed_author_name").trim() || null;
      const icon = interaction.fields.getTextInputValue("embed_author_icon").trim() || null;
      const url = interaction.fields.getTextInputValue("embed_author_url").trim() || null;
      for (const v of [icon, url]) {
        if (v && !v.startsWith("http://") && !v.startsWith("https://")) {
          await interaction.reply({ content: "Ссылка должна начинаться с http:// или https://", ephemeral: true });
          return;
        }
      }
      draft.authorName = name;
      draft.authorIcon = icon;
      draft.authorUrl = url;
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.componentPrefix("embed_footer_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const text = interaction.fields.getTextInputValue("embed_footer_text").trim() || null;
      const icon = interaction.fields.getTextInputValue("embed_footer_icon").trim() || null;
      if (icon && !icon.startsWith("http://") && !icon.startsWith("https://")) {
        await interaction.reply({ content: "Ссылка должна начинаться с http:// или https://", ephemeral: true });
        return;
      }
      draft.footerText = text;
      draft.footerIcon = icon;
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.componentPrefix("embed_media_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const image = interaction.fields.getTextInputValue("embed_media_image").trim() || null;
      const thumbnail = interaction.fields.getTextInputValue("embed_media_thumb").trim() || null;
      for (const v of [image, thumbnail]) {
        if (v && !v.startsWith("http://") && !v.startsWith("https://")) {
          await interaction.reply({ content: "Ссылка должна начинаться с http:// или https://", ephemeral: true });
          return;
        }
      }
      draft.image = image;
      draft.thumbnail = thumbnail;
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.componentPrefix("embed_field_modal", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      if (draft.fields.length >= 25) {
        await interaction.reply({ content: "Максимум 25 полей.", ephemeral: true });
        return;
      }
      const name = interaction.fields.getTextInputValue("embed_field_name").trim();
      const value = interaction.fields.getTextInputValue("embed_field_value").trim();
      if (!name) {
        await interaction.reply({ content: "Название поля не может быть пустым.", ephemeral: true });
        return;
      }
      const inlineRaw = interaction.fields.getTextInputValue("embed_field_inline").trim().toLowerCase();
      draft.fields.push({ name, value, inline: inlineRaw.startsWith("д") });
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    // --- Кнопки ---
    registry.component("embed_title", async (interaction) => {
      const draft = getDraft(interaction.user.id);
      const modal = new ModalBuilder()
        .setCustomId("embed_title_modal")
        .setTitle("Заголовок эмбеда")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_title_input")
              .setLabel("Заголовок")
              .setRequired(false)
              .setMaxLength(256)
              .setStyle(TextInputStyle.Short)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_desc", async (interaction) => {
      const modal = new ModalBuilder()
        .setCustomId("embed_desc_modal")
        .setTitle("Описание эмбеда")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_desc_input")
              .setLabel("Описание")
              .setRequired(false)
              .setMaxLength(4000)
              .setStyle(TextInputStyle.Paragraph)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_color", async (interaction) => {
      const modal = new ModalBuilder()
        .setCustomId("embed_color_modal")
        .setTitle("Цвет эмбеда")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_color_input")
              .setLabel("Цвет (hex или имя)")
              .setRequired(false)
              .setMaxLength(16)
              .setPlaceholder("#ff0000, red, 3498DB")
              .setStyle(TextInputStyle.Short)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_time", async (interaction) => {
      if (!checkOwner(interaction, interaction.user.id)) return;
      const draft = getDraft(interaction.user.id);
      draft.timestamp = !draft.timestamp;
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.component("embed_add_field", async (interaction) => {
      const modal = new ModalBuilder()
        .setCustomId("embed_field_modal")
        .setTitle("Новое поле")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_field_name")
              .setLabel("Название поля")
              .setRequired(false)
              .setMaxLength(256)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_field_value")
              .setLabel("Значение поля")
              .setRequired(false)
              .setMaxLength(1024)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_field_inline")
              .setLabel("В одну строку? (да/нет)")
              .setRequired(false)
              .setMaxLength(3)
              .setValue("да")
              .setStyle(TextInputStyle.Short)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_media", async (interaction) => {
      const modal = new ModalBuilder()
        .setCustomId("embed_media_modal")
        .setTitle("Медиа эмбеда")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_media_image")
              .setLabel("Ссылка на изображение")
              .setRequired(false)
              .setMaxLength(1024)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_media_thumb")
              .setLabel("Ссылка на миниатюру")
              .setRequired(false)
              .setMaxLength(1024)
              .setStyle(TextInputStyle.Short)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_author", async (interaction) => {
      const modal = new ModalBuilder()
        .setCustomId("embed_author_modal")
        .setTitle("Автор эмбеда")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_author_name")
              .setLabel("Имя автора")
              .setRequired(false)
              .setMaxLength(256)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_author_icon")
              .setLabel("Ссылка на иконку (необязательно)")
              .setRequired(false)
              .setMaxLength(1024)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_author_url")
              .setLabel("Ссылка при клике (необязательно)")
              .setRequired(false)
              .setMaxLength(1024)
              .setStyle(TextInputStyle.Short)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_footer", async (interaction) => {
      const modal = new ModalBuilder()
        .setCustomId("embed_footer_modal")
        .setTitle("Футер эмбеда")
        .addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_footer_text")
              .setLabel("Текст футера")
              .setRequired(false)
              .setMaxLength(2048)
              .setStyle(TextInputStyle.Short)
          ),
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("embed_footer_icon")
              .setLabel("Ссылка на иконку (необязательно)")
              .setRequired(false)
              .setMaxLength(1024)
              .setStyle(TextInputStyle.Short)
          )
        );
      await interaction.showModal(modal);
    });

    registry.component("embed_reset", async (interaction) => {
      if (!checkOwner(interaction, interaction.user.id)) return;
      drafts.set(interaction.user.id, new EmbedDraft());
      const draft = getDraft(interaction.user.id);
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.component("embed_send", async (interaction) => {
      if (!checkOwner(interaction, interaction.user.id)) return;
      const draft = getDraft(interaction.user.id);
      if (draft.isEmpty()) {
        await interaction.reply({ content: "Эмбед пуст — добавьте хотя бы заголовок или описание.", ephemeral: true });
        return;
      }
      const embed = draft.toEmbed();
      const targetId = draft.targetChannelId || interaction.channelId;
      const target = interaction.guild.channels.cache.get(String(targetId));
      if (!target) {
        await interaction.reply({ content: "Канал не найден.", ephemeral: true });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      try {
        await target.send({ embeds: [embed] });
      } catch (e) {
        log.error("EmbedBuilder", `Не удалось отправить эмбед: ${e.message}`);
        await interaction.editReply({ content: `❌ Не удалось отправить эмбед: ${e.message}` });
        return;
      }
      await interaction.editReply({ content: `✅ Эмбед отправлен в <#${target.id}>.` });
    });

    // --- Селекты ---
    registry.component("embed_delete_field", async (interaction) => {
      if (!checkOwner(interaction, interaction.user.id)) return;
      const values = interaction.values || [];
      const draft = getDraft(interaction.user.id);
      if (values.length > 0) {
        const idx = parseInt(values[0], 10);
        if (Number.isFinite(idx) && idx >= 0 && idx < draft.fields.length) {
          draft.fields.splice(idx, 1);
        }
      }
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });

    registry.component("embed_target_channel", async (interaction) => {
      if (!checkOwner(interaction, interaction.user.id)) return;
      const values = interaction.values || [];
      const draft = getDraft(interaction.user.id);
      if (values.length > 0) {
        draft.targetChannelId = values[0];
      }
      const { embed, rows } = render(draft, interaction.user.id);
      await interaction.update({ embeds: [embed], components: rows });
    });
  },
};

export default cog;
