// Video.js player instance
let videoPlayer = null;
let currentVideoFilename = null;
let videoMarkers = [];
let markerTimeHandlerBound = false;
let pendingMarkerDeleteId = null;
let renamingMarkerId = null;

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
            preload: 'metadata',
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
            if (error && error.code === 1) return;
            showVideoRepairUi(error);
        });
        addVideoJsFavoriteButton(videoPlayer);
        addVideoJsMarkerButton(videoPlayer);
        setupMarkerPlayerHooks(videoPlayer);
    }
    return videoPlayer;
}

function addVideoJsFavoriteButton(player) {
    player.ready(() => {
        const bar = player.el().querySelector('.vjs-control-bar');
        if (!bar || bar.querySelector('.vjs-favorite-button')) return;
        const btn = document.createElement('button');
        btn.className = 'vjs-favorite-button vjs-control vjs-button favorite-btn';
        btn.type = 'button';
        btn.title = 'Add to favorites';
        btn.innerHTML = typeof favoriteIconSvg === 'function' ? favoriteIconSvg() : '♥';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const main = document.getElementById('favoriteButton');
            if (main) toggleFavorite(main);
        });
        const fullscreen = bar.querySelector('.vjs-fullscreen-control');
        if (fullscreen) {
            bar.insertBefore(btn, fullscreen);
        } else {
            bar.appendChild(btn);
        }
        const main = document.getElementById('favoriteButton');
        if (main && main.getAttribute('data-filename')) {
            btn.setAttribute('data-filename', main.getAttribute('data-filename'));
            applyFavoriteState(btn, main.classList.contains('is-favorite'));
        }
    });
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
        const systemName = document.getElementById('systemName')?.textContent || 'Movie Tube';
        document.title = `${video.displayName} - ${systemName}`;
        
        // Display video info first
        const titleElement = document.getElementById('videoTitle');
        if (titleElement) {
            titleElement.textContent = video.displayName;
        }

        bindFavoriteButton('favoriteButton', video.filename, video.favorited);
        currentVideoFilename = video.filename;
        setupVideoMarkers(video);
        
        // Set file type label
        const viewsElement = document.getElementById('videoViews');
        if (viewsElement) {
            const fileTypeLabels = {
                'pdf': 'PDF Document',
                'image': 'Image',
                'video': 'Video'
            };
            viewsElement.textContent = fileTypeLabels[video.fileType] || 'File';
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
        
        const videoPlayerContainer = document.getElementById('videoPlayerContainer');
        
        // Handle PDF files
        if (video.fileType === 'pdf') {
            if (videoPlayerContainer) {
                // Hide video player and show PDF viewer
                videoPlayerContainer.innerHTML = `
                    <iframe 
                        id="pdfViewer" 
                        src="${escapeHtml(video.fullPath)}" 
                        style="width: 100%; height: 100%; min-height: 600px; border: none; background: #1a1a1a;"
                        type="application/pdf">
                    </iframe>
                `;
            }
        } else if (video.fileType === 'image') {
            // Handle image files
            if (videoPlayerContainer) {
                videoPlayerContainer.innerHTML = `
                    <img 
                        src="${escapeHtml(video.fullPath)}" 
                        alt="${escapeHtml(video.displayName)}"
                        style="width: 100%; height: 100%; object-fit: contain; background: #1a1a1a;">
                `;
            }
        } else {
            // Initialize and load video player for video files
            const player = initVideoPlayer();
            if (player) {
                const videoType = getVideoType(video.fullPath);
                console.log('Setting video source:', video.fullPath, 'Type:', videoType);
                player.src({
                    type: videoType,
                    src: video.fullPath
                });
                player.load();
                addVideoJsFavoriteButton(player);
                hideVideoRepairUi();
            } else {
                console.error('Failed to initialize video player');
                showError('Failed to initialize video player. Please refresh the page.');
            }
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
        showVideoRepairUi({ message: error.message });
    }
}

function showVideoRepairUi(error) {
    const overlay = document.getElementById('videoRepairOverlay');
    const message = document.getElementById('videoRepairMessage');
    const mainContent = document.getElementById('videoMainContent');
    if (mainContent) {
        mainContent.style.display = 'grid';
        mainContent.style.visibility = 'visible';
    }
    if (!overlay) return;
    const detail = error && error.message ? error.message : 'The player could not decode this file.';
    if (message) {
        message.textContent = `This video failed to load (${detail}). Repair rewrites the container with ffmpeg without re-encoding, which often fixes missing keyframes.`;
    }
    overlay.hidden = false;
}

