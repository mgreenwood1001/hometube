// Video.js player instance
let videoPlayer = null;

// Get video filename from URL
function getVideoFilenameFromURL() {
    const pathname = window.location.pathname;
    // Remove leading /video/ from the path
    const videoPrefix = '/video/';
    if (pathname.startsWith(videoPrefix)) {
        const filename = pathname.substring(videoPrefix.length);
        return decodeURIComponent(filename);
    }
    return null;
}

// Initialize video player
function initVideoPlayer() {
    if (!videoPlayer) {
        const videoElement = document.getElementById('videoPlayer');
        if (!videoElement) {
            console.error('Video element not found');
            return null;
        }
        
        videoPlayer = videojs(videoElement, {
            controls: true,
            autoplay: false,
            preload: 'auto',
            fluid: true,
            responsive: true,
            playbackRates: [0.5, 1, 1.25, 1.5, 2],
            html5: {
                vhs: {
                    overrideNative: true
                },
                nativeVideoTracks: false,
                nativeAudioTracks: false,
                nativeTextTracks: false
            }
        });
        
        // Add error logging
        videoPlayer.on('error', () => {
            const error = videoPlayer.error();
            if (error) {
                console.error('Video.js player error:', error);
            }
        });
    }
    return videoPlayer;
}

// Get video MIME type from file extension
function getVideoType(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const types = {
        'mp4': 'video/mp4',
        'webm': 'video/webm',
        'ogg': 'video/ogg',
        'ogv': 'video/ogg',
        'mov': 'video/quicktime',
        'avi': 'video/x-msvideo',
        'mkv': 'video/x-matroska',
        'm4v': 'video/mp4'
    };
    return types[ext] || 'video/mp4';
}

