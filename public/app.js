let currentPage = 1;
let currentStem = null;
let currentResolution = null;
let currentFileType = null; // 'video', 'pdf', 'image', or null for all
let currentFilterMode = 'OR';
let currentDateFrom = null;
let currentDateTo = null;
let videosPerPage = 12;
let allStems = []; // Store all stems for suggestions
let dateRange = { minDate: null, maxDate: null };
let dateCounts = {}; // Store file counts per date
let dateRangePicker = null; // Flatpickr instance

// Parse search query for AND/OR logic
function parseSearchQuery(query) {
    const trimmed = query.trim();
    if (!trimmed) {
        return { stems: [], mode: 'OR' };
    }
    
    // Check for explicit AND/OR operators (case insensitive)
    const andMatch = trimmed.match(/\s+AND\s+/i);
    const orMatch = trimmed.match(/\s+OR\s+/i);
    
    let mode = 'OR';
    let stems = [];
    
    if (andMatch) {
        // AND logic
        mode = 'AND';
        stems = trimmed.split(/\s+AND\s+/i)
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 0);
    } else if (orMatch) {
        // OR logic
        mode = 'OR';
        stems = trimmed.split(/\s+OR\s+/i)
            .map(s => s.trim().toLowerCase())
            .filter(s => s.length > 0);
    } else {
        // Default: treat as space-separated OR, or comma-separated
        if (trimmed.includes(',')) {
            stems = trimmed.split(',')
                .map(s => s.trim().toLowerCase())
                .filter(s => s.length > 0);
            mode = 'OR'; // Comma-separated defaults to OR
        } else {
            // Single word or space-separated (treat as OR)
            stems = trimmed.split(/\s+/)
                .map(s => s.trim().toLowerCase())
                .filter(s => s.length > 0);
            mode = 'OR';
        }
    }
    
    return { stems, mode };
}

// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    loadStems();
    loadResolutions();
    loadDateRange();
    loadDateCounts();
    
    // Set initial videos per page from select
    const videosPerPageSelect = document.getElementById('videosPerPageSelect');
    if (videosPerPageSelect) {
        videosPerPage = parseInt(videosPerPageSelect.value);
    }
    
    // Set "All" button as active by default
    const allButton = document.getElementById('fileType-all');
    if (allButton) {
        allButton.classList.add('active');
    }
    
    // Check for search parameter in URL
    const urlParams = new URLSearchParams(window.location.search);
    const searchParam = urlParams.get('search');
    if (searchParam) {
        document.getElementById('searchInput').value = searchParam;
        performSearch(searchParam);
    } else {
        loadVideos();
    }
    
    // Search input handler - show suggestions as you type
    const searchInput = document.getElementById('searchInput');
    let suggestionTimeout;
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        
        clearTimeout(suggestionTimeout);
        
        if (query.length > 0) {
            suggestionTimeout = setTimeout(() => {
                showSearchSuggestions(query);
            }, 200); // Debounce suggestions
        } else {
            hideSearchSuggestions();
        }
    });
    
    // Also update suggestions when cursor position changes
    searchInput.addEventListener('keyup', (e) => {
        // Arrow keys, home, end, etc. - update suggestions based on cursor position
        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            const query = searchInput.value;
            if (query.length > 0) {
                clearTimeout(suggestionTimeout);
                suggestionTimeout = setTimeout(() => {
                    showSearchSuggestions(query);
                }, 100);
            }
        }
    });
    
    // Search on Enter key
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const query = searchInput.value.trim();
            hideSearchSuggestions();
            if (query) {
                performSearch(query);
            } else {
                clearFilter();
            }
        } else if (e.key === 'Escape') {
            hideSearchSuggestions();
        }
    });
    
    // Hide suggestions when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.search-container')) {
            hideSearchSuggestions();
        }
    });
});

// Load all stems
async function loadStems() {
    try {
        const response = await fetch('/api/stems');
        const data = await response.json();
        allStems = data.stems; // Store for suggestions
        displayStems(data.stems);
    } catch (error) {
        console.error('Error loading stems:', error);
        document.getElementById('stemsList').innerHTML = 
            '<p class="error">Error loading stems</p>';
    }
}

// Show search suggestions
function showSearchSuggestions(query) {
    const suggestionsContainer = document.getElementById('searchSuggestions');
    const searchInput = document.getElementById('searchInput');
    const cursorPosition = searchInput.selectionStart || searchInput.value.length;
    const currentValue = searchInput.value;
    
    // Find the word being typed (the word at the cursor position)
    let wordStart = cursorPosition;
    let wordEnd = cursorPosition;
    
    // Find the start of the current word
    while (wordStart > 0 && currentValue[wordStart - 1] !== ' ') {
        wordStart--;
    }
    
    // Find the end of the current word
    while (wordEnd < currentValue.length && currentValue[wordEnd] !== ' ') {
        wordEnd++;
    }
    
    // Extract the word being typed
    const wordBeingTyped = currentValue.substring(wordStart, wordEnd).toLowerCase().trim();
    
    // Only show suggestions if there's a word being typed (not just spaces or operators)
    if (!wordBeingTyped || wordBeingTyped === 'and' || wordBeingTyped === 'or') {
        hideSearchSuggestions();
        return;
    }
    
    // Find matching stems based on the word being typed
    const matchingStems = allStems
        .filter(stem => stem.stem.toLowerCase().includes(wordBeingTyped))
        .slice(0, 10); // Limit to 10 suggestions
    
    if (matchingStems.length === 0) {
        hideSearchSuggestions();
        return;
    }
    
    suggestionsContainer.innerHTML = matchingStems.map(stem => `
        <div class="search-suggestion-item" onclick="selectSuggestion('${escapeHtml(stem.stem)}')">
            <span class="suggestion-stem">${escapeHtml(stem.stem)}</span>
            <span class="suggestion-count">(${stem.count})</span>
        </div>
    `).join('');
    
    suggestionsContainer.classList.remove('hidden');
}