function hideVideoRepairUi() {
    const overlay = document.getElementById('videoRepairOverlay');
    const status = document.getElementById('videoRepairStatus');
    if (overlay) overlay.hidden = true;
    if (status) {
        status.hidden = true;
        status.textContent = '';
    }
}

async function repairCurrentVideo() {
    const filename = currentVideoFilename || getVideoFilenameFromURL();
    if (!filename) return;
    const overlay = document.getElementById('videoRepairOverlay');
    const status = document.getElementById('videoRepairStatus');
    const buttons = [document.getElementById('repairVideoButton'), document.getElementById('repairVideoActionButton')].filter(Boolean);
    if (overlay) overlay.hidden = false;
    if (status) {
        status.hidden = false;
        status.textContent = 'Rewriting the file with ffmpeg. This can take a minute for large videos…';
    }
    buttons.forEach(button => { button.disabled = true; });
    try {
        if (videoPlayer) {
            try { videoPlayer.pause(); } catch (error) {}
        }
        const response = await fetch('/api/video/repair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ filename })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || 'Could not repair video');
        }
        if (status) status.textContent = 'Repair finished. Reloading…';
        reloadRepairedVideo(filename);
    } catch (error) {
        console.error('Video repair failed:', error);
        if (status) {
            status.hidden = false;
            status.textContent = error.message;
        }
    } finally {
        buttons.forEach(button => { button.disabled = false; });
    }
}

function reloadRepairedVideo(filename) {
    const player = videoPlayer || initVideoPlayer();
    if (!player) {
        window.location.reload();
        return;
    }
    const src = `/api/video/${encodeURIComponent(filename)}?t=${Date.now()}`;
    try { player.error(null); } catch (error) {}
    player.src({
        type: getVideoType(filename),
        src
    });
    player.load();
    hideVideoRepairUi();
    player.play().catch(() => {});
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
                     loading="lazy" decoding="async" width="148" height="84"
                     onerror="this.style.display='none'; this.parentElement.classList.add('no-thumbnail');">
            </div>
            <div class="related-video-info">
                <div class="related-video-title">${escapeHtml(video.displayName)}</div>
                <div class="related-video-meta">Related</div>
            </div>
        </div>
    `).join('');
}

// Navigate to video page
function navigateToVideo(filename) {
    const encodedFilename = encodeURIComponent(filename);
    window.open(`/video/${encodedFilename}`, '_blank');
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

function addVideoJsMarkerButton(player) {
    player.ready(() => {
        const bar = player.el().querySelector('.vjs-control-bar');
        if (!bar || bar.querySelector('.vjs-marker-button')) return;
        const btn = document.createElement('button');
        btn.className = 'vjs-marker-button vjs-control vjs-button';
        btn.type = 'button';
        btn.title = 'Mark this moment';
        btn.textContent = '◉';
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            addMarkerAtCurrentTime();
        });
        const favorite = bar.querySelector('.vjs-favorite-button');
        const fullscreen = bar.querySelector('.vjs-fullscreen-control');
        if (favorite) {
            bar.insertBefore(btn, favorite);
        } else if (fullscreen) {
            bar.insertBefore(btn, fullscreen);
        } else {
            bar.appendChild(btn);
        }
    });
}

function setupMarkerPlayerHooks(player) {
    player.ready(() => {
        ensureMarkerHoverTip(player);
        renderMarkerTicks();
        if (!markerTimeHandlerBound) {
            player.on('loadedmetadata', renderMarkerTicks);
            player.on('durationchange', renderMarkerTicks);
            player.on('playerresize', renderMarkerTicks);
            markerTimeHandlerBound = true;
        }
    });
}

function ensureMarkerHoverTip(player) {
    let tip = document.getElementById('markerHoverTip');
    if (!tip) {
        tip = document.createElement('div');
        tip.id = 'markerHoverTip';
        tip.className = 'marker-hover-tip';
        tip.hidden = true;
    }
    const host = player && player.el ? player.el() : document.body;
    if (tip.parentElement !== host) host.appendChild(tip);
    return tip;
}

function hideMarkerHoverTip() {
    const tip = document.getElementById('markerHoverTip');
    if (tip) {
        tip.hidden = true;
        tip.textContent = '';
    }
}

function showMarkerHoverTip(tick, marker) {
    const player = videoPlayer;
    const tip = ensureMarkerHoverTip(player);
    const label = marker.note ? marker.note : 'Start here';
    tip.textContent = `${formatMarkerTime(marker.time)} — ${label}`;
    tip.hidden = false;
    const tickBox = tick.getBoundingClientRect();
    const host = tip.parentElement;
    const hostBox = host.getBoundingClientRect();
    const left = tickBox.left - hostBox.left + tickBox.width / 2;
    const top = tickBox.top - hostBox.top;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top - 8)}px`;
}

