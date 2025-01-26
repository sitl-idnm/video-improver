const fs = require('fs').promises;
const path = require('path');
const { OpenAI } = require('openai');
const youtubeDl = require('youtube-dl-exec');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);
const { installFfmpeg } = require('./ffmpeg-installer');
const readline = require('readline');

class YouTubeShortsGenerator {
    constructor(options = {}) {
        this.outputDir = options.outputDir || 'output_shorts';
        this.sourceDir = path.join(this.outputDir, 'source_videos');
        const apiKey = options.openaiApiKey || process.env.OPENAI_API_KEY;

        if (!apiKey) {
            throw new Error('OpenAI API ключ не найден. Пожалуйста, укажите его в .env файле или передайте в конструктор');
        }

        this.openai = new OpenAI({ apiKey });
        this.progressBarWidth = 30; // Ширина полоски прогресса
        this.currentProcess = '';
        // Добавляем счетчики для токенов и стоимости
        this.totalTokens = 0;
        this.totalCost = 0;
        // Цены за 1000 токенов (в долларах)
        this.gptPrices = {
            'gpt-4': { input: 0.03, output: 0.06 },
            'gpt-3.5-turbo': { input: 0.001, output: 0.002 }
        };
        this.init();
    }

    async init() {
        try {
            await fs.mkdir(this.outputDir, { recursive: true });
            await fs.mkdir(this.sourceDir, { recursive: true });
            await this.checkAndInstallFfmpeg();
        } catch (error) {
            console.error('Ошибка при инициализации:', error);
        }
    }

    async checkAndInstallFfmpeg() {
        try {
            await this.checkFfmpeg();
        } catch (error) {
            console.log('FFmpeg не найден. Пытаемся установить...');
            await installFfmpeg();
            await this.checkFfmpeg();
        }
    }

    async checkFfmpeg() {
        try {
            await execAsync('ffmpeg -version');
            await execAsync('ffprobe -version');
            console.log('FFmpeg и FFprobe успешно обнаружены');
        } catch (error) {
            throw new Error(
                'FFmpeg или FFprobe не найдены. Пожалуйста, установите их:\n' +
                'Windows (через chocolatey): choco install ffmpeg\n' +
                'Windows (через scoop): scoop install ffmpeg\n' +
                'Mac: brew install ffmpeg\n' +
                'Linux: sudo apt-get install ffmpeg'
            );
        }
    }

    showProcessProgress(processName, percent, details = '') {
        this.currentProcess = processName;
        const filled = Math.round(this.progressBarWidth * (percent / 100));
        const empty = this.progressBarWidth - filled;
        const progressBar = '█'.repeat(filled) + '░'.repeat(empty);

        let message = `\r${processName} [${progressBar}] ${percent.toFixed(1)}%`;
        if (details) {
            message += ` ${details}`;
        }
        // Используем глобальный process.stdout
        global.process.stdout.write(message);
    }