// Load video and related videos
async function loadVideoPage() {
    console.log('loadVideoPage called');
    
    const filename = getVideoFilenameFromURL();
    console.log('Extracted filename from URL:', filename);
    
    if (!filename) {
        showError('Video not found - invalid URL. Please check the URL and try again.');
        return;
    }
    
    // Show loading state
    const loadingMessage = document.getElementById('loadingMessage');
    const mainContent = document.getElementById('videoMainContent');
    if (loadingMessage) loadingMessage.style.display = 'block';
    if (mainContent) mainContent.style.display = 'none';
    
    const relatedVideosList = document.getElementById('relatedVideosList');
    if (relatedVideosList) {
        relatedVideosList.innerHTML = '<p class="loading">Loading video information...</p>';
    }
    
    try {
        const apiUrl = `/api/video-info/${encodeURIComponent(filename)}`;
        console.log('Fetching video info from:', apiUrl);
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include' // Include cookies for session
        });
        
        console.log('Response status:', response.status, response.statusText);
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}: Failed to load video`;
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || errorMessage;
            } catch (e) {
                const text = await response.text();
                console.error('Error response text:', text);
            }
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        console.log('Video data received:', data);
        
        const { video, relatedVideos } = data;
        
        if (!video) {
            throw new Error('Video data not found in response');
        }
        
        console.log('Video found:', video.displayName);
        console.log('Related videos count:', relatedVideos ? relatedVideos.length : 0);
        
        // Hide loading message and show content
        const loadingMessage = document.getElementById('loadingMessage');
        const mainContent = document.getElementById('videoMainContent');
        if (loadingMessage) {
            loadingMessage.style.display = 'none';
        }
        if (mainContent) {
            mainContent.style.display = 'grid';
            mainContent.style.visibility = 'visible';
        }
        
        // Set page title (will be updated with system name from config)
        const systemName = document.getElementById('systemName')?.textContent || 'HomeTube';
        document.title = `${video.displayName} - ${systemName}`;
        
        // Display video info first
        const titleElement = document.getElementById('videoTitle');
        if (titleElement) {
            titleElement.textContent = video.displayName;
        }
        
        // Set video views (placeholder)
        const viewsElement = document.getElementById('videoViews');
        if (viewsElement) {
            viewsElement.textContent = 'Video';
        }
        
        const stemsContainer = document.getElementById('videoStems');
        if (stemsContainer) {
            if (video.stems && video.stems.length > 0) {
                stemsContainer.innerHTML = video.stems.map(stem => 
                    `<span class="video-stem-large" onclick="searchByStem('${escapeHtml(stem)}')">${escapeHtml(stem)}</span>`
                ).join('');
            } else {
                stemsContainer.innerHTML = '<p style="color: #aaaaaa; font-size: 0.9rem;">No tags available</p>';
            }
        }
        
        // Initialize and load video player
        const player = initVideoPlayer();
        if (player) {
            const videoType = getVideoType(video.fullPath);
            console.log('Setting video source:', video.fullPath, 'Type:', videoType);
            player.src({
                type: videoType,
                src: video.fullPath
            });
            player.load();
        } else {
            console.error('Failed to initialize video player');
            showError('Failed to initialize video player. Please refresh the page.');
        }
        
        // Display related videos
        displayRelatedVideos(relatedVideos || []);
        
    } catch (error) {
        console.error('Error loading video:', error);
        
        // Hide loading, show error
        const loadingMessage = document.getElementById('loadingMessage');
        const mainContent = document.getElementById('videoMainContent');
        if (loadingMessage) loadingMessage.style.display = 'none';
        if (mainContent) mainContent.style.display = 'none';
        
        showError(`Error loading video: ${error.message}`);
        
        // Also update the related videos section
        if (relatedVideosList) {
            relatedVideosList.innerHTML = '<p class="error" style="color: #ff4444; padding: 1rem;">Failed to load related videos</p>';
        }
    }
}

// Show error message
function showError(message) {
    console.error('Showing error:', message);
    const container = document.querySelector('.video-page-container') || document.body;
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.style.cssText = 'padding: 2rem; text-align: center; color: #ff4444; background-color: #1a1a1a; border: 1px solid #ff4444; border-radius: 8px; margin: 1rem;';
    errorDiv.innerHTML = `<h2>Error</h2><p>${escapeHtml(message)}</p><p style="margin-top: 1rem; font-size: 0.9rem; color: #aaaaaa;">Check the browser console (F12) for more details.</p>`;
    
    // Try to insert before existing content, or replace if needed
    if (container.querySelector('.video-main-content')) {
        container.insertBefore(errorDiv, container.querySelector('.video-main-content'));
    } else {
        container.innerHTML = '';
        container.appendChild(errorDiv);
    }
}

// Display related videos
function displayRelatedVideos(videos) {
    const container = document.getElementById('relatedVideosList');
    
    if (videos.length === 0) {
        container.innerHTML = '<p class="loading">No related videos found</p>';
        return;
    }
    
    container.innerHTML = videos.map(video => `
        <div class="related-video-item" onclick="navigateToVideo('${encodeURIComponent(video.filename)}')">
            <div class="related-video-thumbnail">
                <img src="${escapeHtml(video.thumbnailPath)}" alt="${escapeHtml(video.displayName)}"
                     onerror="this.style.display='none'; this.parentElement.classList.add('no-thumbnail');">
                <div class="play-overlay-small">▶</div>
            </div>
            <div class="related-video-info">
                <div class="related-video-title">${escapeHtml(video.displayName)}</div>
                <div class="related-video-channel">${document.getElementById('systemName')?.textContent || 'HomeTube'}</div>
                <div class="related-video-meta">Related video</div>
            </div>
        </div>
    `).join('');
}

// Navigate to video page
function navigateToVideo(filename) {
    const encodedFilename = encodeURIComponent(filename);
    window.location.href = `/video/${encodedFilename}`;
}

// Search by stem
function searchByStem(stem) {
    window.location.href = `/?search=${encodeURIComponent(stem)}`;
}

// Handle search keypress
function handleSearchKeyPress(event) {
    if (event.key === 'Enter') {
        const query = document.getElementById('searchInput').value.trim();
        if (query) {
            window.location.href = `/?search=${encodeURIComponent(query)}`;
        }
    }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Initialize page when everything is ready
function initializeVideoPage() {
    console.log('initializeVideoPage called, readyState:', document.readyState, 'videojs:', typeof videojs);
    
    function tryLoad() {
        if (typeof videojs !== 'undefined') {
            console.log('Video.js is available, loading page...');
            loadVideoPage();
        } else {
            console.warn('Video.js not yet available, waiting...');
            setTimeout(tryLoad, 100);
        }
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            console.log('DOM loaded, waiting for Video.js...');
            tryLoad();
        });
    } else {
        console.log('DOM already ready, waiting for Video.js...');
        tryLoad();
    }
}

// Start initialization immediately
console.log('Starting video page initialization...');
console.log('Page URL:', window.location.href);
console.log('Pathname:', window.location.pathname);

// Try to load immediately if everything is ready
if (document.readyState === 'complete' && typeof videojs !== 'undefined') {
    console.log('Everything ready immediately, loading...');
    loadVideoPage();
} else {
    initializeVideoPage();
}

