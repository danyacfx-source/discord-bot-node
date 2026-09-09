const MAX_QUESTION_LEN = 300;

const cog = {
  name: "Poll",
  async setup(registry) {
    registry.slash({
      name: "poll",
      description: "Создать опрос в чате",
      guildOnly: true,
      options: [
        { name: "question", description: "Текст вопроса", type: 3, required: true },
        { name: "option1", description: "Первый вариант ответа", type: 3, required: true },
        { name: "option2", description: "Второй вариант ответа", type: 3, required: true },
        { name: "option3", description: "Третий вариант (необязательно)", type: 3, required: false },
        { name: "option4", description: "Четвёртый вариант (необязательно)", type: 3, required: false },
        { name: "option5", description: "Пятый вариант (необязательно)", type: 3, required: false },
        {
          name: "duration_hours",
          description: "Длительность опроса в часах (1-168, по умолчанию 24)",
          type: 4,
          required: false,
        },
        { name: "multiple", description: "Разрешить несколько ответов (по умолчанию нет)", type: 5, required: false },
      ],
      async run(interaction) {
        const question = interaction.options.getString("question", true);
        if (question.length > MAX_QUESTION_LEN) {
          await interaction.reply({
            content: `Вопрос слишком длинный (максимум ${MAX_QUESTION_LEN} символов).`,
            ephemeral: true,
          });
          return;
        }

        const answers = ["option1", "option2", "option3", "option4", "option5"]
          .map((name) => interaction.options.getString(name))
          .filter(Boolean)
          .slice(0, 5);

        const duration = Math.max(1, Math.min(168, interaction.options.getInteger("duration_hours") ?? 24));
        const multiple = interaction.options.getBoolean("multiple") ?? false;

        const poll = {
          question: { text: question },
          answers: answers.map((text) => ({ text })),
          duration,
          allowMultiselect: multiple,
        };

        try {
          await interaction.reply({ poll });
        } catch (e) {
          await interaction.reply({
            content: `Не удалось создать опрос: ${e.message}`,
            ephemeral: true,
          });
        }
      },
    });
  },
};

export default cog;