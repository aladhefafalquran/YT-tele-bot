const express = require('express');
const youtubeDl = require('youtube-dl-exec');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const util = require('util');
const unlinkAsync = util.promisify(fs.unlink);

const app = express();
const port = 3000;

// Ensure downloads directory exists
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

app.use(express.static(path.join(__dirname, 'new-ui')));

app.get('/video-info', async (req, res) => {
    const videoUrl = req.query.url;

    try {
        const info = await youtubeDl(videoUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            callHome: false,
        });

        const formats = info.formats.map(format => ({
            qualityLabel: format.height ? `${format.height}p` : (format.acodec !== 'none' ? 'Audio' : 'Unknown'),
            container: format.ext,
            itag: format.format_id,
            filesize: format.filesize,
            vcodec: format.vcodec,
            acodec: format.acodec
        }));

        formats.sort((a, b) => {
            const isAVideoA = a.qualityLabel.endsWith('p');
            const isAVideoB = b.qualityLabel.endsWith('p');

            if (isAVideoA && !isAVideoB) return -1;
            if (!isAVideoA && isAVideoB) return 1;

            if (isAVideoA && isAVideoB) {
                return parseInt(b.qualityLabel) - parseInt(a.qualityLabel);
            } else {
                return (a.filesize || 0) - (b.filesize || 0);
            }
        });

        res.send({ formats: formats, title: info.title });
    } catch (error) {
        console.error(error);
        res.status(500).send({ error: 'Failed to get video info' });
    }
});

