require('dotenv').config();
const YouTubeShortsGenerator = require('./YouTubeShortsGenerator');
const fs = require('fs').promises;
const readline = require('readline');
const path = require('path');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

async function main() {
    try {
        const generator = new YouTubeShortsGenerator({
            openaiApiKey: process.env.OPENAI_API_KEY
        });

        console.log('\n=== YouTube Shorts Generator ===');
        const videoUrl = await question('Введите URL YouTube видео: ');

        console.log('\n1. Загрузка видео...');
        const videoPath = await generator.downloadVideo(videoUrl);

        if (!videoPath) {
            console.error('❌ Не удалось скачать видео');
            return;
        }
        console.log('✅ Видео успешно загружено\n');

        console.log('2. Анализ видео и создание шортсов...');
        const shorts = await generator.generateShorts(videoPath);

        if (shorts && shorts.length > 0) {
            console.log('✅ Шортсы успешно созданы\n');

            console.log('3. Анализ потенциала каждого шортса...');
            for (const short of shorts) {
                if (!short || !short.path) continue;

                console.log(`\n📊 Анализ шортса: ${path.basename(short.path)}`);
                console.log(`📝 Описание момента: ${short.description}`);

                const analysis = await generator.analyzePotentialViews(short.path);
                console.log(`\n🎯 Ожидаемые просмотры: ${analysis.views.toLocaleString('ru-RU')}`);
                console.log('\n📝 Подробный анализ:');
                console.log(analysis.analysis);
                console.log('\n---');
            }
        } else {
            console.log('❌ Не удалось создать шортсы');
        }

        // Удаляем исходное видео после обработки
        await fs.unlink(videoPath);
        console.log('\n✨ Готово!');
    } catch (error) {
        console.error('\n❌ Произошла ошибка:', error);
    } finally {
        rl.close();
    }
}

main();