function formatMarkerTime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function setupVideoMarkers(video) {
    const section = document.getElementById('videoMarkersSection');
    const addButton = document.getElementById('addMarkerButton');
    if (!video || video.fileType !== 'video') {
        if (section) section.hidden = true;
        if (addButton) addButton.hidden = true;
        videoMarkers = [];
        return;
    }
    if (section) section.hidden = false;
    if (addButton) addButton.hidden = false;
    setVideoMarkers(video.markers || []);
    const player = videoPlayer || initVideoPlayer();
    if (player) setupMarkerPlayerHooks(player);
}

function setVideoMarkers(markers) {
    videoMarkers = (markers || []).slice().sort((a, b) => a.time - b.time || a.id - b.id);
    hideMarkerHoverTip();
    renderMarkerList();
    renderMarkerTicks();
}

function renderMarkerList() {
    const list = document.getElementById('videoMarkersList');
    if (!list) return;
    if (!videoMarkers.length) {
        list.innerHTML = '<li class="video-marker-empty">No markers yet. Play to a spot, add a note, then mark this moment.</li>';
        return;
    }
    list.innerHTML = videoMarkers.map(marker => {
        const confirming = pendingMarkerDeleteId === marker.id;
        const renaming = renamingMarkerId === marker.id;
        const noteLabel = marker.note || 'Start here';
        const noteClass = marker.note ? '' : ' is-empty';
        const time = escapeHtml(formatMarkerTime(marker.time));
        const seek = `seekToMarker(${Number(marker.time)})`;
        let body = `
            <button type="button" class="video-marker-jump" onclick="${seek}">
                <span class="video-marker-time">${time}</span>
                <span class="video-marker-note${noteClass}">${escapeHtml(noteLabel)}</span>
            </button>`;
        if (renaming) {
            body = `
            <button type="button" class="video-marker-time-btn" onclick="${seek}">${time}</button>
            <input class="video-marker-note-input" data-marker-id="${marker.id}" value="${escapeHtml(marker.note || '')}" maxlength="280" placeholder="Rename this marker" onkeydown="handleMarkerRenameKey(event, ${marker.id})">`;
        }
        let actions = `
                <button type="button" class="video-marker-rename" title="Rename" aria-label="Rename marker" onclick="startRenameMarker(${marker.id})">${markerPencilIcon()}</button>
                <button type="button" class="video-marker-remove" title="Remove" aria-label="Remove marker" onclick="requestDeleteMarker(${marker.id})">${markerTrashIcon()}</button>`;
        if (confirming) {
            actions = `
                <button type="button" class="video-marker-remove video-marker-text" onclick="deleteMarker(${marker.id})">Confirm</button>
                <button type="button" class="video-marker-text" onclick="cancelDeleteMarker()">Cancel</button>`;
        } else if (renaming) {
            actions = `
                <button type="button" class="video-marker-rename video-marker-text" onclick="commitMarkerRename(${marker.id})">Save</button>
                <button type="button" class="video-marker-text" onclick="cancelRenameMarker()">Cancel</button>`;
        }
        return `
        <li class="video-marker-item${confirming ? ' is-confirming' : ''}${renaming ? ' is-editing' : ''}" data-marker-id="${marker.id}">
            ${body}
            <div class="video-marker-actions">${actions}
            </div>
        </li>`;
    }).join('');
}

function markerPencilIcon() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
}

function markerTrashIcon() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
}

function startRenameMarker(id) {
    pendingMarkerDeleteId = null;
    renamingMarkerId = id;
    setMarkerStatus('');
    renderMarkerList();
    requestAnimationFrame(() => {
        const input = document.querySelector(`.video-marker-note-input[data-marker-id="${id}"]`);
        if (!input) return;
        input.focus();
        input.select();
    });
}

