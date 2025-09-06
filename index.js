require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const path = require('path');

// User agents to rotate through
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0'
];

// Create agent with random user agent
function getRandomAgent() {
    return {
        headers: {
            'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-us,en;q=0.5',
            'Accept-Encoding': 'gzip,deflate',
            'Accept-Charset': 'ISO-8859-1,utf-8;q=0.7,*;q=0.7',
            'Keep-Alive': '300',
            'Connection': 'keep-alive',
        }
    };
}

// Retry function with exponential backoff
async function retryWithBackoff(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            await new Promise(resolve => setTimeout(resolve, i * 1000 + Math.random() * 1000)); // Random delay
            return await fn();
        } catch (error) {
            console.log(`Attempt ${i + 1} failed:`, error.message);
            if (i === maxRetries - 1) {
                throw error;
            }
        }
    }
}

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
            const info = await retryWithBackoff(async () => {
                const agent = getRandomAgent();
                return await ytdl.getInfo(messageText, { 
                    requestOptions: agent
                });
            });
            const formats = info.formats;

            // Filter video formats with audio
            const videoFormats = formats
                .filter(format => format.hasVideo && format.hasAudio && format.container === 'mp4')
                .sort((a, b) => (b.height || 0) - (a.height || 0))
                .slice(0, 8); // Limit to top 8 formats

            // Filter audio-only formats
            const audioFormats = formats
                .filter(format => format.hasAudio && !format.hasVideo)
                .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))
                .slice(0, 1); // Best audio only

            const keyboard = [];

            // Add video options
            videoFormats.forEach(format => {
                const quality = format.qualityLabel || format.quality || 'Unknown';
                keyboard.push([{
                    text: `🎥 ${quality} (with audio)`,
                    callback_data: JSON.stringify({ 
                        type: 'video', 
                        itag: format.itag, 
                        videoId,
                        quality: quality
                    })
                }]);
            });

            // Add audio option
            if (audioFormats.length > 0) {
                keyboard.push([{
                    text: '🎵 Audio Only (MP3)',
                    callback_data: JSON.stringify({ 
                        type: 'audio', 
                        itag: audioFormats[0].itag, 
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
            console.error('Error getting video info:', err);
            bot.sendMessage(chatId, 'Sorry, there was an error processing this video. Please try a different link.');
        }
    } else if (msg.text !== '/start') {
        bot.sendMessage(chatId, "Please send me a valid YouTube link!");
    }
});

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const { type, itag, videoId, quality } = JSON.parse(callbackQuery.data);
    const url = `https://www.youtube.com/watch?v=${videoId}`;

    bot.sendMessage(chatId, `Downloading ${type === 'video' ? `${quality} video` : 'audio'}... Please wait.`);

    try {
        if (type === 'video') {
            const timestamp = Date.now();
            const filePath = path.join(downloadsDir, `${timestamp}.mp4`);

            const agent = getRandomAgent();
            const stream = ytdl(url, { 
                format: itag,
                requestOptions: agent
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
                    bot.sendMessage(chatId, 'Downloaded successfully but failed to send. File might be too large.');
                    fs.unlink(filePath, () => {});
                }
            });

            writeStream.on('error', (err) => {
                console.error('Write error:', err);
                bot.sendMessage(chatId, 'Error downloading video.');
            });

        } else if (type === 'audio') {
            const timestamp = Date.now();
            const filePath = path.join(downloadsDir, `${timestamp}.mp3`);

            const agent = getRandomAgent();
            const stream = ytdl(url, { 
                filter: 'audioonly',
                requestOptions: agent
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
                    bot.sendMessage(chatId, 'Downloaded successfully but failed to send. File might be too large.');
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