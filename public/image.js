// Get image filename from URL
function getImageFilenameFromURL() {
    const pathname = window.location.pathname;
    const imagePrefix = '/image/';
    if (pathname.startsWith(imagePrefix)) {
        const filename = pathname.substring(imagePrefix.length);
        return decodeURIComponent(filename);
    }
    return null;
}

// Load image and related images
async function loadImagePage() {
    console.log('loadImagePage called');
    
    const filename = getImageFilenameFromURL();
    console.log('Extracted filename from URL:', filename);
    
    if (!filename) {
        showError('Image not found - invalid URL. Please check the URL and try again.');
        return;
    }
    
    // Show loading state
    const loadingMessage = document.getElementById('loadingMessage');
    const mainContent = document.getElementById('imageMainContent');
    if (loadingMessage) loadingMessage.style.display = 'block';
    if (mainContent) mainContent.style.display = 'none';
    
    const relatedImagesList = document.getElementById('relatedImagesList');
    if (relatedImagesList) {
        relatedImagesList.innerHTML = '<p class="loading">Loading image information...</p>';
    }
    
    try {
        const apiUrl = `/api/video-info/${encodeURIComponent(filename)}`;
        console.log('Fetching image info from:', apiUrl);
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}: Failed to load image`;
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || errorMessage;
            } catch (e) {
                // Ignore
            }
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        const { video: image, relatedVideos: relatedImages } = data;
        
        if (!image) {
            throw new Error('Image data not found in response');
        }
        
        // Hide loading message and show content
        if (loadingMessage) loadingMessage.style.display = 'none';
        if (mainContent) {
            mainContent.style.display = 'grid';
            mainContent.style.visibility = 'visible';
        }
        
        // Set page title
        const systemName = document.getElementById('systemName')?.textContent || 'HomeTube';
        document.title = `${image.displayName} - ${systemName}`;
        
        // Display image info
        const titleElement = document.getElementById('imageTitle');
        if (titleElement) {
            titleElement.textContent = image.displayName;
        }
        
        const viewsElement = document.getElementById('imageViews');
        if (viewsElement) {
            viewsElement.textContent = 'Image';
        }
        
        const stemsContainer = document.getElementById('imageStems');
        if (stemsContainer) {
            if (image.stems && image.stems.length > 0) {
                stemsContainer.innerHTML = image.stems.map(stem => 
                    `<span class="video-stem-large" onclick="searchByStem('${escapeHtml(stem)}')">${escapeHtml(stem)}</span>`
                ).join('');
            } else {
                stemsContainer.innerHTML = '<p style="color: #aaaaaa; font-size: 0.9rem;">No tags available</p>';
            }
        }
        
        // Display image
        const imageViewer = document.getElementById('imageViewer');
        const imageContainer = document.getElementById('imageViewerContainer');
        if (imageViewer) {
            imageViewer.src = image.fullPath;
            imageViewer.alt = image.displayName;
            // Add click handler for fullscreen
            imageViewer.onclick = toggleImageFullscreen;
            
            // Remove aspect-ratio constraint for images (they can have any aspect ratio)
            if (imageContainer) {
                imageContainer.style.aspectRatio = 'auto';
                imageContainer.style.minHeight = '400px';
            }
            
            // Adjust container height based on image when loaded
            imageViewer.onload = function() {
                if (imageContainer && !document.fullscreenElement) {
                    // Set container to match image aspect ratio, but with max height
                    const maxHeight = window.innerHeight * 0.7;
                    const naturalAspectRatio = this.naturalWidth / this.naturalHeight;
                    const containerWidth = imageContainer.offsetWidth;
                    const calculatedHeight = containerWidth / naturalAspectRatio;
                    const finalHeight = Math.min(calculatedHeight, maxHeight);
                    imageContainer.style.height = `${finalHeight}px`;
                }
            };
        }
        
        // Display related images
        displayRelatedImages(relatedImages || []);
        
    } catch (error) {
        console.error('Error loading image:', error);
        
        if (loadingMessage) loadingMessage.style.display = 'none';
        if (mainContent) mainContent.style.display = 'none';
        
        showError(`Error loading image: ${error.message}`);
        
        if (relatedImagesList) {
            relatedImagesList.innerHTML = '<p class="error" style="color: #ff4444; padding: 1rem;">Failed to load related images</p>';
        }
    }
}

// Show error message
function showError(message) {
    const container = document.querySelector('.video-page-container') || document.body;
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.style.cssText = 'padding: 2rem; text-align: center; color: #ff4444; background-color: #1a1a1a; border: 1px solid #ff4444; border-radius: 8px; margin: 1rem;';
    errorDiv.innerHTML = `<h2>Error</h2><p>${escapeHtml(message)}</p>`;
    
    if (container.querySelector('.video-main-content')) {
        container.insertBefore(errorDiv, container.querySelector('.video-main-content'));
    } else {
        container.innerHTML = '';
        container.appendChild(errorDiv);
    }
}

// Display related images
function displayRelatedImages(images) {
    const container = document.getElementById('relatedImagesList');
    
    if (images.length === 0) {
        container.innerHTML = '<p class="loading">No related images found</p>';
        return;
    }
    
    container.innerHTML = images.map(image => {
        const ext = image.filename.toLowerCase().split('.').pop();
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'].includes(ext);
        const overlayIcon = isImage ? '🖼️' : '▶';
        
        return `
        <div class="related-video-item" onclick="navigateToImage('${encodeURIComponent(image.filename)}')">
            <div class="related-video-thumbnail">
                <img src="${escapeHtml(image.thumbnailPath)}" alt="${escapeHtml(image.displayName)}"
                     onerror="this.style.display='none'; this.parentElement.classList.add('no-thumbnail');">
                <div class="play-overlay-small">${overlayIcon}</div>
            </div>
            <div class="related-video-info">
                <div class="related-video-title">${escapeHtml(image.displayName)}</div>
                <div class="related-video-channel">${document.getElementById('systemName')?.textContent || 'HomeTube'}</div>
                <div class="related-video-meta">Related image</div>
            </div>
        </div>
        `;
    }).join('');
}

// Navigate to file page (make it global, uses smart routing like app.js)
window.navigateToImage = function(filename) {
    const encodedFilename = encodeURIComponent(filename);
    
    // Determine file type from filename extension (same logic as app.js)
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
};

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

// Toggle fullscreen for image
function toggleImageFullscreen() {
    const imageViewer = document.getElementById('imageViewer');
    const container = document.getElementById('imageViewerContainer');
    
    if (!imageViewer) return;
    
    // Check if currently in fullscreen
    if (!document.fullscreenElement && !document.webkitFullscreenElement && 
        !document.mozFullScreenElement && !document.msFullscreenElement) {
        // Enter fullscreen
        const elementToFullscreen = imageViewer;
        
        if (elementToFullscreen.requestFullscreen) {
            elementToFullscreen.requestFullscreen();
        } else if (elementToFullscreen.webkitRequestFullscreen) {
            elementToFullscreen.webkitRequestFullscreen();
        } else if (elementToFullscreen.mozRequestFullScreen) {
            elementToFullscreen.mozRequestFullScreen();
        } else if (elementToFullscreen.msRequestFullscreen) {
            elementToFullscreen.msRequestFullscreen();
        }
    } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
}

// Make function global
window.toggleImageFullscreen = toggleImageFullscreen;

// Update fullscreen button icon when fullscreen state changes
document.addEventListener('fullscreenchange', updateFullscreenIcon);
document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);
document.addEventListener('mozfullscreenchange', updateFullscreenIcon);
document.addEventListener('MSFullscreenChange', updateFullscreenIcon);

function updateFullscreenIcon() {
    const fullscreenButton = document.getElementById('fullscreenButton');
    const icon = fullscreenButton?.querySelector('.fullscreen-icon');
    
    if (!icon) return;
    
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || 
                           document.mozFullScreenElement || document.msFullscreenElement);
    
    if (isFullscreen) {
        icon.textContent = '⛶'; // Exit fullscreen icon (same icon, but tooltip changes)
        fullscreenButton.title = 'Exit Fullscreen (ESC)';
        fullscreenButton.style.opacity = '0.9';
    } else {
        icon.textContent = '⛶'; // Enter fullscreen icon
        fullscreenButton.title = 'Enter Fullscreen';
        fullscreenButton.style.opacity = '1';
    }
}

// Add keyboard support for ESC to exit fullscreen
document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || 
                               document.mozFullScreenElement || document.msFullscreenElement);
        if (isFullscreen) {
            toggleImageFullscreen();
        }
    }
});

// Initialize page
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadImagePage);
} else {
    loadImagePage();
}