    async downloadVideo(url) {
        try {
            this.showProcessProgress('Получение информации', 0);
            const info = await youtubeDl(url, {
                dumpSingleJson: true,
                noWarnings: true,
                noCallHome: true
            });
            this.showProcessProgress('Получение информации', 100);
            console.log('\n');

            // Улучшаем фильтрацию форматов
            const formats = info.formats.filter(format => {
                // Проверяем наличие видео и высоты
                const hasVideo = format.vcodec && format.vcodec !== 'none';
                const hasHeight = format.height && format.height > 0;

                return hasVideo && hasHeight;
            });

            // Группируем форматы по качеству, выбираем лучший для каждого разрешения
            const qualityGroups = formats.reduce((groups, format) => {
                const height = format.height;
                if (!groups[height] || format.tbr > groups[height].tbr) {
                    groups[height] = format;
                }
                return groups;
            }, {});

            // Преобразуем обратно в массив и сортируем
            const uniqueFormats = Object.values(qualityGroups)
                .sort((a, b) => (b.height || 0) - (a.height || 0));

            console.log('\nДоступные форматы:');
            uniqueFormats.forEach((format, index) => {
                const size = format.filesize ?
                    (format.filesize / 1024 / 1024).toFixed(1) :
                    'неизвестно';
                const bitrate = format.tbr ?
                    `${format.tbr.toFixed(0)}kbps` :
                    'неизвестно';

                console.log(
                    `${index + 1}. ${format.height}p ` +
                    `(Размер: ${size}MB, Битрейт: ${bitrate}, FPS: ${format.fps || 'неизвестно'})`
                );
            });

            const formatIndex = await new Promise(resolve => {
                const rl = readline.createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                rl.question('\nВыберите номер качества: ', answer => {
                    rl.close();
                    resolve(parseInt(answer) - 1);
                });
            });

            if (formatIndex < 0 || formatIndex >= uniqueFormats.length) {
                throw new Error('Неверный выбор формата');
            }

            const selectedFormat = uniqueFormats[formatIndex];
            console.log(`\nВыбрано качество: ${selectedFormat.height}p`);

            const videoPath = path.join(this.outputDir, 'temp_video.mp4');
            console.log('\nНачинаем загрузку видео...');

            await youtubeDl(url, {
                output: videoPath,
                format: `${selectedFormat.format_id}+bestaudio[ext=m4a]/best`,
                mergeOutputFormat: 'mp4',
                paths: {
                    home: this.outputDir
                },
                progress: true,
                callback: (progress) => {
                    // Добавляем отладочный вывод
                    console.log('Progress data:', progress);

                    if (typeof progress === 'string') {
                        // Обрабатываем строковые сообщения о прогрессе
                        const downloadMatch = progress.match(/(\d+\.\d+)% of ~?(\d+\.\d+)([KMG])iB at\s+(\d+\.\d+)([KMG])iB\/s/);
                        if (downloadMatch) {
                            const percent = parseFloat(downloadMatch[1]);
                            const total = parseFloat(downloadMatch[2]);
                            const speed = `${downloadMatch[4]}${downloadMatch[5]}B/s`;
                            this.showProcessProgress(
                                'Загрузка видео',
                                percent,
                                `(${speed})`
                            );
                        } else if (progress.includes('Merging formats')) {
                            this.showProcessProgress('Объединение форматов', 50);
                        }
                    }
                }
            });

            try {
                await fs.access(videoPath);
                console.log('\nФайл успешно сохранен:', videoPath);

                // Спрашиваем о сохранении исходного видео
                const saveAnswer = await new Promise(resolve => {
                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
                    rl.question('\nСохранить исходное видео? (да/нет): ', answer => {
                        rl.close();
                        resolve(answer.toLowerCase());
                    });
                });

                let sourceVideoPath = null;
                if (saveAnswer === 'да' || saveAnswer === 'y' || saveAnswer === 'yes') {
                    // Создаем имя файла из названия видео и текущей даты
                    const sanitizedTitle = info.title.replace(/[^a-zA-Zа-яА-Я0-9]/g, '_').substring(0, 50);
                    const date = new Date().toISOString().split('T')[0];
                    const sourceFileName = `${date}_${sanitizedTitle}.mp4`;
                    sourceVideoPath = path.join(this.sourceDir, sourceFileName);

                    // Копируем видео в папку source_videos
                    await fs.copyFile(videoPath, sourceVideoPath);
                    console.log(`\nИсходное видео сохранено в: ${sourceVideoPath}`);
                }

                // Спрашиваем о нарезке на шортсы
                const cutAnswer = await new Promise(resolve => {
                    const rl = readline.createInterface({
                        input: process.stdin,
                        output: process.stdout
                    });
                    rl.question('\nХотите нарезать видео на шортсы? (да/нет): ', answer => {
                        rl.close();
                        resolve(answer.toLowerCase());
                    });
                });

                if (cutAnswer === 'да' || cutAnswer === 'y' || cutAnswer === 'yes') {
                    return videoPath;
                } else {
                    console.log('\nОперация нарезки отменена пользователем');
                    // Если исходное видео не сохранено, удаляем временный файл
                    if (!sourceVideoPath) {
                        await fs.unlink(videoPath).catch(() => {});
                    }
                    return null;
                }
            } catch (err) {
                console.error('\nФайл не найден после загрузки');
                return null;
            }
        } catch (error) {
            console.error('\nОшибка при загрузке видео:', error);
            return null;
        }
    }