// Hide search suggestions
function hideSearchSuggestions() {
    const suggestionsContainer = document.getElementById('searchSuggestions');
    suggestionsContainer.classList.add('hidden');
}

// Select a suggestion
function selectSuggestion(stem) {
    const searchInput = document.getElementById('searchInput');
    const currentValue = searchInput.value;
    const cursorPosition = searchInput.selectionStart || currentValue.length;
    
    // Find the word boundaries around the cursor
    // Look for word boundaries (spaces, start/end of string)
    let wordStart = cursorPosition;
    let wordEnd = cursorPosition;
    
    // Find the start of the current word
    while (wordStart > 0 && currentValue[wordStart - 1] !== ' ') {
        wordStart--;
    }
    
    // Find the end of the current word
    while (wordEnd < currentValue.length && currentValue[wordEnd] !== ' ') {
        wordEnd++;
    }
    
    // Extract the word being typed
    const wordBeingTyped = currentValue.substring(wordStart, wordEnd);
    
    // Replace the word being typed with the selected stem
    const beforeWord = currentValue.substring(0, wordStart);
    const afterWord = currentValue.substring(wordEnd);
    
    // Determine if we need a space before or after
    const needsSpaceBefore = wordStart > 0 && beforeWord.trim().length > 0 && !beforeWord.endsWith(' ');
    const needsSpaceAfter = afterWord.length > 0 && !afterWord.startsWith(' ');
    
    const newValue = beforeWord + 
                     (needsSpaceBefore ? ' ' : '') + 
                     stem + 
                     (needsSpaceAfter ? ' ' : '') + 
                     afterWord;
    
    searchInput.value = newValue;
    
    // Set cursor position after the inserted stem
    const newCursorPosition = wordStart + (needsSpaceBefore ? 1 : 0) + stem.length + (needsSpaceAfter ? 1 : 0);
    searchInput.setSelectionRange(newCursorPosition, newCursorPosition);
    
    hideSearchSuggestions();
    searchInput.focus();
}

// Perform search (parse and filter)
function performSearch(query) {
    const parsed = parseSearchQuery(query);
    if (parsed.stems.length > 0) {
        filterByStems(parsed.stems.join(','), parsed.mode);
    } else {
        clearFilter();
    }
}

// Perform search from input field (for search button)
function performSearchFromInput() {
    const query = document.getElementById('searchInput').value.trim();
    hideSearchSuggestions();
    if (query) {
        performSearch(query);
    } else {
        clearFilter();
    }
}

// Change videos per page
function changeVideosPerPage(newLimit) {
    videosPerPage = parseInt(newLimit);
    currentPage = 1; // Reset to first page
    loadVideos(1, currentStem, currentFilterMode);
}

// Load resolutions
async function loadResolutions() {
    try {
        const response = await fetch('/api/resolutions');
        const data = await response.json();
        displayResolutions(data.resolutions);
    } catch (error) {
        console.error('Error loading resolutions:', error);
    }
}

// Display resolutions in sidebar
function displayResolutions(resolutions) {
    const resolutionsList = document.getElementById('resolutionsList');
    
    // Predefined resolutions in order
    const predefinedResolutions = ['240p', '480p', '720p', '1080p', '2k', '4k'];
    
    // Create a map of resolution to count
    const resolutionMap = {};
    resolutions.forEach(res => {
        resolutionMap[res.resolution] = res.count;
    });
    
    // Display all predefined resolutions, even if count is 0
    resolutionsList.innerHTML = predefinedResolutions.map(res => {
        const count = resolutionMap[res] || 0;
        return `
        <div class="stem-tag" data-resolution="${res}" onclick="filterByResolution('${res}')" ${count === 0 ? 'style="opacity: 0.5;"' : ''}>
            ${res} <span class="stem-count">(${count})</span>
        </div>
    `;
    }).join('');
}

// Filter by file type
function filterByFileType(fileType) {
    currentPage = 1;
    currentFileType = fileType === 'all' ? null : fileType;
    
    // Update active button state
    document.querySelectorAll('.file-type-tag').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeButton = document.getElementById(`fileType-${fileType}`);
    if (activeButton) {
        activeButton.classList.add('active');
    }
    
    loadVideos(1, currentStem, currentFilterMode, currentResolution, currentFileType);
}

// Filter by resolution
function filterByResolution(resolution) {
    currentPage = 1;
    currentStem = null;
    currentResolution = resolution;
    loadVideos(1, null, 'OR', resolution, currentFileType, currentDateFrom, currentDateTo);
}

