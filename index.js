require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;

const bot = new TelegramBot(token, { polling: true });

function getYoutubeVideoId(url) {
    const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
}

// Create a downloads directory if it doesn't exist
const downloadsDir = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

bot.onText(/\/start/, (msg) => {

    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Hello! I am a YouTube video downloader bot. Send me a YouTube link and I will download the video for you.');
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;
    const videoId = getYoutubeVideoId(messageText);

    if (videoId) {
        bot.sendMessage(chatId, 'Processing your request... Please wait.');

        try {
            const output = await youtubedl(messageText, {
                listFormats: true,
            });

            const formats = output.split('\n');
            const videoFormats = [];
            let bestAudioFormat = null;

            formats.forEach(line => {
                if (line.includes('mp4')) {
                    const parts = line.split(/\s+/);
                    const formatCode = parts[0];
                    if (formatCode && !isNaN(formatCode)) {
                        const resolution = parts[2];
                        const note = parts.slice(5).join(' ');
                        videoFormats.push({
                            text: `🎥 ${resolution} ${note}`,
                            callback_data: JSON.stringify({ type: 'video', formatCode, videoId })
                        });
                    }
                }
                if (line.includes('audio only')) {
                    const parts = line.split(/\s+/);
                    const formatCode = parts[0];
                    if (formatCode && !isNaN(formatCode)) {
                        bestAudioFormat = formatCode;
                    }
                }
            });

            const keyboard = [];
            // chunk video formats into pairs
            for (let i = 0; i < videoFormats.length; i += 2) {
                keyboard.push(videoFormats.slice(i, i + 2));
            }

            if (bestAudioFormat) {
                keyboard.push([{
                    text: '🎵 Audio (MP3)',
                    callback_data: JSON.stringify({ type: 'audio', formatCode: bestAudioFormat, videoId })
                }]);
            }

            if (keyboard.length > 0) {
                bot.sendMessage(chatId, 'Please choose a format:', {
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                });
            } else {
                bot.sendMessage(chatId, 'Sorry, no downloadable formats found for this link.');
            }

        } catch (err) {
            console.error('Error getting formats:', err);
            bot.sendMessage(chatId, 'Sorry, there was an error processing the video. Please make sure you sent a valid link.');
        }
    } else if (msg.text !== '/start') {
        bot.sendMessage(chatId, "I don't see a link. Are you trying to download a video? Send me the link!");
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const { type, formatCode, videoId } = JSON.parse(callbackQuery.data);
    const link = `https://www.youtube.com/watch?v=${videoId}`;

    bot.sendMessage(chatId, `Downloading your ${type}... Please wait.`);

    try {
        if (type === 'video') {
            const filePath = path.join(downloadsDir, `${Date.now()}.mp4`);

            await youtubedl(link, {
                output: filePath,
                format: formatCode
            });

            await bot.sendVideo(chatId, filePath);

            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        } else if (type === 'audio') {
            const filePath = path.join(downloadsDir, `${Date.now()}.mp3`);

            await youtubedl(link, {
                extractAudio: true,
                audioFormat: 'mp3',
                output: filePath,
                format: formatCode
            });

            await bot.sendAudio(chatId, filePath);

            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting file:', err);
            });
        }
    } catch (err) {
        console.error(`Error downloading ${type}:`, err);
        bot.sendMessage(chatId, `Sorry, there was an error downloading the ${type}.`);
    }
});