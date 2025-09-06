const downloadBtn = document.getElementById('downloadBtn');
const videoUrlInput = document.getElementById('videoUrl');
const formatsContainer = document.getElementById('formatsContainer');
const statusMessageElement = document.getElementById('statusMessage');
const downloadProgressContainer = document.getElementById('downloadProgressContainer');
const downloadStatus = document.getElementById('downloadStatus');
const progressBarFill = document.getElementById('progressBarFill');
const progressPercentage = document.getElementById('progressPercentage');

let animationInterval;
let dotCount = 0;

function startAnimation(element, baseText) {
    dotCount = 0;
    element.innerText = baseText;
    animationInterval = setInterval(() => {
        dotCount = (dotCount + 1) % 4;
        element.innerText = baseText + '.'.repeat(dotCount);
    }, 500);
}

function stopAnimation() {
    clearInterval(animationInterval);
}

downloadBtn.addEventListener('click', async () => {
    const videoUrl = videoUrlInput.value;
    if (!videoUrl) {
        alert('Please enter a video URL.');
        return;
    }

    formatsContainer.innerHTML = '';
    statusMessageElement.style.display = 'block';
    startAnimation(statusMessageElement, 'Getting Video Formats');
    downloadBtn.disabled = true;

    try {
        const response = await fetch(`/video-info?url=${encodeURIComponent(videoUrl)}`);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Failed to get video info');
        }

        const data = await response.json();
        displayFormats(data.formats, data.title, videoUrl);
    } catch (error) {
        formatsContainer.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
        console.error(error);
    } finally {
        stopAnimation();
        statusMessageElement.style.display = 'none';
        downloadBtn.disabled = false;
    }
});

function displayFormats(formats, title, videoUrl) {
    formatsContainer.innerHTML = '';

    if (formats.length === 0) {
        formatsContainer.innerHTML = '<p>No video and audio formats found.</p>';
        return;
    }

    const formatsList = document.createElement('div');
    formatsList.classList.add('formats-list');

    formats.forEach(format => {
        const formatButton = document.createElement('button');
        formatButton.classList.add('format-button');
        formatButton.innerText = `${format.qualityLabel} (${format.container})`;
        formatButton.addEventListener('click', () => {
            let sanitizedTitle = (title || 'video').replace(/[\/:*?"<>]/g, '').replace(/\s+/g, ' ').trim();
            if (!sanitizedTitle) {
                sanitizedTitle = 'video';
            }
            const filename = `${sanitizedTitle}.${format.container}`;
            
            const downloadUrl = `/download?url=${encodeURIComponent(videoUrl)}&quality=${format.itag}&filename=${encodeURIComponent(filename)}`;
            
            
            downloadWithProgress(downloadUrl, filename, format.filesize);
        });
        formatsList.appendChild(formatButton);
    });

    formatsContainer.appendChild(formatsList);
}

async function downloadWithProgress(url, filename, totalSize) {
    downloadBtn.disabled = true;
    formatsContainer.querySelectorAll('.format-button').forEach(btn => btn.disabled = true);
    downloadProgressContainer.style.display = 'block';
    startAnimation(downloadStatus, `Downloading ${filename}`);
    progressBarFill.style.width = '0%';
    progressPercentage.innerText = '0%';

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Download failed: ${response.statusText}`);
        }

        const reader = response.body.getReader();
        let receivedLength = 0;
        const chunks = [];
        
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            chunks.push(value);
            receivedLength += value.length;

            if (totalSize) {
                const percent = Math.round((receivedLength / totalSize) * 100);
                progressBarFill.style.width = percent + '%';
                progressPercentage.innerText = percent + '%';
                
            } else {
                // If no total size, show indeterminate progress or just bytes downloaded
                progressBarFill.style.width = '100%'; // Or some other indicator
                progressPercentage.innerText = `${(receivedLength / 1024 / 1024).toFixed(2)} MB`;
                
            }
        }

        const blob = new Blob(chunks);
        const href = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(href);

    } catch (error) {
        console.error('Download error:', error);
        downloadStatus.innerText = 'Download failed.';
    } finally {
        stopAnimation();
        // Hide progress and re-enable buttons after a short delay
        setTimeout(() => {
            downloadProgressContainer.style.display = 'none';
            downloadBtn.disabled = false;
            formatsContainer.querySelectorAll('.format-button').forEach(btn => btn.disabled = false);
        }, 1000);
    }
}