// Detect video resolution
async function detectVideoResolution(filename) {
    try {
        const response = await fetch(`/api/detect-resolution/${encodeURIComponent(filename)}`);
        const data = await response.json();
        
        if (data.resolution && data.resolution !== 'Unknown') {
            // Update the video card if it's visible
            const videoCard = document.querySelector(`[onclick*="${encodeURIComponent(filename)}"]`);
            if (videoCard) {
                const resolutionBadge = videoCard.querySelector('.video-resolution-badge');
                const resolutionText = videoCard.querySelector('.video-resolution-text');
                if (resolutionBadge) {
                    resolutionBadge.textContent = data.resolution;
                }
                if (resolutionText) {
                    resolutionText.textContent = data.resolution;
                }
            }
        }
    } catch (error) {
        console.error('Error detecting resolution:', error);
    }
}

// Display stems in sidebar
function displayStems(stems) {
    const stemsList = document.getElementById('stemsList');
    
    if (stems.length === 0) {
        stemsList.innerHTML = '<p class="loading">No stems found</p>';
        return;
    }
    
    stemsList.innerHTML = stems.map(stem => `
        <div class="stem-tag" data-stem="${stem.stem}" onclick="filterByStem('${stem.stem}')">
            ${stem.stem} <span class="stem-count">(${stem.count})</span>
        </div>
    `).join('');
}

// Load videos with pagination and filtering
async function loadVideos(page = 1, stem = null, mode = 'OR', resolution = null, fileType = null, dateFrom = null, dateTo = null) {
    try {
        const params = new URLSearchParams({
            page: page,
            limit: videosPerPage
        });
        
        if (stem) {
            params.append('stem', stem);
            params.append('mode', mode);
        }
        
        if (resolution) {
            params.append('resolution', resolution);
        }
        
        if (fileType && fileType !== 'all') {
            params.append('fileType', fileType);
        }
        
        if (dateFrom) {
            params.append('dateFrom', dateFrom);
        }
        
        if (dateTo) {
            params.append('dateTo', dateTo);
        }
        
        const response = await fetch(`/api/videos?${params.toString()}`);
        const data = await response.json();
        
        displayVideos(data.videos);
        displayPagination(data.pagination);
        updateFilterInfo(stem, data.pagination.totalVideos, mode, resolution, fileType, dateFrom, dateTo);
        
        currentPage = page;
        currentStem = stem;
        currentResolution = resolution;
        currentFileType = fileType;
        currentFilterMode = mode;
        currentDateFrom = dateFrom;
        currentDateTo = dateTo;
    } catch (error) {
        console.error('Error loading videos:', error);
        document.getElementById('videosGrid').innerHTML = 
            '<p class="error">Error loading videos</p>';
    }
}

// Display videos in grid
function displayVideos(videos) {
    const videosGrid = document.getElementById('videosGrid');
    
    if (videos.length === 0) {
        videosGrid.innerHTML = '<p class="loading">No videos found</p>';
        return;
    }
    
    videosGrid.innerHTML = videos.map(video => {
        // Detect resolution if unknown (only for videos)
        if (video.fileType === 'video' && video.resolution === 'Unknown') {
            detectVideoResolution(video.filename);
        }
        
        const isPDF = video.fileType === 'pdf';
        const isImage = video.fileType === 'image';
        let overlayIcon = '▶';
        let overlayClass = 'play-overlay';
        if (isPDF) {
            overlayIcon = '📄';
            overlayClass = 'pdf-overlay';
        }
        // Removed image overlay - images don't show icon on hover
        
        const videoFilename = encodeURIComponent(video.filename);
        const videoUrl = `/api/video/${videoFilename}`;
        
        return `
        <div class="video-card" 
             data-filename="${escapeHtml(video.filename)}"
             data-file-type="${video.fileType}"
             data-video-url="${videoUrl}"
             onclick="navigateToVideo('${videoFilename}')"
             onmouseenter="handleVideoHover(this)"
             onmouseleave="handleVideoLeave(this)">
            <div class="video-thumbnail">
                <img src="${escapeHtml(video.thumbnailPath)}" alt="${escapeHtml(video.displayName)}" 
                     onerror="this.style.display='none'; this.parentElement.classList.add('no-thumbnail');">
                ${!isImage ? `<div class="${overlayClass}">${overlayIcon}</div>` : ''}
                ${video.resolution && video.resolution !== 'Unknown' ? `<div class="video-resolution-badge">${video.resolution}</div>` : ''}
                ${isPDF ? '<div class="file-type-badge">PDF</div>' : ''}
                ${isImage ? '<div class="file-type-badge">Image</div>' : ''}
                <div class="video-preview-container hidden"></div>
            </div>
            <div class="video-info">
                <div class="video-title">${escapeHtml(video.displayName)}</div>
                ${video.resolution && video.resolution !== 'Unknown' ? `<div class="video-resolution-text">${video.resolution}</div>` : ''}
                ${video.date ? `<div class="video-date ${video.dateSource === 'metadata' ? 'date-from-metadata' : 'date-from-file'}">${formatVideoDate(video.date)}</div>` : ''}
                <div class="video-stems">
                    ${video.stems.map(stem => 
                        `<span class="video-stem">${escapeHtml(stem)}</span>`
                    ).join('')}
                </div>
            </div>
        </div>
    `;
    }).join('');
}

// Display pagination controls
function displayPagination(pagination) {
    const paginationDiv = document.getElementById('pagination');
    
    if (pagination.totalPages <= 1) {
        paginationDiv.innerHTML = '';
        return;
    }
    
    const prevDisabled = pagination.currentPage === 1;
    const nextDisabled = pagination.currentPage === pagination.totalPages;
    
    paginationDiv.innerHTML = `
        <button onclick="goToPage(${pagination.currentPage - 1})" ${prevDisabled ? 'disabled' : ''}>
            Previous
        </button>
        <span class="page-info">
            Page ${pagination.currentPage} of ${pagination.totalPages} 
            (${pagination.totalVideos} videos)
        </span>
        <button onclick="goToPage(${pagination.currentPage + 1})" ${nextDisabled ? 'disabled' : ''}>
            Next
        </button>
    `;
}