    // Добавляем метод для подсчета стоимости запроса
    calculateCost(model, inputTokens, outputTokens) {
        const prices = this.gptPrices[model];
        if (!prices) return 0;

        const inputCost = (inputTokens / 1000) * prices.input;
        const outputCost = (outputTokens / 1000) * prices.output;
        return inputCost + outputCost;
    }

    // Модифицируем метод для работы с GPT, чтобы учитывать токены и стоимость
    async makeGPTRequest(model, messages, maxTokens = 100) {
        try {
            const response = await this.openai.chat.completions.create({
                model: model,
                messages: messages,
                max_tokens: maxTokens
            });

            // Подсчитываем токены и стоимость
            const inputTokens = response.usage.prompt_tokens;
            const outputTokens = response.usage.completion_tokens;
            const cost = this.calculateCost(model, inputTokens, outputTokens);

            // Обновляем общую статистику
            this.totalTokens += inputTokens + outputTokens;
            this.totalCost += cost;

            // Выводим статистику по текущему запросу
            console.log('\n📊 Статистика последнего запроса:');
            console.log(`Токены: ${inputTokens + outputTokens} (ввод: ${inputTokens}, вывод: ${outputTokens})`);
            console.log(`Стоимость: $${cost.toFixed(4)}`);
            console.log(`Общие токены: ${this.totalTokens}`);
            console.log(`Общая стоимость: $${this.totalCost.toFixed(4)}\n`);

            return response;
        } catch (error) {
            console.error('Ошибка при запросе к GPT:', error);
            throw error;
        }
    }