function cancelRenameMarker() {
    renamingMarkerId = null;
    setMarkerStatus('');
    renderMarkerList();
}

function handleMarkerRenameKey(event, id) {
    if (event.key === 'Enter') {
        event.preventDefault();
        commitMarkerRename(id);
    } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRenameMarker();
    }
}

function commitMarkerRename(id) {
    const input = document.querySelector(`.video-marker-note-input[data-marker-id="${id}"]`);
    renameMarker(id, input ? input.value : '');
}

function renderMarkerTicks() {
    const player = videoPlayer;
    if (!player || !player.el) return;
    const holder = player.el().querySelector('.vjs-progress-holder');
    if (!holder) return;
    holder.querySelectorAll('.vjs-marker-tick').forEach(tick => tick.remove());
    const duration = player.duration();
    if (!duration || !Number.isFinite(duration) || duration <= 0) return;
    videoMarkers.forEach(marker => {
        const tick = document.createElement('button');
        tick.type = 'button';
        tick.className = 'vjs-marker-tick';
        tick.style.left = `${Math.min(100, Math.max(0, (marker.time / duration) * 100))}%`;
        tick.setAttribute('aria-label', marker.note || `Marker at ${formatMarkerTime(marker.time)}`);
        tick.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            seekToMarker(marker.time);
        });
        tick.addEventListener('mouseenter', () => showMarkerHoverTip(tick, marker));
        tick.addEventListener('mouseleave', hideMarkerHoverTip);
        tick.addEventListener('focus', () => showMarkerHoverTip(tick, marker));
        tick.addEventListener('blur', hideMarkerHoverTip);
        holder.appendChild(tick);
    });
}

function seekToMarker(time) {
    const player = videoPlayer || initVideoPlayer();
    if (!player) return;
    player.currentTime(Number(time) || 0);
    player.play().catch(() => {});
}

function setMarkerStatus(message, isError) {
    if (typeof setUiStatus === 'function') {
        setUiStatus('markerStatus', message, isError);
        return;
    }
    const el = document.getElementById('markerStatus');
    if (!el) return;
    el.hidden = !message;
    el.textContent = message || '';
    el.classList.toggle('is-error', Boolean(isError && message));
}

function requestDeleteMarker(id) {
    renamingMarkerId = null;
    pendingMarkerDeleteId = id;
    setMarkerStatus('Click Confirm to remove this marker.');
    renderMarkerList();
}

function cancelDeleteMarker() {
    pendingMarkerDeleteId = null;
    setMarkerStatus('');
    renderMarkerList();
}

async function addMarkerAtCurrentTime() {
    if (!currentVideoFilename) return;
    const player = videoPlayer || initVideoPlayer();
    const time = player && typeof player.currentTime === 'function' ? player.currentTime() : 0;
    const input = document.getElementById('markerNoteInput');
    const note = input ? input.value.trim() : '';
    try {
        const response = await fetch('/api/markers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ filename: currentVideoFilename, time, note })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Could not add marker');
        }
        if (input) input.value = '';
        setMarkerStatus('');
        setVideoMarkers(data.markers || []);
    } catch (error) {
        console.error('Add marker failed:', error);
        setMarkerStatus(error.message, true);
    }
}

async function renameMarker(id, nextName) {
    const marker = videoMarkers.find(item => item.id === id);
    const note = String(nextName || '').trim();
    if (marker && note === (marker.note || '')) {
        cancelRenameMarker();
        return;
    }
    try {
        const response = await fetch(`/api/marker/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ note })
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Could not rename marker');
        }
        renamingMarkerId = null;
        setMarkerStatus('');
        setVideoMarkers(data.markers || []);
    } catch (error) {
        console.error('Rename marker failed:', error);
        setMarkerStatus(error.message, true);
        renderMarkerList();
    }
}

async function deleteMarker(id) {
    try {
        const response = await fetch(`/api/marker/${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || 'Could not remove marker');
        }
        pendingMarkerDeleteId = null;
        renamingMarkerId = null;
        setMarkerStatus('');
        setVideoMarkers(data.markers || []);
    } catch (error) {
        console.error('Delete marker failed:', error);
        setMarkerStatus(error.message, true);
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