// Update filter info display
function updateFilterInfo(stem, totalVideos, mode = 'OR', resolution = null, fileType = null, dateFrom = null, dateTo = null) {
    const filterInfo = document.getElementById('filterInfo');
    
    const filters = [];
    
    if (fileType && fileType !== 'all') {
        const fileTypeLabels = {
            'video': 'Videos',
            'pdf': 'PDFs',
            'image': 'Images'
        };
        filters.push(`Type: <strong>${escapeHtml(fileTypeLabels[fileType] || fileType)}</strong>`);
    }
    
    if (resolution) {
        filters.push(`Resolution: <strong>${escapeHtml(resolution)}</strong>`);
    }
    
    if (dateFrom || dateTo) {
        let dateDisplay = 'Date: ';
        if (dateFrom && dateTo) {
            dateDisplay += `<strong>${formatDate(dateFrom)} - ${formatDate(dateTo)}</strong>`;
        } else if (dateFrom) {
            dateDisplay += `<strong>From ${formatDate(dateFrom)}</strong>`;
        } else if (dateTo) {
            dateDisplay += `<strong>Until ${formatDate(dateTo)}</strong>`;
        }
        filters.push(dateDisplay);
    }
    
    if (stem) {
        const stems = stem.split(',').map(s => s.trim());
        const modeDisplay = mode.toUpperCase();
        const stemsDisplay = stems.length > 1 
            ? stems.map(s => `<strong>${escapeHtml(s)}</strong>`).join(` ${modeDisplay} `)
            : `<strong>${escapeHtml(stems[0])}</strong>`;
        filters.push(`Stems: ${stemsDisplay} (${modeDisplay} mode)`);
        
        // Update active stems in sidebar
        document.querySelectorAll('.stem-tag').forEach(tag => {
            if (stems.includes(tag.dataset.stem)) {
                tag.classList.add('active');
            } else {
                tag.classList.remove('active');
            }
        });
    } else {
        document.querySelectorAll('.stem-tag').forEach(tag => {
            tag.classList.remove('active');
        });
    }
    
    // Update active resolution in sidebar
    document.querySelectorAll('[data-resolution]').forEach(tag => {
        if (resolution && tag.dataset.resolution === resolution) {
            tag.classList.add('active');
        } else {
            tag.classList.remove('active');
        }
    });
    
    if (filters.length > 0) {
        filterInfo.classList.remove('hidden');
        filterInfo.innerHTML = `
            <span>Filtered by: ${filters.join(', ')} (${totalVideos} videos)</span>
            <button class="clear-filter" onclick="clearFilter()">Clear Filter</button>
        `;
    } else {
        filterInfo.classList.add('hidden');
    }
}

// Filter videos by multiple stems with mode
function filterByStems(stem, mode = 'OR') {
    currentPage = 1;
    loadVideos(1, stem, mode, currentResolution, currentFileType);
    // Don't auto-update search input - let user type freely
}

// Filter videos by single stem (for backward compatibility with stem tag clicks)
function filterByStem(stem) {
    filterByStems(stem, 'OR');
}

// Clear filter
function clearFilter() {
    currentPage = 1;
    currentStem = null;
    currentResolution = null;
    currentFileType = null;
    currentFilterMode = 'OR';
    currentDateFrom = null;
    currentDateTo = null;
    
    // Reset file type button to "All"
    document.querySelectorAll('.file-type-tag').forEach(btn => {
        btn.classList.remove('active');
    });
    
    // Reset date filter
    filterByDate('all');
    const allButton = document.getElementById('fileType-all');
    if (allButton) {
        allButton.classList.add('active');
    }
    
    loadVideos(1, null, 'OR', null, null);
    document.getElementById('searchInput').value = '';
}