    async analyzeVideoContent(time, framePath, audioData, motionData) {
        // Анализируем кадр
        const imageBuffer = await fs.readFile(framePath);
        const base64Image = imageBuffer.toString('base64');

        const response = await this.makeGPTRequest(
            "gpt-4-vision-preview",
            [
                {
                    role: "system",
                    content: `Ты - эксперт по анализу вирусного контента. Проанализируй кадр и оцени:
                    1. Эмоции людей в кадре
                    2. Происходящие события
                    3. Визуальные эффекты и их влияние
                    4. Потенциал для привлечения внимания
                    5. Предложи кликбейтное название для этого момента`
                },
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: `Проанализируй этот кадр на отметке ${time} секунд. Учти следующие факторы:
                            - Интенсивность движения: ${motionData.intensity}/10
                            - Громкость звука: ${audioData.volume}/10
                            - Описание движения: ${motionData.description}
                            - Описание звука: ${audioData.description}`
                        },
                        {
                            type: "image_url",
                            image_url: `data:image/jpeg;base64,${base64Image}`
                        }
                    ]
                }
            ],
            300
        );

        return response.choices[0].message.content;
    }

    async analyzeVideoForHighlights(videoPath) {
        try {
            console.log('\nГлубокий анализ видео для поиска эмоциональных моментов...');
            const duration = await this.getVideoDuration(videoPath);

            // Адаптивный интервал анализа в зависимости от длительности видео
            const intervals = duration <= 600 ? 3 : // До 10 минут
                            duration <= 1800 ? 5 : // До 30 минут
                            10; // Более 30 минут

            console.log(`📊 Выбран интервал анализа: ${intervals} секунд`);
            console.log(`💰 Ожидаемое количество токенов: ${Math.ceil(duration/intervals * 500)}`);

            const segments = [];
            let sessionTokens = 0;
            let sessionCost = 0;
            let segmentsAnalyzed = 0;
            const totalSegments = Math.ceil(duration / intervals);

            // Создаем временную директорию с уникальным идентификатором
            const sessionId = Date.now();
            const tempDir = path.join(this.outputDir, `temp_analysis_${sessionId}`);
            await fs.mkdir(tempDir, { recursive: true });

            // Предварительный быстрый анализ для определения потенциально интересных сегментов
            console.log('\n🔍 Предварительный анализ видео...');
            const potentialSegments = await this.quickScan(videoPath, intervals);

            for (const segment of potentialSegments) {
                try {
                    segmentsAnalyzed++;
                    const { time } = segment;
                    console.log(`\n🎬 Анализ сегмента ${segmentsAnalyzed}/${potentialSegments.length} (${time}с - ${Math.min(time + intervals, duration)}с)`);

                    // Параллельная обработка аудио и видео
                    const [motionData, audioData] = await Promise.all([
                        this.analyzeMotion(segment.path),
                        this.analyzeAudio(segment.audioPath)
                    ]);

                    // Первичный анализ с gpt-3.5-turbo
                    const initialAnalysis = await this.makeGPTRequest(
                        "gpt-3.5-turbo",
                        [
                            {
                                role: "system",
                                content: `Оцени потенциал момента для вирусного видео по шкале 1-10.
                                Движение: ${motionData.intensity}/10
                                Звук: ${audioData.volume}/10
                                Описание движения: ${motionData.description}
                                Звуковые эффекты: ${audioData.description}`
                            },
                            {
                                role: "user",
                                content: "Дай краткую оценку этого момента"
                            }
                        ],
                        50 // Минимальное количество токенов
                    );

                    const quickScore = parseInt(initialAnalysis.choices[0].message.content.match(/\d+/)[0]) || 5;

                    // Детальный анализ только для перспективных моментов
                    if (quickScore >= 7) {
                        const detailedAnalysis = await this.makeGPTRequest(
                            "gpt-4",
                            [
                                {
                                    role: "system",
                                    content: `Ты - эксперт по вирусным видео. Проанализируй этот момент:
                                    1. Эмоциональный отклик (1-10)
                                    2. Вирусный потенциал (1-10)
                                    3. Предложи кликбейтное название
                                    4. Опиши эмоции, которые вызовет этот момент`
                                },
                                {
                                    role: "user",
                                    content: `Анализ момента:
                                    - Движение: ${motionData.description}
                                    - Звук: ${audioData.description}
                                    - Первичная оценка: ${quickScore}/10`
                                }
                            ],
                            150
                        );

                        const analysis = detailedAnalysis.choices[0].message.content;
                        const emotionalScore = parseInt(analysis.match(/Эмоциональный отклик.*?(\d+)/)?.[1] || "5");
                        const viralScore = parseInt(analysis.match(/Вирусный потенциал.*?(\d+)/)?.[1] || "5");
                        const title = analysis.match(/Предложи кликбейтное название:?\s*(.*?)(?:\n|$)/)?.[1] || "Интересный момент";

                        segments.push({
                            time,
                            emotionalScore,
                            viralScore,
                            title,
                            description: analysis,
                            motionScore: motionData.intensity,
                            audioScore: audioData.volume,
                            score: (emotionalScore + viralScore + quickScore) / 3
                        });
                    }

                    // Очистка временных файлов сразу после использования
                    await Promise.all([
                        fs.unlink(segment.path).catch(() => {}),
                        fs.unlink(segment.audioPath).catch(() => {})
                    ]);

                } catch (segmentError) {
                    console.error(`Ошибка при обработке сегмента ${segment.time}:`, segmentError);
                    continue;
                }
            }

            // Очищаем временную директорию
            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

            // Находим лучшие моменты
            const highlights = this.findBestHighlights(segments, duration);

            // Выводим итоговую статистику
            this.showFinalStats();
            console.log('\n🎯 Найдены потенциально вирусные моменты:');
            highlights.forEach((highlight, index) => {
                console.log(`\n🎬 Шортс ${index + 1}:`);
                console.log(`📝 Название: ${highlight.title}`);
                console.log(`⏱️ Таймкод: ${highlight.start}с - ${highlight.end}с`);
                console.log(`⌛ Длительность: ${highlight.duration}с`);
                console.log(`❤️ Эмоциональный рейтинг: ${highlight.averageEmotionalScore.toFixed(1)}/10`);
                console.log(`🌟 Вирусный потенциал: ${highlight.averageViralScore.toFixed(1)}/10`);
                console.log(`🎭 Движение: ${highlight.averageMotion.toFixed(1)}/10`);
                console.log(`🔊 Аудио: ${highlight.averageAudio.toFixed(1)}/10`);
            });

            return highlights;
        } catch (error) {
            console.error('Ошибка при анализе видео:', error);
            return null;
        }
    }

    async analyzeMotion(videoPath) {
        try {
            // Анализируем движение с помощью ffmpeg
            const result = await new Promise((resolve, reject) => {
                exec(
                    `ffmpeg -i "${videoPath}" -filter:v "select='gt(scene,0.1)',metadata=print:file=-" -f null -`,
                    (error, stdout, stderr) => {
                        if (error && !stderr.includes('video:0kB')) reject(error);
                        else resolve(stderr);
                    }
                );
            });

            // Подсчитываем количество сцен и оцениваем интенсивность движения
            const sceneChanges = (result.match(/scene:[\d.]+/g) || []).length;
            const intensity = Math.min(Math.ceil(sceneChanges * 2), 10);

            let description = "Нет заметного движения";
            if (intensity > 7) description = "Очень интенсивное движение";
            else if (intensity > 5) description = "Умеренное движение";
            else if (intensity > 3) description = "Небольшое движение";

            return { intensity, description };
        } catch (error) {
            console.error('Ошибка при анализе движения:', error);
            return { intensity: 5, description: "Ошибка анализа движения" };
        }
    }

    async analyzeAudio(audioPath) {
        try {
            // Анализируем громкость с помощью ffmpeg
            const result = await new Promise((resolve, reject) => {
                exec(
                    `ffmpeg -i "${audioPath}" -filter:a volumedetect -f null /dev/null 2>&1`,
                    (error, stdout, stderr) => {
                        if (error && !stderr.includes('audio:0kB')) reject(error);
                        else resolve(stderr);
                    }
                );
            });

            // Извлекаем значения громкости
            const meanVolumeMatch = result.match(/mean_volume: ([-\d.]+) dB/);
            const maxVolumeMatch = result.match(/max_volume: ([-\d.]+) dB/);

            const meanVolume = meanVolumeMatch ? parseFloat(meanVolumeMatch[1]) : -70;
            const maxVolume = maxVolumeMatch ? parseFloat(maxVolumeMatch[1]) : -70;

            // Нормализуем значения к шкале от 0 до 10
            const normalizedVolume = Math.min(Math.max(((maxVolume + 70) / 70) * 10, 0), 10);

            let description = "Тишина";
            if (normalizedVolume > 7) description = "Очень громкий звук";
            else if (normalizedVolume > 5) description = "Умеренная громкость";
            else if (normalizedVolume > 3) description = "Тихий звук";

            return { volume: normalizedVolume, description };
        } catch (error) {
            console.error('Ошибка при анализе аудио:', error);
            return { volume: 5, description: "Ошибка анализа аудио" };
        }
    }

    findBestHighlights(segments, duration) {
        const SHORTS_DURATION = 60;
        const MIN_SCORE = 7;
        const MIN_DURATION = 15;
        const MAX_SHORTS = 5;

        const highlights = [];
        let currentHighlight = null;

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];

            if (segment.score >= MIN_SCORE) {
                if (!currentHighlight) {
                    currentHighlight = {
                        start: segment.time,
                        segments: [segment],
                        scores: [segment.score],
                        emotionalScores: [segment.emotionalScore],
                        viralScores: [segment.viralScore],
                        motionScores: [segment.motionScore],
                        audioScores: [segment.audioScore],
                        titles: [segment.title],
                        descriptions: [segment.description]
                    };
                } else {
                    currentHighlight.segments.push(segment);
                    currentHighlight.scores.push(segment.score);
                    currentHighlight.emotionalScores.push(segment.emotionalScore);
                    currentHighlight.viralScores.push(segment.viralScore);
                    currentHighlight.motionScores.push(segment.motionScore);
                    currentHighlight.audioScores.push(segment.audioScore);
                    currentHighlight.titles.push(segment.title);
                    currentHighlight.descriptions.push(segment.description);
                }
            } else if (currentHighlight) {
                const contextDuration = 5;
                currentHighlight.start = Math.max(0, currentHighlight.start - contextDuration);
                const lastSegment = segments[i - 1];
                currentHighlight.end = Math.min(duration, lastSegment.time + contextDuration);

                const highlightDuration = currentHighlight.end - currentHighlight.start;

                if (highlightDuration >= MIN_DURATION && highlightDuration <= SHORTS_DURATION) {
                    // Вычисляем средние значения
                    currentHighlight.averageScore = currentHighlight.scores.reduce((a, b) => a + b) / currentHighlight.scores.length;
                    currentHighlight.averageEmotionalScore = currentHighlight.emotionalScores.reduce((a, b) => a + b) / currentHighlight.emotionalScores.length;
                    currentHighlight.averageViralScore = currentHighlight.viralScores.reduce((a, b) => a + b) / currentHighlight.viralScores.length;
                    currentHighlight.averageMotion = currentHighlight.motionScores.reduce((a, b) => a + b) / currentHighlight.motionScores.length;
                    currentHighlight.averageAudio = currentHighlight.audioScores.reduce((a, b) => a + b) / currentHighlight.audioScores.length;

                    // Выбираем лучшее название из предложенных
                    currentHighlight.title = currentHighlight.titles.reduce((best, current) => {
                        return current.length > best.length ? current : best;
                    });

                    // Объединяем описания
                    currentHighlight.description = currentHighlight.descriptions.join('\n');
                    currentHighlight.duration = highlightDuration;

                    // Улучшенная формула веса с учетом эмоционального воздействия
                    currentHighlight.weight =
                        currentHighlight.averageEmotionalScore * 0.3 + // Эмоциональный отклик
                        currentHighlight.averageViralScore * 0.3 + // Вирусный потенциал
                        currentHighlight.averageMotion * 0.2 + // Движение
                        currentHighlight.averageAudio * 0.2; // Звук

                    highlights.push(currentHighlight);
                }
                currentHighlight = null;
            }
        }

        highlights.sort((a, b) => b.weight - a.weight);

        const selectedHighlights = [];
        for (const highlight of highlights) {
            const hasOverlap = selectedHighlights.some(selected => {
                return (highlight.start < selected.end && highlight.end > selected.start);
            });

            if (!hasOverlap && selectedHighlights.length < MAX_SHORTS) {
                selectedHighlights.push(highlight);
            }
        }

        return selectedHighlights;
    }

    async generateShorts(videoPath) {
        try {
            console.log('\nПоиск лучших моментов для шортсов...');
            const highlights = await this.analyzeVideoForHighlights(videoPath);

            if (!highlights || highlights.length === 0) {
                console.log('\nНе найдено подходящих моментов, используем стандартную нарезку...');
                return this.generateStandardShorts(videoPath);
            }

            console.log('\nНачинаем создание шортсов из лучших моментов...');
            const shorts = [];

            for (const [index, highlight] of highlights.entries()) {
                const outputPath = path.join(this.outputDir, `short_${index}.mp4`);
                try {
                    await this.cutVideo(videoPath, highlight.start, highlight.end, outputPath);
                    shorts.push({
                        path: outputPath,
                        description: highlight.description,
                        score: highlight.averageScore
                    });
                    console.log(`\nШортс ${index + 1}/${highlights.length} создан успешно`);
                } catch (error) {
                    console.error(`\nОшибка при создании шортса ${index + 1}:`, error);
                    continue;
                }
            }

            return shorts;
        } catch (error) {
            console.error('\nОшибка при генерации шортсов:', error);
            return [];
        }
    }

    async getVideoDuration(videoPath) {
        return new Promise((resolve, reject) => {
            exec(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
                (error, stdout, stderr) => {
                    if (error) reject(error);
                    else resolve(parseFloat(stdout));
                }
            );
        });
    }

    async cutVideo(inputPath, startTime, endTime, outputPath) {
        return new Promise((resolve, reject) => {
            const duration = endTime - startTime;
            let currentTime = 0;

            console.log(`\n🎬 Создание шортса ${startTime}с -> ${endTime}с`);

            const ffmpeg = exec(
                `ffmpeg -hide_banner -loglevel error -i "${inputPath}" -ss ${startTime} -t ${duration} -c copy "${outputPath}"`,
                { maxBuffer: 1024 * 1024 * 10 },
                (error, stdout, stderr) => {
                    if (error) {
                        console.error('\nОшибка FFmpeg:', stderr);
                        reject(error);
                    } else {
                        resolve();
                    }
                }
            );

            // Слушаем вывод ffmpeg для отслеживания прогресса
            ffmpeg.stderr.on('data', (data) => {
                const timeMatch = data.toString().match(/time=(\d+):(\d+):(\d+.\d+)/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1]);
                    const minutes = parseInt(timeMatch[2]);
                    const seconds = parseFloat(timeMatch[3]);
                    currentTime = hours * 3600 + minutes * 60 + seconds;

                    const percent = Math.min((currentTime / duration) * 100, 100);
                    this.showProcessProgress(
                        '⏳ Обработка',
                        percent,
                        `(${Math.floor(currentTime)}с из ${Math.floor(duration)}с)`
                    );
                }
            });

            // Добавляем таймаут
            const timeout = setTimeout(() => {
                ffmpeg.kill();
                reject(new Error('Таймаут операции'));
            }, 300000);

            ffmpeg.on('exit', (code) => {
                clearTimeout(timeout);
                if (code !== 0) {
                    reject(new Error(`FFmpeg завершился с кодом ${code}`));
                }
            });
        });
    }

    async analyzePotentialViews(videoPath) {
        try {
            this.showProcessProgress('Анализ потенциала', 0);

            const response = await this.makeGPTRequest(
                "gpt-4",
                [
                    {
                        role: "system",
                        content: `Ты - эксперт по анализу YouTube Shorts. Проанализируй потенциал видео и оцени:
                        1. Количество возможных просмотров (число от 1000 до 1000000)
                        2. Целевую аудиторию
                        3. Основные факторы виральности
                        4. Рекомендации по улучшению`
                    },
                    {
                        role: "user",
                        content: "Проанализируй этот шортс и дай подробную оценку его потенциала"
                    }
                ],
                500
            );

            this.showProcessProgress('Анализ потенциала', 100);
            console.log('\n');

            const analysis = response.choices[0].message.content;

            // Извлекаем число просмотров из анализа
            const viewsMatch = analysis.match(/(\d{1,3}(,\d{3})*|\d+)/);
            const views = viewsMatch ? parseInt(viewsMatch[0].replace(/,/g, '')) : 1000;

            // Форматируем и выводим анализ
            console.log('\n=== Анализ потенциала шортса ===');
            console.log(analysis.split('\n').map(line => line.trim()).join('\n'));
            console.log('===============================\n');

            return {
                views,
                analysis
            };
        } catch (error) {
            console.error('\nОшибка при анализе видео:', error);
            return {
                views: 1000,
                analysis: 'Не удалось проанализировать видео'
            };
        }
    }

    // Переименовываем старый метод generateShorts
    async generateStandardShorts(videoPath) {
        try {
            console.log('\nНачинаем генерацию шортсов...');
            const duration = await this.getVideoDuration(videoPath);
            console.log(`Длительность видео: ${duration} секунд`);

            const shorts = [];
            const totalShorts = Math.ceil(duration / 60);

            for (let startTime = 0; startTime < duration; startTime += 60) {
                const endTime = Math.min(startTime + 60, duration);
                const outputPath = path.join(this.outputDir, `short_${startTime}.mp4`);

                const shortNumber = Math.floor(startTime / 60) + 1;
                const percent = (shortNumber / totalShorts) * 100;

                try {
                    await this.cutVideo(videoPath, startTime, endTime, outputPath);
                    shorts.push(outputPath);
                    console.log(`\nШортс ${shortNumber}/${totalShorts} создан успешно`);
                } catch (error) {
                    console.error(`\nОшибка при создании шортса ${shortNumber}/${totalShorts}:`, error);
                    // Продолжаем с следующим шортсом
                    continue;
                }
            }

            if (shorts.length > 0) {
                console.log('\nШортсы созданы успешно');
                return shorts;
            } else {
                throw new Error('Не удалось создать ни одного шортса');
            }
        } catch (error) {
            console.error('\nОшибка при генерации шортсов:', error);
            return [];
        }
    }

    // В конце работы можем показать общую статистику
    showFinalStats() {
        console.log('\n=== Итоговая статистика использования GPT ===');
        console.log(`Всего использовано токенов: ${this.totalTokens}`);
        console.log(`Общая стоимость: $${this.totalCost.toFixed(4)}`);
        console.log('==========================================\n');
    }

    async quickScan(videoPath, intervals) {
        try {
            const duration = await this.getVideoDuration(videoPath);
            const segments = [];

            for (let time = 0; time < duration; time += intervals) {
                const segmentPath = path.join(this.outputDir, `quick_segment_${time}.mp4`);
                const audioPath = path.join(this.outputDir, `quick_audio_${time}.wav`);

                // Быстрое извлечение сегмента
                await new Promise((resolve, reject) => {
                    exec(`ffmpeg -i "${videoPath}" -ss ${time} -t ${intervals} -c:v copy -c:a copy "${segmentPath}"`,
                        (error) => error ? reject(error) : resolve()
                    );
                });

                // Извлечение аудио
                await new Promise((resolve, reject) => {
                    exec(`ffmpeg -i "${segmentPath}" -ac 1 -ar 16000 "${audioPath}"`,
                        (error) => error ? reject(error) : resolve()
                    );
                });

                // Быстрый анализ движения и звука
                const [motionIntensity, audioVolume] = await Promise.all([
                    this.getQuickMotionScore(segmentPath),
                    this.getQuickAudioScore(audioPath)
                ]);

                // Если сегмент потенциально интересный
                if (motionIntensity > 3 || audioVolume > 3) {
                    segments.push({
                        time,
                        path: segmentPath,
                        audioPath,
                        initialScore: (motionIntensity + audioVolume) / 2
                    });
                } else {
                    // Удаляем неинтересные сегменты сразу
                    await Promise.all([
                        fs.unlink(segmentPath).catch(() => {}),
                        fs.unlink(audioPath).catch(() => {})
                    ]);
                }
            }

            // Сортируем сегменты по начальной оценке
            segments.sort((a, b) => b.initialScore - a.initialScore);

            // Возвращаем только самые перспективные сегменты
            return segments.slice(0, Math.min(segments.length, 10));
        } catch (error) {
            console.error('Ошибка при быстром сканировании:', error);
            return [];
        }
    }

    async getQuickMotionScore(videoPath) {
        try {
            const result = await new Promise((resolve, reject) => {
                exec(
                    `ffmpeg -i "${videoPath}" -filter:v "select='gt(scene,0.1)',metadata=print:file=-" -f null -`,
                    (error, stdout, stderr) => {
                        if (error && !stderr.includes('video:0kB')) reject(error);
                        else resolve(stderr);
                    }
                );
            });

            const sceneChanges = (result.match(/scene:[\d.]+/g) || []).length;
            return Math.min(Math.ceil(sceneChanges * 2), 10);
        } catch (error) {
            return 5;
        }
    }

    async getQuickAudioScore(audioPath) {
        try {
            const result = await new Promise((resolve, reject) => {
                exec(
                    `ffmpeg -i "${audioPath}" -filter:a volumedetect -f null /dev/null 2>&1`,
                    (error, stdout, stderr) => {
                        if (error && !stderr.includes('audio:0kB')) reject(error);
                        else resolve(stderr);
                    }
                );
            });

            const maxVolumeMatch = result.match(/max_volume: ([-\d.]+) dB/);
            const maxVolume = maxVolumeMatch ? parseFloat(maxVolumeMatch[1]) : -70;
            return Math.min(Math.max(((maxVolume + 70) / 70) * 10, 0), 10);
        } catch (error) {
            return 5;
        }
    }
}

module.exports = YouTubeShortsGenerator;
