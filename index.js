require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const ytdl = require('ytdl-core');
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
    bot.sendMessage(chatId, 'Hello! I am a YouTube video downloader bot. Send me a YouTube link and I will show you available formats.');
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;
    const videoId = getYoutubeVideoId(messageText);

    if (videoId) {
        bot.sendMessage(chatId, 'Processing your request... Please wait.');

        try {
            // Simple approach - get available formats
            if (!ytdl.validateURL(messageText)) {
                bot.sendMessage(chatId, 'Invalid YouTube URL. Please check the link.');
                return;
            }

            const info = await ytdl.getBasicInfo(messageText);
            const formats = ytdl.filterFormats(info.formats, 'videoandaudio');

            // Get unique quality options
            const qualityOptions = {};
            formats.forEach(format => {
                if (format.container === 'mp4' && format.qualityLabel) {
                    qualityOptions[format.qualityLabel] = format;
                }
            });

            // Get audio format
            const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');
            const bestAudio = audioFormats[0];

            const keyboard = [];

            // Add video options
            Object.keys(qualityOptions).forEach(quality => {
                keyboard.push([{
                    text: `🎥 ${quality} (with audio)`,
                    callback_data: JSON.stringify({ 
                        type: 'video', 
                        quality: quality,
                        videoId 
                    })
                }]);
            });

            // Add audio option
            if (bestAudio) {
                keyboard.push([{
                    text: '🎵 Audio Only (MP3)',
                    callback_data: JSON.stringify({ 
                        type: 'audio', 
                        videoId 
                    })
                }]);
            }

            if (keyboard.length > 0) {
                bot.sendMessage(chatId, `📹 *${info.videoDetails.title}*\n\nPlease choose a format:`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                });
            } else {
                bot.sendMessage(chatId, 'Sorry, no downloadable formats found for this video.');
            }

        } catch (err) {
            console.error('Error getting video info:', err.message);
            bot.sendMessage(chatId, 'Sorry, this video is not available for download. Try a different video.');
        }
    } else if (msg.text !== '/start') {
        bot.sendMessage(chatId, "Please send me a valid YouTube link!");
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const { type, quality, videoId } = JSON.parse(callbackQuery.data);
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    bot.sendMessage(chatId, `Downloading ${type === 'video' ? quality + ' video' : 'audio'}... Please wait.`);

    try {
        const timestamp = Date.now();

        if (type === 'video') {
            const filePath = path.join(downloadsDir, `${timestamp}.mp4`);
            
            // Download highest quality available
            const stream = ytdl(url, { 
                quality: 'highest',
                filter: 'videoandaudio'
            });
            
            const writeStream = fs.createWriteStream(filePath);
            stream.pipe(writeStream);

            writeStream.on('finish', async () => {
                try {
                    await bot.sendVideo(chatId, filePath);
                    fs.unlink(filePath, (err) => {
                        if (err) console.error('Error deleting file:', err);
                    });
                } catch (sendError) {
                    console.error('Error sending video:', sendError);
                    bot.sendMessage(chatId, 'Downloaded but failed to send. File might be too large.');
                    fs.unlink(filePath, () => {});
                }
            });

            writeStream.on('error', (err) => {
                console.error('Write error:', err);
                bot.sendMessage(chatId, 'Error downloading video.');
            });

        } else if (type === 'audio') {
            const filePath = path.join(downloadsDir, `${timestamp}.mp3`);
            
            const stream = ytdl(url, { 
                filter: 'audioonly',
                quality: 'highestaudio'
            });
            
            const writeStream = fs.createWriteStream(filePath);
            stream.pipe(writeStream);

            writeStream.on('finish', async () => {
                try {
                    await bot.sendAudio(chatId, filePath);
                    fs.unlink(filePath, (err) => {
                        if (err) console.error('Error deleting file:', err);
                    });
                } catch (sendError) {
                    console.error('Error sending audio:', sendError);
                    bot.sendMessage(chatId, 'Downloaded but failed to send. File might be too large.');
                    fs.unlink(filePath, () => {});
                }
            });

            writeStream.on('error', (err) => {
                console.error('Write error:', err);
                bot.sendMessage(chatId, 'Error downloading audio.');
            });
        }
    } catch (err) {
        console.error(`Error downloading ${type}:`, err);
        bot.sendMessage(chatId, `Sorry, there was an error downloading the ${type}.`);
    }
});

console.log('YouTube Telegram Bot is running...');