// Go to specific page
function goToPage(page) {
    loadVideos(page, currentStem, currentFilterMode, currentResolution, currentFileType, currentDateFrom, currentDateTo);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Video.js player instance
let videoPlayer = null;

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

// Navigate to video page
// Hover preview functionality
let hoverTimeout = null;
let currentPreviewVideo = null;
let currentPreviewCard = null;

function handleVideoHover(cardElement) {
    // Only show preview for videos
    const fileType = cardElement.getAttribute('data-file-type');
    if (fileType !== 'video') {
        return;
    }
    
    // Clear any existing timeout
    if (hoverTimeout) {
        clearTimeout(hoverTimeout);
    }
    
    // Store reference to current card
    currentPreviewCard = cardElement;
    
    // Wait 500ms before showing preview (avoid accidental triggers)
    hoverTimeout = setTimeout(() => {
        showVideoPreview(cardElement);
    }, 500);
}

function handleVideoLeave(cardElement) {
    // Clear timeout if mouse leaves before delay
    if (hoverTimeout) {
        clearTimeout(hoverTimeout);
        hoverTimeout = null;
    }
    
    // Hide preview
    hideVideoPreview(cardElement);
}

function showVideoPreview(cardElement) {
    // Don't show if this is not the current card
    if (cardElement !== currentPreviewCard) {
        return;
    }
    
    // Double-check it's a video
    const fileType = cardElement.getAttribute('data-file-type');
    if (fileType !== 'video') {
        return;
    }
    
    const videoUrl = cardElement.getAttribute('data-video-url');
    const previewContainer = cardElement.querySelector('.video-preview-container');
    
    if (!previewContainer || !videoUrl) {
        return;
    }
    
    // Hide thumbnail image
    const thumbnailImg = cardElement.querySelector('.video-thumbnail img');
    if (thumbnailImg) {
        thumbnailImg.style.opacity = '0';
    }
    
    // Hide overlay icon
    const overlay = cardElement.querySelector('.play-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
    }
    
    // Show preview container
    previewContainer.classList.remove('hidden');
    
    // Create video element if it doesn't exist
    let previewVideo = previewContainer.querySelector('video');
    if (!previewVideo) {
        previewVideo = document.createElement('video');
        previewVideo.className = 'video-preview-player';
        previewVideo.muted = true;
        previewVideo.loop = true;
        previewVideo.playsInline = true;
        previewVideo.preload = 'metadata';
        previewVideo.setAttribute('playsinline', '');
        previewVideo.setAttribute('webkit-playsinline', '');
        previewContainer.appendChild(previewVideo);
    }
    
    // Only load if video source is different
    const currentSrc = previewVideo.src || previewVideo.getAttribute('src');
    if (currentSrc !== videoUrl) {
        previewVideo.src = videoUrl;
        currentPreviewVideo = previewVideo;
        
        // Play video after it loads
        previewVideo.addEventListener('loadedmetadata', () => {
            if (cardElement === currentPreviewCard) {
                previewVideo.play().catch(err => {
                    // Silently handle autoplay restrictions
                    console.log('Preview autoplay prevented (normal):', err.message);
                });
            }
        }, { once: true });
    } else if (previewVideo.paused) {
        // Resume if already loaded
        previewVideo.play().catch(err => {
            console.log('Preview play error:', err);
        });
    }
}

function hideVideoPreview(cardElement) {
    const previewContainer = cardElement.querySelector('.video-preview-container');
    if (previewContainer) {
        previewContainer.classList.add('hidden');
    }
    
    // Show thumbnail image again
    const thumbnailImg = cardElement.querySelector('.video-thumbnail img');
    if (thumbnailImg) {
        thumbnailImg.style.opacity = '1';
    }
    
    // Show overlay icon again
    const overlay = cardElement.querySelector('.play-overlay');
    if (overlay) {
        overlay.style.opacity = '';
    }
    
    // Pause and cleanup video
    if (currentPreviewVideo) {
        currentPreviewVideo.pause();
        currentPreviewVideo.currentTime = 0;
        // Don't remove the video element, just pause it for reuse
        currentPreviewVideo = null;
    }
    
    currentPreviewCard = null;
}

function navigateToVideo(filename) {
    const encodedFilename = encodeURIComponent(filename);
    
    // Determine file type from filename extension
    const ext = filename.toLowerCase().split('.').pop();
    const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff', 'tif', 'ico'];
    const pdfExtensions = ['pdf'];
    
    if (imageExtensions.includes(ext)) {
        window.location.href = `/image/${encodedFilename}`;
    } else if (pdfExtensions.includes(ext)) {
        window.location.href = `/pdf/${encodedFilename}`;
    } else {
        // Default to video page
        window.location.href = `/video/${encodedFilename}`;
    }
}

// Play video in modal (kept for backward compatibility if needed)
function playVideo(fullPath) {
    // Decode the path
    const decodedPath = decodeURIComponent(fullPath);
    console.log('Playing video:', decodedPath);
    
    // Show modal first
    const modal = document.getElementById('videoModal');
    modal.classList.remove('hidden');
    
    // Prevent body scroll when modal is open
    document.body.style.overflow = 'hidden';
    
    // Initialize player if needed
    const player = initVideoPlayer();
    if (!player) {
        console.error('Failed to initialize video player');
        return;
    }
    
    // Detect video type from file extension
    const videoType = getVideoType(decodedPath);
    console.log('Video type:', videoType);
    
    // Reset player
    player.pause();
    player.currentTime(0);
    
    // Set video source
    player.src({
        type: videoType,
        src: decodedPath
    });
    
    // Load and play the video
    player.load();
    
    // Wait for the video to be ready and then play
    const playPromise = player.play();
    if (playPromise !== undefined) {
        playPromise.catch(err => {
            console.error('Error playing video:', err);
            // User interaction might be required - show play button instead
        });
    }
    
    // Add error handler
    const errorHandler = () => {
        const error = player.error();
        if (error) {
            console.error('Video.js error:', error);
            let errorMsg = 'Error loading video';
            if (error.code === 4) {
                errorMsg = 'Video format not supported or file not found';
            } else if (error.message) {
                errorMsg = error.message;
            }
            alert(errorMsg);
            player.off('error', errorHandler);
        }
    };
    player.on('error', errorHandler);
}

// Close video modal
function closeVideoModal() {
    const modal = document.getElementById('videoModal');
    modal.classList.add('hidden');
    
    // Pause and reset video
    if (videoPlayer) {
        videoPlayer.pause();
        videoPlayer.currentTime(0);
    }
    
    // Restore body scroll
    document.body.style.overflow = '';
}

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const modal = document.getElementById('videoModal');
        if (!modal.classList.contains('hidden')) {
            closeVideoModal();
        }
    }
});

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Date filter functions
async function loadDateRange() {
    try {
        const response = await fetch('/api/date-range');
        const data = await response.json();
        dateRange = data;
    } catch (error) {
        console.error('Error loading date range:', error);
    }
}