app.get('/download', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality;
    const filename = req.query.filename || 'video.mp4';

    if (!videoUrl || !quality) {
        return res.status(400).send('Invalid request: missing URL or quality');
    }

    // Generate unique temporary filenames
    const tempVideoPath = path.join(__dirname, 'downloads', `${Date.now()}_${Math.random().toString(36).substring(2, 15)}_video.tmp`);
    const tempAudioPath = path.join(__dirname, 'downloads', `${Date.now()}_${Math.random().toString(36).substring(2, 15)}_audio.tmp`);
    const tempMp4Path = path.join(__dirname, 'downloads', `${Date.now()}_${Math.random().toString(36).substring(2, 15)}_final.mp4`);

    let videoFormatId = quality; // Assume selected quality is for video initially
    let audioFormatId = null;

    try {
        // Fetch video info to determine if merging is needed
        const info = await youtubeDl(videoUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            callHome: false,
        });

        const selectedFormat = info.formats.find(f => f.format_id === quality);

        if (selectedFormat && selectedFormat.acodec === 'none' && selectedFormat.vcodec !== 'none') {
            // This is a video-only format, find a suitable audio
            const bestAudioFormat = info.formats.find(f => f.vcodec === 'none' && f.acodec !== 'none');

            if (bestAudioFormat) {
                videoFormatId = selectedFormat.format_id;
                audioFormatId = bestAudioFormat.format_id;
            } else {
                // Fallback to just the video format if no audio is found
                videoFormatId = selectedFormat.format_id;
                console.warn(`No suitable audio format found for merging with video-only format ${selectedFormat.format_id}. Downloading video-only.`);
            }
        } else {
            // Not a video-only format, download as requested (assuming it has audio or is audio-only)
            // For simplicity, if it's not video-only, we'll download it as is.
            // If it's an audio-only format, we'll download it as audio.
            // If it's a combined format, we'll download it as video.
            // This logic might need refinement based on specific format types.
            videoFormatId = selectedFormat.format_id; // Use the selected format directly
        }

        const ytDlpPath = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');

        // --- Download Video Stream ---
        if (videoFormatId) {
            const ytDlpVideoArgs = [
                videoUrl,
                '--output', tempVideoPath,
                '--format', videoFormatId,
                '--no-warnings',
                '--call-home', 'false',
            ];
            console.log(`Executing yt-dlp for video: ${ytDlpPath} ${ytDlpVideoArgs.join(' ')}`);
            const ytDlpVideoProcess = spawn(ytDlpPath, ytDlpVideoArgs, { stdio: ['ignore', 'ignore', 'inherit'] });
            await new Promise((resolve, reject) => {
                ytDlpVideoProcess.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`yt-dlp video process exited with code ${code}`));
                });
                ytDlpVideoProcess.on('error', (err) => reject(err));
            });
        }

        // --- Download Audio Stream (if needed) ---
        if (audioFormatId) {
            const ytDlpAudioArgs = [
                videoUrl,
                '--output', tempAudioPath,
                '--format', audioFormatId,
                '--no-warnings',
                '--call-home', 'false',
            ];
            console.log(`Executing yt-dlp for audio: ${ytDlpPath} ${ytDlpAudioArgs.join(' ')}`);
            const ytDlpAudioProcess = spawn(ytDlpPath, ytDlpAudioArgs, { stdio: ['ignore', 'ignore', 'inherit'] });
            await new Promise((resolve, reject) => {
                ytDlpAudioProcess.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`yt-dlp audio process exited with code ${code}`));
                });
                ytDlpAudioProcess.on('error', (err) => reject(err));
            });
        }

        // --- Merge with FFmpeg ---
        if (videoFormatId && audioFormatId) { // Both video and audio downloaded, merge them
            const ffmpegArgs = [
                '-i', tempVideoPath,
                '-i', tempAudioPath,
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-y',
                tempMp4Path
            ];
            console.log(`Executing ffmpeg for merging: ffmpeg ${ffmpegArgs.join(' ')}`);
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'inherit'] });
            await new Promise((resolve, reject) => {
                ffmpegProcess.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`ffmpeg merge process exited with code ${code}`));
                });
                ffmpegProcess.on('error', (err) => reject(err));
            });
        } else if (videoFormatId) { // Only video downloaded (or combined video+audio)
            // If only video was downloaded (e.g., it was a combined stream), just rename/copy it
            await fs.promises.copyFile(tempVideoPath, tempMp4Path);
        } else if (audioFormatId) { // Only audio downloaded
            // If only audio was downloaded, just rename/copy it
            await fs.promises.copyFile(tempAudioPath, tempMp4Path);
        } else {
            throw new Error('No video or audio format selected for download.');
        }

        // Stream the final .mp4 file to the client
        res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename.replace(/\.(ts|tmp)$/, '.mp4'))}"`);
        res.header('Content-Type', 'video/mp4');

        const readStream = fs.createReadStream(tempMp4Path);
        readStream.pipe(res);

        // Handle stream errors
        readStream.on('error', (err) => {
            console.error('Error streaming MP4 file:', err);
            if (!res.headersSent) {
                res.status(500).send('Failed to stream MP4 file');
            }
        });

        // Clean up temporary files after streaming is complete
        readStream.on('close', async () => {
            try {
                if (fs.existsSync(tempVideoPath)) await unlinkAsync(tempVideoPath);
                if (fs.existsSync(tempAudioPath)) await unlinkAsync(tempAudioPath);
                if (fs.existsSync(tempMp4Path)) await unlinkAsync(tempMp4Path);
            } catch (cleanupErr) {
                console.error('Error cleaning up temporary files:', cleanupErr);
            }
        });

    } catch (error) {
        console.error('Download or processing error:', error);
        if (!res.headersSent) {
            res.status(500).send('Failed to download or process video');
        }
        // Attempt to clean up if an error occurred before streaming
        try {
            if (fs.existsSync(tempVideoPath)) await unlinkAsync(tempVideoPath);
            if (fs.existsSync(tempAudioPath)) await unlinkAsync(tempAudioPath);
            if (fs.existsSync(tempMp4Path)) await unlinkAsync(tempMp4Path);
        } catch (cleanupErr) {
            console.error('Error cleaning up temporary files after error:', cleanupErr);
        }
    }
});

app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});