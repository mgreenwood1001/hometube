// Get PDF filename from URL
function getPdfFilenameFromURL() {
    const pathname = window.location.pathname;
    const pdfPrefix = '/pdf/';
    if (pathname.startsWith(pdfPrefix)) {
        const filename = pathname.substring(pdfPrefix.length);
        return decodeURIComponent(filename);
    }
    return null;
}

// Load PDF and related PDFs
async function loadPdfPage() {
    console.log('loadPdfPage called');
    
    const filename = getPdfFilenameFromURL();
    console.log('Extracted filename from URL:', filename);
    
    if (!filename) {
        showError('PDF not found - invalid URL. Please check the URL and try again.');
        return;
    }
    
    // Show loading state
    const loadingMessage = document.getElementById('loadingMessage');
    const mainContent = document.getElementById('pdfMainContent');
    if (loadingMessage) loadingMessage.style.display = 'block';
    if (mainContent) mainContent.style.display = 'none';
    
    const relatedPdfsList = document.getElementById('relatedPdfsList');
    if (relatedPdfsList) {
        relatedPdfsList.innerHTML = '<p class="loading">Loading PDF information...</p>';
    }
    
    try {
        const apiUrl = `/api/video-info/${encodeURIComponent(filename)}`;
        console.log('Fetching PDF info from:', apiUrl);
        
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            },
            credentials: 'include'
        });
        
        if (!response.ok) {
            let errorMessage = `HTTP ${response.status}: Failed to load PDF`;
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || errorMessage;
            } catch (e) {
                // Ignore
            }
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        const { video: pdf, relatedVideos: relatedPdfs } = data;
        
        if (!pdf) {
            throw new Error('PDF data not found in response');
        }
        
        // Hide loading message and show content
        if (loadingMessage) loadingMessage.style.display = 'none';
        if (mainContent) {
            mainContent.style.display = 'grid';
            mainContent.style.visibility = 'visible';
        }
        
        // Set page title
        const systemName = document.getElementById('systemName')?.textContent || 'HomeTube';
        document.title = `${pdf.displayName} - ${systemName}`;
        
        // Display PDF info
        const titleElement = document.getElementById('pdfTitle');
        if (titleElement) {
            titleElement.textContent = pdf.displayName;
        }
        
        const viewsElement = document.getElementById('pdfViews');
        if (viewsElement) {
            viewsElement.textContent = 'PDF Document';
        }
        
        const stemsContainer = document.getElementById('pdfStems');
        if (stemsContainer) {
            if (pdf.stems && pdf.stems.length > 0) {
                stemsContainer.innerHTML = pdf.stems.map(stem => 
                    `<span class="video-stem-large" onclick="searchByStem('${escapeHtml(stem)}')">${escapeHtml(stem)}</span>`
                ).join('');
            } else {
                stemsContainer.innerHTML = '<p style="color: #aaaaaa; font-size: 0.9rem;">No tags available</p>';
            }
        }
        
        // Display PDF
        const pdfViewer = document.getElementById('pdfViewer');
        const pdfViewerContainer = document.getElementById('pdfViewerContainer');
        const pdfDownloadLink = document.getElementById('pdfDownloadLink');
        const pdfOpenLink = document.getElementById('pdfOpenLink');
        
        if (pdfViewer) {
            // Set up download and open links
            if (pdfDownloadLink) {
                pdfDownloadLink.href = pdf.fullPath;
                pdfDownloadLink.download = pdf.displayName;
            }
            if (pdfOpenLink) {
                pdfOpenLink.href = pdf.fullPath;
            }
            
            // Use a timeout to catch Firefox-specific errors
            let loadTimeout;
            let errorCaught = false;
            
            // Add error handler for iframe (though iframe onerror may not fire for PDFs)
            pdfViewer.onerror = function() {
                if (!errorCaught) {
                    errorCaught = true;
                    clearTimeout(loadTimeout);
                    console.error('Error loading PDF in iframe');
                    // Don't show error immediately - PDF might still load
                }
            };
            
            // Add load handler
            pdfViewer.onload = function() {
                clearTimeout(loadTimeout);
                console.log('PDF iframe load event fired');
                // PDF should be loading now
            };
            
            // Set PDF source with a small delay to avoid Firefox issues
            setTimeout(() => {
                try {
                    pdfViewer.src = pdf.fullPath;
                    
                    // Set a timeout to check if PDF loaded (Firefox may not fire onerror)
                    loadTimeout = setTimeout(() => {
                        // Check if iframe has content (may fail due to CORS, which is okay)
                        try {
                            const iframeDoc = pdfViewer.contentDocument || pdfViewer.contentWindow?.document;
                            if (!iframeDoc && !errorCaught) {
                                console.warn('PDF may not have loaded - iframe document not accessible');
                            }
                        } catch (e) {
                            // CORS error is expected and normal - PDF should still display
                            console.log('PDF iframe loaded (CORS prevents access, which is normal)');
                        }
                    }, 2000);
                } catch (e) {
                    console.error('Error setting PDF source:', e);
                    if (!errorCaught) {
                        showPdfError(pdf.fullPath, pdf.displayName);
                    }
                }
            }, 100);
        }
        
        // Display related PDFs
        displayRelatedPdfs(relatedPdfs || []);
        
    } catch (error) {
        console.error('Error loading PDF:', error);
        
        if (loadingMessage) loadingMessage.style.display = 'none';
        if (mainContent) mainContent.style.display = 'none';
        
        showError(`Error loading PDF: ${error.message}`);
        
        if (relatedPdfsList) {
            relatedPdfsList.innerHTML = '<p class="error" style="color: #ff4444; padding: 1rem;">Failed to load related PDFs</p>';
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

// Show PDF error with fallback download link
function showPdfError(pdfPath, pdfName) {
    const pdfViewerContainer = document.getElementById('pdfViewerContainer');
    if (!pdfViewerContainer) return;
    
    const errorDiv = document.createElement('div');
    errorDiv.className = 'pdf-error-fallback';
    errorDiv.style.cssText = 'padding: 2rem; text-align: center; color: #ffaa00; background-color: #1a1a1a; border: 1px solid #ffaa00; border-radius: 8px; margin: 1rem;';
    errorDiv.innerHTML = `
        <h3 style="color: #ffaa00; margin-bottom: 1rem;">PDF Viewer Error</h3>
        <p style="margin-bottom: 1rem;">The PDF viewer encountered an error. You can download the PDF to view it directly.</p>
        <a href="${escapeHtml(pdfPath)}" download="${escapeHtml(pdfName)}" 
           style="display: inline-block; padding: 0.75rem 1.5rem; background-color: #3ea6ff; color: white; text-decoration: none; border-radius: 4px; font-weight: 500;">
            Download PDF
        </a>
        <p style="margin-top: 1rem; font-size: 0.9rem; color: #aaaaaa;">
            Or try opening in a new tab: 
            <a href="${escapeHtml(pdfPath)}" target="_blank" style="color: #3ea6ff;">Open PDF</a>
        </p>
    `;
    
    pdfViewerContainer.appendChild(errorDiv);
}

// Display related PDFs
function displayRelatedPdfs(pdfs) {
    const container = document.getElementById('relatedPdfsList');
    
    if (pdfs.length === 0) {
        container.innerHTML = '<p class="loading">No related PDFs found</p>';
        return;
    }
    
    container.innerHTML = pdfs.map(pdf => `
        <div class="related-video-item" onclick="navigateToPdf('${encodeURIComponent(pdf.filename)}')">
            <div class="related-video-thumbnail">
                <img src="${escapeHtml(pdf.thumbnailPath)}" alt="${escapeHtml(pdf.displayName)}"
                     onerror="this.style.display='none'; this.parentElement.classList.add('no-thumbnail');">
                <div class="play-overlay-small">📄</div>
            </div>
            <div class="related-video-info">
                <div class="related-video-title">${escapeHtml(pdf.displayName)}</div>
                <div class="related-video-channel">${document.getElementById('systemName')?.textContent || 'HomeTube'}</div>
                <div class="related-video-meta">Related PDF</div>
            </div>
        </div>
    `).join('');
}

// Navigate to file page (make it global, uses smart routing like app.js)
window.navigateToPdf = function(filename) {
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

// Initialize page
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadPdfPage);
} else {
    loadPdfPage();
}