async function loadDateCounts() {
    try {
        const response = await fetch('/api/date-counts');
        const data = await response.json();
        if (data.dateCounts) {
            dateCounts = data.dateCounts;
            buildDateTree();
        }
    } catch (error) {
        console.error('Error loading date counts:', error);
    }
}

// Build hierarchical date tree from date counts
function buildDateTree() {
    const dateTreeContainer = document.getElementById('dateTree');
    if (!dateTreeContainer) return;
    
    if (Object.keys(dateCounts).length === 0) {
        dateTreeContainer.innerHTML = '<p class="no-data">No date data available</p>';
        return;
    }
    
    // Organize dates into year > month > day structure
    const tree = {};
    
    for (const [dateStr, count] of Object.entries(dateCounts)) {
        const date = new Date(dateStr + 'T00:00:00');
        const year = date.getFullYear();
        const month = date.getMonth(); // 0-11
        const day = date.getDate();
        
        if (!tree[year]) {
            tree[year] = {};
        }
        if (!tree[year][month]) {
            tree[year][month] = {};
        }
        tree[year][month][day] = count;
    }
    
    // Calculate totals for months and years
    const monthTotals = {};
    const yearTotals = {};
    
    for (const [year, months] of Object.entries(tree)) {
        yearTotals[year] = 0;
        for (const [month, days] of Object.entries(months)) {
            const monthKey = `${year}-${month}`;
            monthTotals[monthKey] = 0;
            for (const [day, count] of Object.entries(days)) {
                monthTotals[monthKey] += count;
                yearTotals[year] += count;
            }
        }
    }
    
    // Sort years descending (newest first)
    const sortedYears = Object.keys(tree).sort((a, b) => parseInt(b) - parseInt(a));
    
    // Month names
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                       'July', 'August', 'September', 'October', 'November', 'December'];
    
    let html = '<ul class="date-tree-list">';
    
    for (const year of sortedYears) {
        const yearCount = yearTotals[year];
        html += `<li class="date-tree-year">
            <span class="date-tree-toggle" onclick="toggleDateTreeItem(this, event)">▶</span>
            <span class="date-tree-label" onclick="toggleOrFilterDateTree(this, '${year}', null, null, event)">${year}</span>
            <span class="date-tree-count">(${yearCount})</span>
        </li>`;
        
        // Sort months descending (newest first)
        const sortedMonths = Object.keys(tree[year]).sort((a, b) => parseInt(b) - parseInt(a));
        
        html += '<ul class="date-tree-month-list" style="display: none;">';
        for (const month of sortedMonths) {
            const monthKey = `${year}-${month}`;
            const monthCount = monthTotals[monthKey];
            const monthName = monthNames[parseInt(month)];
            html += `<li class="date-tree-month">
                <span class="date-tree-toggle" onclick="toggleDateTreeItem(this, event)">▶</span>
                <span class="date-tree-label" onclick="toggleOrFilterDateTree(this, '${year}', '${month}', null, event)">${monthName}</span>
                <span class="date-tree-count">(${monthCount})</span>
            </li>`;
            
            // Sort days descending (newest first)
            const sortedDays = Object.keys(tree[year][month]).sort((a, b) => parseInt(b) - parseInt(a));
            
            html += '<ul class="date-tree-day-list" style="display: none;">';
            for (const day of sortedDays) {
                const dayCount = tree[year][month][day];
                html += `<li class="date-tree-day">
                    <span class="date-tree-label" onclick="filterByDateTree('${year}', '${month}', '${day}')">${day}</span>
                    <span class="date-tree-count">(${dayCount})</span>
                </li>`;
            }
            html += '</ul>';
        }
        html += '</ul>';
    }
    
    html += '</ul>';
    dateTreeContainer.innerHTML = html;
}

// Toggle date tree item (expand/collapse)
function toggleDateTreeItem(element, event) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    
    const listItem = element.closest('li');
    if (!listItem) {
        return;
    }
    
    // The nested list is the next sibling UL element (not a child)
    let nestedList = listItem.nextElementSibling;
    
    // Make sure it's a UL element
    if (!nestedList || nestedList.tagName !== 'UL') {
        // Fallback: try to find it as a child (shouldn't happen with our structure)
        nestedList = listItem.querySelector('ul');
    }
    
    if (nestedList) {
        // Check if currently expanded by looking at inline style first, then computed style
        const inlineDisplay = nestedList.style.display;
        const computedDisplay = window.getComputedStyle(nestedList).display;
        const currentDisplay = inlineDisplay || computedDisplay;
        const isExpanded = currentDisplay !== 'none' && currentDisplay !== '';
        
        if (isExpanded) {
            // Collapse
            nestedList.style.display = 'none';
            element.textContent = '▶';
        } else {
            // Expand
            nestedList.style.display = 'block';
            element.textContent = '▼';
        }
    }
}

// Toggle date tree item and optionally filter
function toggleOrFilterDateTree(element, year, month, day, event) {
    if (event) {
        event.stopPropagation();
    }
    
    const listItem = element.closest('li');
    if (!listItem) {
        return;
    }
    
    // The nested list is the next sibling UL element (not a child)
    let nestedList = listItem.nextElementSibling;
    
    // Make sure it's a UL element
    if (!nestedList || nestedList.tagName !== 'UL') {
        // Fallback: try to find it as a child (shouldn't happen with our structure)
        nestedList = listItem.querySelector('ul');
    }
    
    const toggle = listItem.querySelector('.date-tree-toggle');
    
    if (nestedList) {
        // Check if currently expanded by looking at inline style first, then computed style
        const inlineDisplay = nestedList.style.display;
        const computedDisplay = window.getComputedStyle(nestedList).display;
        const currentDisplay = inlineDisplay || computedDisplay;
        const isExpanded = currentDisplay !== 'none' && currentDisplay !== '';
        
        if (!isExpanded) {
            // Expand first
            nestedList.style.display = 'block';
            if (toggle) {
                toggle.textContent = '▼';
            }
        } else {
            // Already expanded, so filter
            filterByDateTree(year, month, day);
        }
    } else {
        // No nested list (day level), just filter
        filterByDateTree(year, month, day);
    }
}

// Filter by date tree selection
function filterByDateTree(year, month, day) {
    let dateFrom = null;
    let dateTo = null;
    
    if (day !== null && month !== null) {
        // Specific day selected
        const date = new Date(parseInt(year), parseInt(month), parseInt(day));
        dateFrom = date.toISOString().split('T')[0] + 'T00:00:00.000Z';
        dateTo = date.toISOString().split('T')[0] + 'T23:59:59.999Z';
    } else if (month !== null) {
        // Month selected
        const startDate = new Date(parseInt(year), parseInt(month), 1);
        const endDate = new Date(parseInt(year), parseInt(month) + 1, 0); // Last day of month
        dateFrom = startDate.toISOString().split('T')[0] + 'T00:00:00.000Z';
        dateTo = endDate.toISOString().split('T')[0] + 'T23:59:59.999Z';
    } else if (year !== null) {
        // Year selected
        const startDate = new Date(parseInt(year), 0, 1);
        const endDate = new Date(parseInt(year), 11, 31);
        dateFrom = startDate.toISOString().split('T')[0] + 'T00:00:00.000Z';
        dateTo = endDate.toISOString().split('T')[0] + 'T23:59:59.999Z';
    }
    
    currentDateFrom = dateFrom;
    currentDateTo = dateTo;
    currentPage = 1;
    
    // Update button states
    document.querySelectorAll('.date-filter-tag').forEach(btn => {
        btn.classList.remove('active');
    });
    const customButton = document.getElementById('dateFilter-custom');
    if (customButton) {
        customButton.classList.add('active');
    }
    
    // Clear date picker if it exists
    if (dateRangePicker) {
        dateRangePicker.clear();
    }
    
    // Load videos with date filter
    loadVideos(1, currentStem, currentFilterMode, currentResolution, currentFileType, dateFrom, dateTo);
}

function filterByDate(filterType) {
    if (filterType === 'all') {
        currentDateFrom = null;
        currentDateTo = null;
        currentPage = 1;
        
        // Update button states
        document.querySelectorAll('.date-filter-tag').forEach(btn => {
            btn.classList.remove('active');
        });
        const allButton = document.getElementById('dateFilter-all');
        if (allButton) {
            allButton.classList.add('active');
        }
        
        // Hide date inputs
        const dateInputs = document.getElementById('dateRangeInputs');
        if (dateInputs) {
            dateInputs.style.display = 'none';
        }
        
        // Clear date picker
        if (dateRangePicker) {
            dateRangePicker.clear();
        }
        
        loadVideos(1, currentStem, currentFilterMode, currentResolution, currentFileType, null, null);
    } else if (filterType === 'custom') {
        // Show date inputs
        const dateInputs = document.getElementById('dateRangeInputs');
        if (dateInputs) {
            dateInputs.style.display = 'block';
        }
        
        // Update button states
        document.querySelectorAll('.date-filter-tag').forEach(btn => {
            btn.classList.remove('active');
        });
        const customButton = document.getElementById('dateFilter-custom');
        if (customButton) {
            customButton.classList.add('active');
        }
        
        // Initialize date range picker after a short delay to ensure element is visible
        setTimeout(() => {
            initializeDateRangePicker();
        }, 50);
    }
}

function showDateRangeInputs() {
    filterByDate('custom');
}

function initializeDateRangePicker() {
    const pickerElement = document.getElementById('dateRangePicker');
    if (!pickerElement) {
        console.error('Date range picker element not found');
        return;
    }
    
    // Destroy existing instance if it exists
    if (dateRangePicker) {
        dateRangePicker.destroy();
        dateRangePicker = null;
    }
    
    // Check if flatpickr is available
    if (typeof flatpickr === 'undefined') {
        console.error('Flatpickr library not loaded. Please ensure the script is included in index.html');
        alert('Date picker library not loaded. Please refresh the page.');
        return;
    }
    
    const options = {
        mode: 'range',
        dateFormat: 'Y-m-d',
        minDate: dateRange.minDate ? new Date(dateRange.minDate) : undefined,
        maxDate: dateRange.maxDate ? new Date(dateRange.maxDate) : undefined,
        allowInput: false,
        clickOpens: true,
        onChange: function(selectedDates, dateStr, instance) {
            // Automatically apply filter when dates are selected
            if (selectedDates.length === 2) {
                // Range selected - apply filter
                const start = selectedDates[0] < selectedDates[1] ? selectedDates[0] : selectedDates[1];
                const end = selectedDates[0] > selectedDates[1] ? selectedDates[0] : selectedDates[1];
                const dateFrom = start.toISOString().split('T')[0] + 'T00:00:00.000Z';
                const dateTo = end.toISOString().split('T')[0] + 'T23:59:59.999Z';
                
                currentDateFrom = dateFrom;
                currentDateTo = dateTo;
                currentPage = 1;
                
                // Update button states
                document.querySelectorAll('.date-filter-tag').forEach(btn => {
                    btn.classList.remove('active');
                });
                const customButton = document.getElementById('dateFilter-custom');
                if (customButton) {
                    customButton.classList.add('active');
                }
                
                // Load videos with date filter
                loadVideos(1, currentStem, currentFilterMode, currentResolution, currentFileType, dateFrom, dateTo);
            } else if (selectedDates.length === 1) {
                // Single date selected - use as both start and end
                const date = selectedDates[0];
                const dateFrom = date.toISOString().split('T')[0] + 'T00:00:00.000Z';
                const dateTo = date.toISOString().split('T')[0] + 'T23:59:59.999Z';
                
                currentDateFrom = dateFrom;
                currentDateTo = dateTo;
                currentPage = 1;
                
                // Update button states
                document.querySelectorAll('.date-filter-tag').forEach(btn => {
                    btn.classList.remove('active');
                });
                const customButton = document.getElementById('dateFilter-custom');
                if (customButton) {
                    customButton.classList.add('active');
                }
                
                // Load videos with date filter
                loadVideos(1, currentStem, currentFilterMode, currentResolution, currentFileType, dateFrom, dateTo);
            } else if (selectedDates.length === 0) {
                // Dates cleared - clear filter
                clearDateFilter();
            }
        },
        onReady: function(selectedDates, dateStr, instance) {
            // Customize day cells to show file counts
            setTimeout(() => {
                updateDatePickerDayCounts(instance);
            }, 100);
        },
        onOpen: function(selectedDates, dateStr, instance) {
            // Update counts when calendar opens
            setTimeout(() => {
                updateDatePickerDayCounts(instance);
            }, 100);
        },
        onMonthChange: function(selectedDates, dateStr, instance) {
            // Update counts when month changes
            setTimeout(() => {
                updateDatePickerDayCounts(instance);
            }, 100);
        },
        onYearChange: function(selectedDates, dateStr, instance) {
            // Update counts when year changes
            setTimeout(() => {
                updateDatePickerDayCounts(instance);
            }, 100);
        }
    };
    
    try {
        dateRangePicker = flatpickr(pickerElement, options);
        console.log('Date range picker initialized');
    } catch (error) {
        console.error('Error initializing date range picker:', error);
    }
}

function updateDatePickerDayCounts(instance) {
    if (!instance || !instance.calendarContainer) return;
    
    const dayElements = instance.calendarContainer.querySelectorAll('.flatpickr-day:not(.flatpickr-disabled)');
    const currentMonth = instance.currentMonth;
    const currentYear = instance.currentYear;
    
    dayElements.forEach(dayElement => {
        const dayNum = parseInt(dayElement.textContent);
        if (isNaN(dayNum)) return;
        
        // Construct date from current month/year and day
        const date = new Date(currentYear, currentMonth, dayNum);
        const dateKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
        const count = dateCounts[dateKey] || 0;
        
        // Remove existing count badge
        const existingBadge = dayElement.querySelector('.date-count-badge');
        if (existingBadge) {
            existingBadge.remove();
        }
        
        // Remove has-files class
        dayElement.classList.remove('has-files');
        
        // Add count badge if there are files on this date
        if (count > 0) {
            const badge = document.createElement('span');
            badge.className = 'date-count-badge';
            badge.textContent = count;
            badge.title = `${count} file${count !== 1 ? 's' : ''} on this date`;
            dayElement.appendChild(badge);
            
            // Add class to indicate files exist
            dayElement.classList.add('has-files');
        }
    });
}

function applyDateFilter() {
    if (!dateRangePicker) {
        alert('Please select a date range first');
        return;
    }
    
    const selectedDates = dateRangePicker.selectedDates;
    
    if (selectedDates.length === 0) {
        alert('Please select a date range');
        return;
    }
    
    let dateFrom = null;
    let dateTo = null;
    
    if (selectedDates.length === 1) {
        // Single date selected - use as both start and end
        const date = selectedDates[0];
        dateFrom = date.toISOString().split('T')[0] + 'T00:00:00.000Z';
        dateTo = date.toISOString().split('T')[0] + 'T23:59:59.999Z';
    } else if (selectedDates.length === 2) {
        // Range selected
        const start = selectedDates[0] < selectedDates[1] ? selectedDates[0] : selectedDates[1];
        const end = selectedDates[0] > selectedDates[1] ? selectedDates[0] : selectedDates[1];
        dateFrom = start.toISOString().split('T')[0] + 'T00:00:00.000Z';
        dateTo = end.toISOString().split('T')[0] + 'T23:59:59.999Z';
    }
    
    currentDateFrom = dateFrom;
    currentDateTo = dateTo;
    currentPage = 1;
    
    loadVideos(1, currentStem, currentFilterMode, currentResolution, currentFileType, dateFrom, dateTo);
}

function clearDateFilter() {
    if (dateRangePicker) {
        dateRangePicker.clear();
    }
    
    filterByDate('all');
}

function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatVideoDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

